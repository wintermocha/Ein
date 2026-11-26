package host

import (
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestDecodeHosts(t *testing.T) {
	tests := []struct {
		host, raw, id, query string
		reset, cancel        bool
	}{
		{"claude", `{"event":"prompt.submit","session_id":"c1","cwd":"/project","query":"배포 deploy","turn_id":"t1"}`, "c1", "배포 deploy", false, false},
		{"codex", `{"hook_event_name":"UserPromptSubmit","session_id":"c2","prompt":"기억 검색","cwd":"/p"}`, "c2", "기억 검색", false, false},
		{"codex", `{"hook_event_name":"SessionStart","session_id":"c2","source":"compact"}`, "c2", "", true, false},
		{"codex", `{"hook_event_name":"Stop","session_id":"c2"}`, "c2", "", false, true},
		{"agy", `{"hookEventName":"PreInvocation","conversationId":"a1","workspacePaths":["/a","/b"],"lastUserInput":"search cache","invocationNum":3}`, "a1", "search cache", false, false},
		{"antigravity", `{"hookEventName":"Stop","conversationId":"a1","terminationReason":"model_stop","fullyIdle":true}`, "a1", "", false, true},
	}
	for _, tt := range tests {
		t.Run(tt.host+tt.query, func(t *testing.T) {
			e, err := Decode(tt.host, []byte(tt.raw))
			if err != nil {
				t.Fatal(err)
			}
			if e.ConversationID != tt.id || e.Query != tt.query || e.EpochReset != tt.reset || e.Cancel != tt.cancel {
				t.Fatalf("unexpected event: %+v", e)
			}
		})
	}
}
func TestObservationAndNoInventedID(t *testing.T) {
	e, err := Decode("codex", []byte(`{"hook_event_name":"PostToolUse","session_id":"s","tool_name":"read_file","tool_use_id":"u","tool_input":{"file_path":"a.go","command":"do not copy this command","content":"do not copy proposed content"},"tool_response":"test failed: missing refresh handling"}`))
	if err != nil {
		t.Fatal(err)
	}
	if e.Query != "" || e.EventID != "PostToolUse:u" || !strings.Contains(e.Context, "read_file") || !strings.Contains(e.Context, "a.go") || !strings.Contains(e.Context, "missing refresh handling") {
		t.Fatal(e)
	}
	if strings.Contains(e.Context, "do not copy") || !json.Valid([]byte(e.Context)) {
		t.Fatalf("observation contains excluded fields or invalid JSON: %s", e.Context)
	}
	e, err = Decode("codex", []byte(`{"hook_event_name":"UserPromptSubmit","session_id":"s","prompt":"again"}`))
	if err != nil || e.EventID != "" {
		t.Fatal(e, err)
	}
}

func TestCodexToolContextIsBoundedAndRedactsCredentials(t *testing.T) {
	response := map[string]any{"content": []any{
		map[string]any{"type": "text", "text": "Authorization: Bearer private-token-123 password=hunter2\n" + strings.Repeat("한글", 5000)},
		map[string]any{"type": "image", "data": "binary-image-must-not-leak"},
	}, "isError": true, "token": "unknown-sensitive-field"}
	raw, _ := json.Marshal(map[string]any{
		"hook_event_name": "PostToolUse", "session_id": "s", "tool_name": "mcp_reader", "tool_response": response,
		"tool_input": map[string]any{"query": "refresh token", "authorization": "secret-input", "command": "echo secret"},
	})
	e, err := Decode("codex", raw)
	if err != nil {
		t.Fatal(err)
	}
	if e.Query != "" || len(e.Context) > MaxContextBytes || !utf8.ValidString(e.Context) || !json.Valid([]byte(e.Context)) {
		t.Fatalf("bad bounded observation: %+v", e)
	}
	for _, forbidden := range []string{"private-token-123", "hunter2", "binary-image-must-not-leak", "unknown-sensitive-field", "secret-input", "echo secret"} {
		if strings.Contains(e.Context, forbidden) {
			t.Fatalf("unexpected sensitive or non-text content: %q", forbidden)
		}
	}
	if !strings.Contains(e.Context, "[REDACTED") || !strings.Contains(e.Context, "[truncated]") || !strings.Contains(e.Context, "refresh token") {
		t.Fatal("lost useful metadata or expected redaction/truncation notices")
	}
	var contextObject map[string]any
	_ = json.Unmarshal([]byte(e.Context), &contextObject)
	if result, _ := contextObject["result_excerpt"].(string); len(result) > 4096 {
		t.Fatal("result excerpt exceeded its bound")
	}
}

func TestCodexPreToolContextDoesNotTreatFutureResultAsObservation(t *testing.T) {
	e, err := Decode("codex", []byte(`{"hook_event_name":"PreToolUse","session_id":"s","tool_name":"read_file","tool_input":{"path":"auth.go"},"tool_response":"not completed yet","transcript_path":"/must/not/read"}`))
	if err != nil || e.Query != "" || !strings.Contains(e.Context, "auth.go") || strings.Contains(e.Context, "not completed yet") || strings.Contains(e.Context, "/must/not/read") {
		t.Fatal(e, err)
	}
}

func TestAntigravityUsesDocumentedToolCallShapeWithoutTranscriptReads(t *testing.T) {
	e, err := Decode("agy", []byte(`{"hookEventName":"PostToolUse","conversationId":"a","workspacePaths":["/project"],"lastUserInput":"전에 정한 인증 방식으로","toolCall":{"name":"view_file","args":{"AbsolutePath":"/project/auth.go","CommandLine":"do-not-copy","CodeContent":"private"}},"error":"access denied for password=hunter2","tool_response":"not an official agy result field","transcriptPath":"/must/not/read"}`))
	if err != nil {
		t.Fatal(err)
	}
	if e.Query != "전에 정한 인증 방식으로" || !strings.Contains(e.Context, "view_file") || !strings.Contains(e.Context, "/project/auth.go") || !strings.Contains(e.Context, "access denied") {
		t.Fatal(e)
	}
	for _, forbidden := range []string{"hunter2", "do-not-copy", "private", "not an official", "/must/not/read"} {
		if strings.Contains(e.Context, forbidden) {
			t.Fatalf("agy included unsupported or sensitive fields: %q", forbidden)
		}
	}
	for _, name := range []string{"SessionStart", "PostInvocation"} {
		b, _ := WithEventName([]byte(`{"conversationId":"a","lastUserInput":"current task","invocationNum":4}`), name)
		if _, err := Decode("agy", b); err != nil {
			t.Fatalf("documented agy event rejected: %s %v", name, err)
		}
	}
}

func TestExplicitClaudeContextAndObservationBound(t *testing.T) {
	raw, _ := json.Marshal(map[string]any{"event": "tool.complete", "session_id": "s", "context": "이전 도구 결과 요약", "query": "original prompt"})
	e, err := Decode("claude", raw)
	if err != nil || e.Context != "이전 도구 결과 요약" || e.Query != "original prompt" {
		t.Fatal(e, err)
	}
	raw, _ = json.Marshal(map[string]any{"event": "tool.complete", "session_id": "s", "context": strings.Repeat("a", MaxContextBytes+1)})
	if _, err := Decode("claude", raw); err == nil {
		t.Fatal("accepted oversized explicit context")
	}
	// Many characters expand under JSON escaping. Preserve a complete JSON
	// envelope and valid Korean characters when shrinking generated context.
	raw, _ = json.Marshal(map[string]any{"hook_event_name": "PostToolUse", "session_id": "s", "tool_name": "read", "tool_input": map[string]any{"query": strings.Repeat("<", 4000)}, "tool_response": strings.Repeat("<한글>", 4000)})
	e, err = Decode("codex", raw)
	if err != nil || len(e.Context) > MaxContextBytes || !json.Valid([]byte(e.Context)) || !utf8.ValidString(e.Context) {
		t.Fatal("escaping exceeded context budget or broke encoding", err)
	}
}
func TestDecodeRejectsMalformed(t *testing.T) {
	for _, raw := range []string{`{}`, `null`, `[]`, `{"session_id":"s","hook_event_name":"UserPromptSubmit"} {}`, `{"session_id":"s","hook_event_name":"unknown"}`} {
		if _, err := Decode("codex", []byte(raw)); err == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
	if _, err := Decode("claude", []byte(strings.Repeat(" ", MaxEventBytes+1))); err == nil {
		t.Fatal("accepted oversized event")
	}
}
func TestEncodeContracts(t *testing.T) {
	for _, tt := range []struct{ h, n, key string }{{"claude", "prompt.submit", "context"}, {"codex", "UserPromptSubmit", "hookSpecificOutput"}, {"agy", "PreInvocation", "injectSteps"}} {
		b, err := Encode(tt.h, tt.n, "한글\nreference")
		if err != nil {
			t.Fatal(err)
		}
		var m map[string]any
		if json.Unmarshal(b, &m) != nil || m[tt.key] == nil {
			t.Fatal(string(b))
		}
	}
	for _, h := range []string{"claude", "codex", "agy"} {
		b, err := Encode(h, "Stop", "must not inject")
		want := "{}\n"
		if h == "agy" {
			want = "{\"decision\":\"stop\"}\n"
		}
		if err != nil || string(b) != want {
			t.Fatal(h, string(b), err)
		}
	}
	b, _ := Encode("codex", "PreModelRequest", "not supported")
	if string(b) != "{}\n" {
		t.Fatal(string(b))
	}
}
func TestAntigravityAdapterKnownEvent(t *testing.T) {
	b, err := WithEventName([]byte(`{"conversationId":"c","lastUserInput":"x"}`), "PreInvocation")
	if err != nil {
		t.Fatal(err)
	}
	e, err := Decode("agy", b)
	if err != nil || e.Query != "x" {
		t.Fatal(e, err)
	}
}
