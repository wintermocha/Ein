package native

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"
)

const agyAgentName = "sniffer-memory-agent"
const agyServerName = "sniffer"
const agyMaxObservation = 64 * 1024
const agyMaxHistoryBytes = 256 * 1024
const agyMaxHistoryItems = 32

var agyReaderTools = []string{"memory_search", "memory_read", "memory_context"}

// agySession uses the public, sequential headless stream protocol. A Run adds
// one observation to the same conversation; stdin stays open between Runs.
// Cancellation kills the owned process group because this protocol has no
// interrupt/control message. The next Run starts a NEW conversation with an
// explicit, bounded reseed of previous observations (not fabricated tool or
// assistant messages). ID therefore changes after such a restart.
type agySession struct {
	cfg         Config
	dir         string
	contextPath string
	schemaPath  string
	runMu       sync.Mutex
	mu          sync.Mutex
	process     *agyProcess
	closed      bool
	id          string
	mainID      string
	usage       Usage
	baseline    Usage
	history     []Request
	historySize int
	omitted     int
	restart     string
}

type agyProcess struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	events chan agyPacket
	stop   chan struct{}
	done   chan struct{}
	once   sync.Once
	err    error // written before done is closed
}

type agyPacket struct {
	message map[string]json.RawMessage
	bytes   int
	err     error
}

// NewAGY creates only private runtime files. It neither changes global agy
// configuration nor reads/copies credentials. CLI startup is lazy, on Run.
// The runtime workspace enables its own PreToolUse guard. agy has no documented
// strict per-process global-customization override; global user customizations
// can still load. The model tool inventory must match our restricted profile
// before any observation is sent. This is not an OS sandbox for agy itself.
func NewAGY(cfg Config) (Session, error) {
	if cfg.Host != "" && cfg.Host != "agy" && cfg.Host != "antigravity" {
		return nil, errors.New("agy session requires the agy host")
	}
	if cfg.ProjectID == "" || cfg.EinHome == "" || cfg.SnifferExecutable == "" {
		return nil, errors.New("agy requires a bound project, Ein home, and Sniffer executable")
	}
	if cfg.Agent != "" && cfg.Agent != agyAgentName {
		return nil, errors.New("agy memory session requires sniffer-memory-agent")
	}
	if cfg.Executable == "" {
		cfg.Executable = "agy"
	}
	var err error
	if cfg.Executable, err = exec.LookPath(cfg.Executable); err != nil {
		return nil, fmt.Errorf("locate agy: %w", err)
	}
	if cfg.SnifferExecutable, err = exec.LookPath(cfg.SnifferExecutable); err != nil {
		return nil, fmt.Errorf("locate Sniffer MCP reader: %w", err)
	}
	if cfg.Executable, err = filepath.Abs(cfg.Executable); err != nil {
		return nil, err
	}
	if cfg.SnifferExecutable, err = filepath.Abs(cfg.SnifferExecutable); err != nil {
		return nil, err
	}
	if cfg.EinHome, err = filepath.Abs(cfg.EinHome); err != nil {
		return nil, err
	}
	if cfg.RuntimeDir != "" {
		if err = os.MkdirAll(cfg.RuntimeDir, 0700); err != nil {
			return nil, err
		}
	}
	dir, err := os.MkdirTemp(cfg.RuntimeDir, "sniffer-agy-")
	if err != nil {
		return nil, err
	}
	s := &agySession{cfg: cfg, dir: dir, contextPath: filepath.Join(dir, "context.json"), schemaPath: filepath.Join(dir, "decision.schema.json")}
	if err = s.configure(); err != nil {
		_ = os.RemoveAll(dir)
		return nil, err
	}
	return s, nil
}

func (s *agySession) configure() error {
	agentDir := filepath.Join(s.dir, ".agents", "agents")
	if err := os.MkdirAll(agentDir, 0700); err != nil {
		return err
	}
	files := map[string]any{s.schemaPath: DecisionSchema(), s.contextPath: map[string]any{}}
	toolConfig := map[string]any{}
	for _, name := range agyReaderTools {
		toolConfig[name] = map[string]any{"eager": true}
	}
	files[filepath.Join(s.dir, ".agents", "mcp_config.json")] = map[string]any{
		"mcpServers": map[string]any{agyServerName: map[string]any{
			"command":      s.cfg.SnifferExecutable,
			"args":         []string{"--home", s.cfg.EinHome, "mcp", "--role", "agent-reader", "--project", s.cfg.ProjectID, "--context-file", s.contextPath, "--workspace", s.cfg.Cwd},
			"env":          map[string]string{"EIN_SNIFFER_ROLE": "memory-agent", "EIN_SNIFFER_PROJECT_ID": s.cfg.ProjectID},
			"enabledTools": agyReaderTools,
			"tools":        toolConfig,
		}},
	}
	guard := agyShellQuote(s.cfg.SnifferExecutable) + " --home " + agyShellQuote(s.cfg.EinHome) + " agent-guard agy"
	files[filepath.Join(s.dir, ".agents", "hooks.json")] = map[string]any{
		"sniffer-memory-guard": map[string]any{
			"enabled": true,
			"PreToolUse": []any{map[string]any{
				"matcher": "*",
				"hooks":   []any{map[string]any{"type": "command", "command": guard, "timeout": 5}},
			}},
		},
	}
	for path, value := range files {
		b, err := json.MarshalIndent(value, "", "  ")
		if err != nil {
			return err
		}
		if err = os.WriteFile(path, b, 0600); err != nil {
			return err
		}
	}
	agent := "---\nname: " + agyAgentName + "\ndescription: Follow one main conversation and retrieve relevant committed memories.\ntools: []\nmainAgent: true\nsubagent: false\nmodel: inherit\ncommandExecutionPolicy: off\ninheritMcp: true\ninheritCustomizations: true\nskills: []\nplugins: []\n---\n" + SystemPrompt + "\nThe three reader tools have the native names mcp_sniffer_memory_search, mcp_sniffer_memory_read, and mcp_sniffer_memory_context. Do not call send_message or ask_permission even if the harness lists them. A runtime guard rejects all other tools.\n"
	return os.WriteFile(filepath.Join(agentDir, agyAgentName+".md"), []byte(agent), 0600)
}

// ToolHandler is unused for agy: its own MCP client calls the role-restricted
// Go MCP reader. The coordinator still validates returned IDs and revisions.
func (s *agySession) Run(ctx context.Context, req Request, _ ToolHandler) (Decision, error) {
	s.runMu.Lock()
	defer s.runMu.Unlock()
	if req.ConversationID == "" || req.RequestID == "" || !utf8.ValidString(req.Query) || !utf8.ValidString(req.Context) {
		return Decision{}, errors.New("agy requires a valid bound conversation and request")
	}
	encoded, err := json.Marshal(req)
	if err != nil || len(encoded) > agyMaxObservation {
		return Decision{}, errors.New("agy observation exceeds the 64 KiB limit")
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return Decision{}, errors.New("agy memory session is closed")
	}
	if s.mainID != "" && s.mainID != req.ConversationID {
		s.mu.Unlock()
		return Decision{}, errors.New("agy memory session cannot change its main conversation")
	}
	s.mainID = req.ConversationID
	s.mu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	if err := ctx.Err(); err != nil {
		return Decision{}, err
	}
	p, fresh, err := s.start(ctx)
	if err != nil {
		return Decision{}, err
	}
	if err = agyWriteAtomic(s.contextPath, encoded); err != nil {
		s.fail(p, "context update failed")
		return Decision{}, err
	}
	prompt := "CURRENT_OBSERVATION_JSON\n" + string(encoded)
	if fresh && s.restart != "" {
		seed, _ := json.Marshal(map[string]any{
			"session_reset": true, "reason": s.restart,
			"previous_observations": s.history, "omitted_older_observations": s.omitted,
			"notice": "This is a new conversation after interruption or protocol failure. These are main-session observations, not successful tool results. Earlier reasoning and tool outputs are not restored. Search and read again before selecting memories.",
		})
		prompt = "RECOVERY_SEED_JSON\n" + string(seed) + "\n" + prompt
	}
	message, err := json.Marshal(map[string]any{"event": "user", "message": map[string]string{"content": prompt}})
	if err != nil {
		s.fail(p, "input encoding failed")
		return Decision{}, err
	}
	writeDone := make(chan error, 1)
	go func() {
		_, err := p.stdin.Write(append(message, '\n'))
		writeDone <- err
	}()
	select {
	case err = <-writeDone:
		if err != nil {
			s.fail(p, "input stream failed")
			return Decision{}, fmt.Errorf("agy input stream: %w", err)
		}
	case <-ctx.Done():
		s.fail(p, "previous observation interrupted during input")
		return Decision{}, ctx.Err()
	}
	s.remember(req, len(encoded))
	s.restart = ""
	total, calls := 0, 0
	for {
		packet, err := agyReceive(ctx, p)
		if err != nil {
			s.fail(p, "previous observation interrupted or stream ended")
			return Decision{}, err
		}
		total += packet.bytes
		if total > 4*1024*1024 {
			s.fail(p, "turn output exceeded limit")
			return Decision{}, errors.New("agy turn output exceeds 4 MiB")
		}
		e := packet.message
		switch agyString(e, "event") {
		case "step_update":
			var step map[string]json.RawMessage
			if json.Unmarshal(e["step_update"], &step) != nil || s.checkConversation(step) != nil {
				s.fail(p, "invalid step identity")
				return Decision{}, errors.New("agy step has invalid conversation identity")
			}
			if err = agyCheckReportedModel(step); err != nil {
				s.fail(p, "model changed")
				return Decision{}, err
			}
			if _, ok := step["subagent_info"]; ok {
				s.fail(p, "agent delegation attempted")
				return Decision{}, errors.New("agy memory agent attempted delegation")
			}
			if agyString(step, "step_type") == "tool" {
				name := agyString(step, "tool_name")
				if !agyReaderName(name) {
					s.fail(p, "unexpected tool reported")
					return Decision{}, errors.New("agy reported a non-reader tool; runtime guard compatibility must be checked")
				}
				if agyString(step, "state") == "DONE" {
					var info map[string]json.RawMessage
					if json.Unmarshal(step["tool_info"], &info) == nil {
						if detail, ok := info["error"]; ok && string(detail) != "null" && string(detail) != `""` {
							s.fail(p, "reader tool failed")
							return Decision{}, errors.New("agy reader tool failed or was denied; no memory decision accepted")
						}
					}
					calls++
					if calls > 12 {
						s.fail(p, "reader tool budget exceeded")
						return Decision{}, errors.New("agy memory tool budget exceeded")
					}
				}
			}
		case "result":
			var result map[string]json.RawMessage
			if json.Unmarshal(e["result"], &result) != nil || s.checkConversation(result) != nil {
				s.fail(p, "invalid result identity")
				return Decision{}, errors.New("agy result has invalid conversation identity")
			}
			if err = agyCheckReportedModel(result); err != nil {
				s.fail(p, "model changed")
				return Decision{}, err
			}
			if err = s.addUsage(result["usage"]); err != nil {
				s.fail(p, "usage counters invalid")
				return Decision{}, err
			}
			if agyString(result, "status") != "SUCCESS" {
				s.fail(p, "turn did not succeed")
				return Decision{}, errors.New("agy memory turn did not succeed")
			}
			if err = ctx.Err(); err != nil {
				s.fail(p, "turn canceled before its result was accepted")
				return Decision{}, err
			}
			d, err := ParseDecision(result["structured_output"])
			if err != nil {
				s.fail(p, "structured decision invalid")
				return Decision{}, err
			}
			return d, nil
		default:
			s.fail(p, "unexpected stream event")
			return Decision{}, errors.New("agy emitted an unexpected event during a memory turn")
		}
	}
}

func (s *agySession) start(ctx context.Context) (*agyProcess, bool, error) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil, false, errors.New("agy memory session is closed")
	}
	if s.process != nil {
		p := s.process
		s.mu.Unlock()
		select {
		case <-p.done:
			s.fail(p, "previous process exited between observations")
			return s.start(ctx)
		default:
			return p, false, nil
		}
	}
	if err := agyWriteAtomic(s.contextPath, []byte("{}")); err != nil {
		s.mu.Unlock()
		return nil, false, err
	}
	args := []string{"--input-format", "stream-json", "--output-format", "stream-json", "--model", Model("agy"), "--agent", agyAgentName, "--json-schema", s.schemaPath, "--disable-slash-commands", "--mode", "plan"}
	cmd := exec.Command(s.cfg.Executable, args...)
	cmd.Dir = s.dir
	cmd.Env = agyEnvironment(s.cfg)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Stderr = io.Discard
	stdin, err := cmd.StdinPipe()
	if err != nil {
		s.mu.Unlock()
		return nil, false, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		s.mu.Unlock()
		return nil, false, err
	}
	p := &agyProcess{cmd: cmd, stdin: stdin, events: make(chan agyPacket, 16), stop: make(chan struct{}), done: make(chan struct{})}
	if err = cmd.Start(); err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		s.mu.Unlock()
		return nil, false, fmt.Errorf("start agy memory process: %w", err)
	}
	s.process = p
	s.baseline = Usage{}
	s.mu.Unlock()
	go p.read(stdout)
	initCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	packet, err := agyReceive(initCtx, p)
	if err != nil {
		s.fail(p, "init unavailable")
		return nil, false, fmt.Errorf("agy init before observation: %w", err)
	}
	id, err := agyValidateInit(packet.message)
	if err != nil {
		s.fail(p, "init policy mismatch")
		return nil, false, err
	}
	s.mu.Lock()
	if s.closed || s.process != p {
		s.mu.Unlock()
		agyStop(p)
		return nil, false, errors.New("agy session closed during startup")
	}
	s.id = id
	s.mu.Unlock()
	return p, true, nil
}

func agyValidateInit(e map[string]json.RawMessage) (string, error) {
	if agyString(e, "event") != "init" {
		return "", errors.New("agy must emit init before receiving any observation")
	}
	id := agyString(e, "conversation_id")
	if id == "" || len(id) > 256 {
		return "", errors.New("agy init has no valid conversation ID")
	}
	var init map[string]json.RawMessage
	if json.Unmarshal(e["init"], &init) != nil || agyString(init, "model") != Model("agy") || agyString(init, "agent") != agyAgentName {
		return "", errors.New("agy effective model or agent differs from the pinned memory profile")
	}
	if mode := agyString(init, "permission_mode"); mode != "request-review" && mode != "strict" {
		return "", errors.New("agy memory profile requires request-review or strict permissions")
	}
	var names []string
	if json.Unmarshal(init["tools"], &names) != nil || names == nil {
		return "", errors.New("agy must announce its effective tool inventory")
	}
	seen := map[string]bool{}
	for _, name := range names {
		if seen[name] || (!agyReaderName(name) && name != "send_message" && name != "ask_permission") {
			return "", errors.New("agy memory profile exposes unexpected tools; disable inherited non-reader capabilities")
		}
		seen[name] = true
	}
	for _, name := range agyReaderTools {
		if !seen["mcp_"+agyServerName+"_"+name] {
			return "", errors.New("agy must expose all three eager Sniffer reader MCP tools")
		}
	}
	return id, nil
}

func agyReaderName(name string) bool {
	for _, tool := range agyReaderTools {
		if name == "mcp_"+agyServerName+"_"+tool {
			return true
		}
	}
	return false
}

func (p *agyProcess) read(stdout io.ReadCloser) {
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 4096), 512*1024)
	for scanner.Scan() {
		packet := agyPacket{bytes: len(scanner.Bytes())}
		if err := json.Unmarshal(scanner.Bytes(), &packet.message); err != nil || packet.message == nil {
			packet.err = errors.New("agy emitted invalid stream JSON")
		}
		select {
		case p.events <- packet:
		case <-p.stop:
			_ = stdout.Close()
			p.err = p.cmd.Wait()
			close(p.events)
			close(p.done)
			return
		}
		if packet.err != nil {
			break
		}
	}
	if err := scanner.Err(); err != nil {
		select {
		case p.events <- agyPacket{err: errors.New("agy output line exceeds limit or stream failed")}:
		case <-p.stop:
		}
	}
	_ = stdout.Close()
	p.err = p.cmd.Wait()
	close(p.events)
	close(p.done)
}

func agyReceive(ctx context.Context, p *agyProcess) (agyPacket, error) {
	select {
	case <-ctx.Done():
		return agyPacket{}, ctx.Err()
	case packet, ok := <-p.events:
		if !ok {
			return agyPacket{}, errors.New("agy memory process ended before a complete response")
		}
		return packet, packet.err
	}
}

func (s *agySession) checkConversation(m map[string]json.RawMessage) error {
	s.mu.Lock()
	id := s.id
	s.mu.Unlock()
	if agyString(m, "conversation_id") != id {
		return errors.New("agy conversation changed unexpectedly")
	}
	return nil
}

func agyCheckReportedModel(m map[string]json.RawMessage) error {
	for _, field := range []string{"model", "model_name"} {
		if raw, ok := m[field]; ok && string(raw) != "null" && agyString(m, field) != Model("agy") {
			return errors.New("agy reported a different model during the memory turn")
		}
	}
	return nil
}

func (s *agySession) remember(req Request, size int) {
	s.history = append(s.history, req)
	s.historySize += size
	for len(s.history) > agyMaxHistoryItems || s.historySize > agyMaxHistoryBytes {
		b, _ := json.Marshal(s.history[0])
		s.historySize -= len(b)
		s.history = s.history[1:]
		s.omitted++
	}
}

func (s *agySession) addUsage(raw json.RawMessage) error {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var u struct {
		Input    int64 `json:"input_tokens"`
		Output   int64 `json:"output_tokens"`
		Read     int64 `json:"cache_read_tokens"`
		Creation int64 `json:"cache_creation_tokens"`
	}
	if json.Unmarshal(raw, &u) != nil || u.Input < 0 || u.Output < 0 || u.Read < 0 || u.Creation < 0 {
		return errors.New("agy returned invalid usage counters")
	}
	current := Usage{InputTokens: u.Input, OutputTokens: u.Output, CacheReadTokens: u.Read, CacheCreationTokens: u.Creation}
	s.mu.Lock()
	defer s.mu.Unlock()
	if current.InputTokens < s.baseline.InputTokens || current.OutputTokens < s.baseline.OutputTokens || current.CacheReadTokens < s.baseline.CacheReadTokens || current.CacheCreationTokens < s.baseline.CacheCreationTokens {
		return errors.New("agy cumulative usage counters moved backwards")
	}
	s.usage.InputTokens += current.InputTokens - s.baseline.InputTokens
	s.usage.OutputTokens += current.OutputTokens - s.baseline.OutputTokens
	s.usage.CacheReadTokens += current.CacheReadTokens - s.baseline.CacheReadTokens
	s.usage.CacheCreationTokens += current.CacheCreationTokens - s.baseline.CacheCreationTokens
	s.baseline = current
	return nil
}

func (s *agySession) fail(p *agyProcess, reason string) {
	s.mu.Lock()
	if s.process == p {
		s.process = nil
	}
	s.mu.Unlock()
	s.restart = reason // Run serializes all writes to restart/history.
	agyStop(p)
}

func agyStop(p *agyProcess) {
	if p == nil {
		return
	}
	p.once.Do(func() {
		close(p.stop)
		_ = p.stdin.Close()
		_ = syscall.Kill(-p.cmd.Process.Pid, syscall.SIGTERM)
	})
	select {
	case <-p.done:
		return
	case <-time.After(150 * time.Millisecond):
		_ = syscall.Kill(-p.cmd.Process.Pid, syscall.SIGKILL)
	}
	select {
	case <-p.done:
	case <-time.After(time.Second):
	}
}

func (s *agySession) Close() error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	p := s.process
	s.process = nil
	s.mu.Unlock()
	agyStop(p)
	return os.RemoveAll(s.dir)
}

func (s *agySession) ID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.id
}

func (s *agySession) Usage() Usage {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.usage
}

func agyString(m map[string]json.RawMessage, key string) string {
	var v string
	_ = json.Unmarshal(m[key], &v)
	return v
}

func agyEnvironment(cfg Config) []string {
	env := make([]string, 0, len(os.Environ())+3)
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if strings.HasPrefix(key, "EIN_SNIFFER_") || key == "EIN_HOME" {
			continue
		}
		env = append(env, entry)
	}
	return append(env, "EIN_HOME="+cfg.EinHome, "EIN_SNIFFER_ROLE=memory-agent", "EIN_SNIFFER_PROJECT_ID="+cfg.ProjectID)
}

func agyShellQuote(v string) string { return "'" + strings.ReplaceAll(v, "'", "'\"'\"'") + "'" }

func agyWriteAtomic(path string, contents []byte) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".context-*")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if _, err = f.Write(contents); err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(name, path)
}
