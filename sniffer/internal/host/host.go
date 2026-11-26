// Package host translates official CLI event envelopes to Sniffer's small,
// host-neutral event. It does not read credentials, transcripts, or memory files.
package host

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"unicode/utf8"
)

const MaxEventBytes = 1 << 20
const MaxContextBytes = 24 * 1024

// Event is an observation from one main conversation. Cancel cancels its current
// retrieval; it never means that the launcher or memory worker should exit.
type Event struct {
	Host           string   `json:"host"`
	ConversationID string   `json:"conversation_id"`
	ProjectID      string   `json:"project_id,omitempty"`
	TurnID         string   `json:"turn_id,omitempty"`
	EventID        string   `json:"event_id,omitempty"`
	Name           string   `json:"name"`
	Query          string   `json:"query,omitempty"`
	Context        string   `json:"context,omitempty"`
	WorkspacePaths []string `json:"workspace_paths,omitempty"`
	EpochReset     bool     `json:"epoch_reset,omitempty"`
	Cancel         bool     `json:"cancel,omitempty"`
}

func Canonical(name string) (string, error) {
	switch strings.ToLower(name) {
	case "claude", "claude-code":
		return "claude", nil
	case "codex":
		return "codex", nil
	case "agy", "antigravity":
		return "agy", nil
	default:
		return "", fmt.Errorf("unsupported host %q", name)
	}
}

// Decode tolerates new host fields but rejects malformed or multiple JSON values.
// Event IDs remain empty when the host does not supply one: inventing an ID from
// prompt text would incorrectly merge two distinct submissions of the same text.
func Decode(host string, raw []byte) (Event, error) {
	h, err := Canonical(host)
	if err != nil {
		return Event{}, err
	}
	if len(raw) == 0 || len(raw) > MaxEventBytes {
		return Event{}, errors.New("event must be 1 byte to 1 MiB")
	}
	var m map[string]json.RawMessage
	dec := json.NewDecoder(bytes.NewReader(raw))
	if err := dec.Decode(&m); err != nil || m == nil {
		return Event{}, errors.New("event must be a JSON object")
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		return Event{}, errors.New("event has trailing JSON or data")
	}
	e := Event{Host: h}
	switch h {
	case "claude":
		e.Name = field(m, "event", "hook_event_name")
		e.ConversationID = field(m, "session_id")
		e.ProjectID = field(m, "project_id")
		e.TurnID = field(m, "turn_id")
		e.EventID = field(m, "event_id")
		e.Query = field(m, "query", "prompt")
		e.Context = field(m, "context")
		e.EpochReset = boolean(m, "epoch_reset")
		e.Cancel = boolean(m, "cancel")
		if p := field(m, "cwd"); p != "" {
			e.WorkspacePaths = []string{p}
		}
		switch e.Name {
		case "prompt.submit", "UserPromptSubmit", "tool.call", "tool.complete":
		case "session.compact", "SessionStart":
			if field(m, "source") == "compact" {
				e.EpochReset = true
			}
			e.Query = ""
			e.Context = ""
		case "turn.complete", "session.end", "Stop", "Interrupt", "SessionEnd":
			e.Query = ""
			e.Context = ""
			e.Cancel = true
		case "session.start", "turn.start":
			e.Query = ""
		default:
			return Event{}, fmt.Errorf("unsupported Claude event %q", e.Name)
		}
	case "codex":
		e.Name = field(m, "hook_event_name")
		e.ConversationID = field(m, "session_id")
		e.ProjectID = field(m, "project_id")
		e.TurnID = field(m, "turn_id")
		e.EventID = field(m, "event_id", "hook_event_id")
		if p := field(m, "cwd"); p != "" {
			e.WorkspacePaths = []string{p}
		}
		switch e.Name {
		case "UserPromptSubmit":
			e.Query = field(m, "prompt")
		case "PreToolUse", "PostToolUse":
			// Tool observations supplement the main prompt; they must never
			// replace it with a tool name or file path.
			var response json.RawMessage
			if e.Name == "PostToolUse" {
				response = m["tool_response"]
			}
			e.Context = toolContext(e.Name, field(m, "tool_name"), m["tool_input"], response, "")
			if e.EventID == "" {
				if id := field(m, "tool_use_id"); id != "" {
					e.EventID = e.Name + ":" + id
				}
			}
		case "SessionStart":
			e.EpochReset = field(m, "source") == "compact"
		case "Stop", "Interrupt", "SessionEnd":
			e.Cancel = true
		case "PreCompact", "PostCompact", "PreModelRequest", "PostModelRequest":
			// Model-request hooks are diagnostics, not injection points. Compaction
			// resets only at the documented SessionStart(source=compact) boundary.
		default:
			return Event{}, fmt.Errorf("unsupported Codex event %q", e.Name)
		}
	case "agy":
		e.Name = field(m, "hookEventName", "eventName", "event")
		// Antigravity's hook payload has no event-name field in some versions.
		// The separate hook command supplies the name via --event upstream.
		e.ConversationID = field(m, "conversationId")
		e.ProjectID = field(m, "projectId")
		e.TurnID = field(m, "turnId", "invocationNum")
		e.EventID = field(m, "eventId")
		if v, ok := m["workspacePaths"]; ok {
			if err := json.Unmarshal(v, &e.WorkspacePaths); err != nil {
				return Event{}, errors.New("workspacePaths must be strings")
			}
		}
		switch e.Name {
		case "PreInvocation", "PostInvocation":
			e.Query = field(m, "lastUserInput")
		case "PostToolUse", "PreToolUse":
			e.Query = field(m, "lastUserInput")
			var call map[string]json.RawMessage
			_ = json.Unmarshal(m["toolCall"], &call)
			// agy's documented PostToolUse carries the call and an optional
			// error, not the tool's output. transcriptPath is deliberately not read.
			errorText := ""
			if e.Name == "PostToolUse" {
				errorText = field(m, "error")
			}
			e.Context = toolContext(e.Name, field(call, "name"), call["args"], nil, errorText)
		case "SessionStart":
			// Observe binding only. The first PreInvocation carries the prompt.
		case "Stop":
			e.Cancel = true
		case "PreCompact", "PostCompact":
			// Not configured by the supplied adapter; explicit reset is available in
			// Sniffer if a future CLI adds a documented compaction boundary.
		default:
			return Event{}, fmt.Errorf("unsupported Antigravity event %q", e.Name)
		}
	}
	if strings.TrimSpace(e.ConversationID) == "" {
		return Event{}, errors.New("host event has no conversation/session ID")
	}
	if len(e.ConversationID) > 512 || len(e.ProjectID) > 512 || len(e.TurnID) > 512 || len(e.EventID) > 512 {
		return Event{}, errors.New("event identifier too long")
	}
	if len(e.Query) > 24*1024 {
		return Event{}, errors.New("event query exceeds 24 KiB")
	}
	if len(e.Context) > MaxContextBytes || !utf8.ValidString(e.Context) {
		return Event{}, errors.New("event context exceeds 24 KiB or is not valid UTF-8")
	}
	return e, nil
}

// WithEventName supplies the adapter's known Antigravity hook name. This avoids
// relying on a field the product may not emit, or guessing it from its payload.
func WithEventName(raw []byte, name string) ([]byte, error) {
	if len(raw) > MaxEventBytes {
		return nil, errors.New("event too large")
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil || m == nil {
		return nil, errors.New("event must be a JSON object")
	}
	b, _ := json.Marshal(name)
	m["hookEventName"] = b
	return json.Marshal(m)
}

// Encode only returns context at documented injection sites. Observation-only
// callbacks get {}, never an invented response field.
func Encode(host, eventName, context string) ([]byte, error) {
	h, err := Canonical(host)
	if err != nil {
		return nil, err
	}
	if h == "agy" && eventName == "Stop" {
		return []byte("{\"decision\":\"stop\"}\n"), nil
	}
	if len(context) > 64*1024 {
		return nil, errors.New("context exceeds 64 KiB")
	}
	if context == "" {
		return []byte("{}\n"), nil
	}
	var out any
	switch h {
	case "claude":
		if eventName != "prompt.submit" && eventName != "tool.complete" {
			return []byte("{}\n"), nil
		}
		out = struct {
			Context string `json:"context"`
		}{context}
	case "codex":
		switch eventName {
		case "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse":
		default:
			return []byte("{}\n"), nil
		}
		out = map[string]any{"hookSpecificOutput": map[string]string{"hookEventName": eventName, "additionalContext": context}}
	case "agy":
		if eventName != "PreInvocation" {
			return []byte("{}\n"), nil
		}
		out = map[string]any{"injectSteps": []any{map[string]any{"systemMessage": map[string]any{"systemMessage": context, "metadata": map[string]string{"source": "sniffer"}}}}}
	}
	b, err := json.Marshal(out)
	return append(b, '\n'), err
}

func field(m map[string]json.RawMessage, names ...string) string {
	for _, n := range names {
		if v, ok := m[n]; ok {
			var s string
			if json.Unmarshal(v, &s) == nil {
				return s
			}
			var number json.Number
			if json.Unmarshal(v, &number) == nil {
				return number.String()
			}
		}
	}
	return ""
}
func boolean(m map[string]json.RawMessage, n string) bool {
	var v bool
	_ = json.Unmarshal(m[n], &v)
	return v
}

// toolContext is an observation envelope, never a new user instruction. It
// excludes shell commands, proposed file bodies, arbitrary arguments and binary
// MCP blocks. Text excerpts receive best-effort credential redaction; this is
// not a guarantee that arbitrary secrets can be detected in arbitrary prose.
func toolContext(event, name string, input, result json.RawMessage, errorText string) string {
	if name == "" {
		return ""
	}
	var in map[string]json.RawMessage
	_ = json.Unmarshal(input, &in)
	observation := struct {
		Event  string            `json:"event"`
		Tool   string            `json:"tool"`
		Input  map[string]string `json:"input,omitempty"`
		Result string            `json:"result_excerpt,omitempty"`
		Error  string            `json:"error_excerpt,omitempty"`
		Quoted bool              `json:"untrusted_observation"`
	}{Event: event, Tool: contextClip(name, 128), Input: map[string]string{}, Quoted: true}
	for _, key := range []string{"file_path", "path", "query", "pattern", "glob", "cwd", "AbsolutePath", "DirectoryPath", "SearchPath", "Query", "Pattern", "TargetFile"} {
		if len(observation.Input) == 8 {
			break
		}
		if s := field(in, key); s != "" {
			observation.Input[key] = contextClip(contextRedact(s), 512)
		}
	}
	observation.Result = contextClip(contextRedact(resultText(result)), 4096)
	observation.Error = contextClip(contextRedact(errorText), 1024)
	for {
		b, _ := json.Marshal(observation)
		if len(b) <= MaxContextBytes {
			return string(b)
		}
		// JSON escaping can expand a text excerpt. Shrink field values rather
		// than truncating the serialized object into invalid JSON.
		observation.Result = contextClip(observation.Result, len(observation.Result)/2)
		observation.Error = contextClip(observation.Error, len(observation.Error)/2)
		for key, value := range observation.Input {
			observation.Input[key] = contextClip(value, len(value)/2)
		}
	}
}

func resultText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return ""
	}
	var parts []string
	size := 0
	var visit func(any, int)
	visit = func(v any, depth int) {
		if depth > 4 || len(parts) >= 16 || size >= 8192 {
			return
		}
		switch x := v.(type) {
		case string:
			// Redact before clipping so a token spanning the boundary cannot
			// leave a partial credential at the end of an excerpt.
			text := contextClip(contextRedact(x), 4096)
			parts = append(parts, text)
			size += len(text)
		case []any:
			for i, child := range x {
				if i == 16 {
					break
				}
				visit(child, depth+1)
			}
		case map[string]any:
			if kind, ok := x["type"].(string); ok && kind != "text" && kind != "output_text" {
				return
			}
			for _, key := range []string{"text", "content", "output", "stdout", "stderr", "message", "error", "summary"} {
				if child, ok := x[key]; ok {
					visit(child, depth+1)
				}
			}
			for _, key := range []string{"isError", "exit_code", "exitCode"} {
				if child, ok := x[key]; ok {
					switch child.(type) {
					case bool, float64:
						parts = append(parts, fmt.Sprintf("%s=%v", key, child))
					}
				}
			}
		}
	}
	visit(value, 0)
	return strings.Join(parts, "\n")
}

var contextPrivateKey = regexp.MustCompile(`(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----`)
var contextBearer = regexp.MustCompile(`(?i)\b(?:Bearer|Basic)\s+[A-Za-z0-9+/._=-]+`)
var contextToken = regexp.MustCompile(`\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,})\b`)
var contextAssignment = regexp.MustCompile(`(?i)\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|authorization|cookie)\b["']?\s*[:=]\s*["']?[^\s,;"']+`)

func contextRedact(text string) string {
	text = contextPrivateKey.ReplaceAllString(text, "[REDACTED PRIVATE KEY]")
	text = contextBearer.ReplaceAllString(text, "[REDACTED AUTHORIZATION]")
	text = contextToken.ReplaceAllString(text, "[REDACTED TOKEN]")
	return contextAssignment.ReplaceAllString(text, "[REDACTED ASSIGNMENT]")
}

func contextClip(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	const marker = " [truncated]"
	if limit <= len(marker) {
		return ""
	}
	end := limit - len(marker)
	for end > 0 && !utf8.RuneStart(text[end]) {
		end--
	}
	return text[:end] + marker
}
