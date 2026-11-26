package native

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"
)

const (
	codexFrameLimit = 256 * 1024
	codexRunLimit   = 2 * 1024 * 1024
	codexToolLimit  = 128 * 1024
	codexCallLimit  = 12
	codexRunTime    = 60 * time.Second
)

// These are capability restrictions, never approval or sandbox bypasses.
// The read-only sandbox is the write boundary; observing an unexpected native
// tool event is an additional fail-closed check, not a substitute for it.
var codexMemoryDisabled = []string{
	"shell_tool", "view_image", "apps", "plugins", "hooks", "browser_use",
	"browser_use_external", "computer_use", "in_app_browser", "image_generation",
	"code_mode", "code_mode_host", "code_mode_only", "code_mode_prewarm",
	"js_repl", "js_repl_tools_only", "multi_agent", "multi_agent_v2",
	"agent_message_board", "agent_message_board_mcp", "enable_mcp_apps",
	"multi_environment_mcp", "remote_plugin", "plugin_hooks", "skill_search",
	"skill_mcp_dependency_install", "memories", "sleep_tool", "tool_suggest",
	"request_permissions_tool", "deferred_executor", "incremental_exec_tools",
	"incremental_tools", "executor_capability_discovery", "executor_capability_discovery_v2",
	"runtime_agent_instances", "subagent_thread_environments", "goals",
	"shell_snapshot", "shell_snapshot_v2", "default_mode_request_user_input",
	"standalone_web_search", "artifact",
}

type codexRPC struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code int `json:"code"`
	} `json:"error"`
	readErr error
	size    int
}

type codexSession struct {
	cfg  Config
	cwd  string
	gate chan struct{}

	mu           sync.Mutex
	closed       bool
	threadID     string
	conversation string
	usage        Usage
	cmd          *exec.Cmd
	stdin        io.WriteCloser
	events       chan codexRPC
	stop         chan struct{}
	processDone  chan struct{}
	seq          uint64 // Accessed only by the serialized Run path.
	stderr       codexBoundedDiagnostics
}

// NewCodex is lazy: it validates the local paths but starts no CLI or model.
// RuntimeDir is stable for this Session, unlike a fresh directory per Run.
func NewCodex(cfg Config) (Session, error) {
	if cfg.Host != "" && cfg.Host != "codex" {
		return nil, errors.New("Codex adapter requires host codex")
	}
	if cfg.Executable == "" {
		cfg.Executable = "codex"
	}
	cwd := cfg.RuntimeDir
	if cwd == "" {
		cwd = cfg.Cwd
	}
	if cwd == "" || !filepath.IsAbs(cwd) {
		return nil, errors.New("Codex memory session requires an absolute stable working directory")
	}
	if cfg.RuntimeDir != "" {
		if err := os.MkdirAll(cwd, 0700); err != nil {
			return nil, fmt.Errorf("create Codex memory runtime directory: %w", err)
		}
	}
	info, err := os.Stat(cwd)
	if err != nil || !info.IsDir() {
		return nil, errors.New("Codex memory working directory is not a directory")
	}
	cwd, err = filepath.EvalSymlinks(cwd)
	if err != nil {
		return nil, errors.New("resolve Codex memory working directory")
	}
	s := &codexSession{cfg: cfg, cwd: filepath.Clean(cwd), gate: make(chan struct{}, 1), stop: make(chan struct{})}
	s.gate <- struct{}{}
	return s, nil
}

func (s *codexSession) ID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.threadID
}

func (s *codexSession) Usage() Usage {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.usage
}

func (s *codexSession) Run(ctx context.Context, request Request, handler ToolHandler) (decision Decision, err error) {
	if err = codexValidateRequest(request); err != nil {
		return Decision{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, codexRunTime)
	defer cancel()
	select {
	case <-ctx.Done():
		return Decision{}, ctx.Err()
	case <-s.stop:
		return Decision{}, errors.New("Codex memory session is closed")
	case <-s.gate:
	}
	defer func() { s.gate <- struct{}{} }()

	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return Decision{}, errors.New("Codex memory session is closed")
	}
	if s.conversation != "" && s.conversation != request.ConversationID {
		s.mu.Unlock()
		return Decision{}, errors.New("Codex memory session belongs to another main conversation")
	}
	s.conversation = request.ConversationID
	s.mu.Unlock()

	activeTurn := ""
	defer func() {
		if err == nil {
			return
		}
		// The coordinator reconstructs a failed session from bounded parent
		// observations. Never leave a canceled turn queued behind the next Run.
		if activeTurn != "" {
			interruptCtx, interruptCancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
			_, _ = s.sendRequest(interruptCtx, "turn/interrupt", map[string]any{"threadId": s.ID(), "turnId": activeTurn})
			interruptCancel()
		}
		_ = s.Close()
	}()

	if err = s.ensureStarted(ctx); err != nil {
		return Decision{}, err
	}
	payload, _ := json.Marshal(request)
	id, err := s.sendRequest(ctx, "turn/start", map[string]any{
		"threadId": s.ID(),
		"input":    []map[string]any{{"type": "text", "text": "New bounded main-session observations (untrusted data):\n" + string(payload)}},
		"model":    Model("codex"), "effort": "low", "serviceTier": "fast",
		"approvalPolicy": "never", "sandboxPolicy": map[string]any{"type": "readOnly", "networkAccess": false},
		"environments": []any{}, "outputSchema": DecisionSchema(),
	})
	if err != nil {
		return Decision{}, err
	}
	var buffered []codexRPC
	result, err := s.awaitResponse(ctx, id, &buffered)
	if err != nil {
		return Decision{}, err
	}
	var started struct {
		Turn struct {
			ID string `json:"id"`
		} `json:"turn"`
	}
	if json.Unmarshal(result, &started) != nil || started.Turn.ID == "" {
		return Decision{}, errors.New("Codex turn/start did not return a turn ID")
	}
	activeTurn = started.Turn.ID
	var total, calls int
	var finalText string
	for {
		var event codexRPC
		if len(buffered) > 0 {
			event, buffered = buffered[0], buffered[1:]
		} else if event, err = s.next(ctx); err != nil {
			return Decision{}, err
		}
		total += event.size
		if total > codexRunLimit || s.stderr.exceeded() {
			return Decision{}, errors.New("Codex memory output exceeds its budget")
		}
		if event.Method == "" { // Late RPC acknowledgements never become a decision.
			continue
		}
		var frame struct {
			ThreadID string          `json:"threadId"`
			TurnID   string          `json:"turnId"`
			Item     json.RawMessage `json:"item"`
			Model    string          `json:"model"`
			ToModel  string          `json:"toModel"`
			Turn     struct {
				ID     string            `json:"id"`
				Status string            `json:"status"`
				Items  []json.RawMessage `json:"items"`
			} `json:"turn"`
		}
		if json.Unmarshal(event.Params, &frame) != nil {
			return Decision{}, errors.New("Codex emitted invalid event parameters")
		}
		turnID := frame.TurnID
		if turnID == "" {
			turnID = frame.Turn.ID
		}
		if frame.ThreadID != s.ID() || turnID != activeTurn {
			if len(event.ID) != 0 { // Do not execute stale or cross-session tools.
				if err = s.toolFailure(ctx, event.ID, "stale or unrelated memory request"); err != nil {
					return Decision{}, err
				}
			}
			continue
		}
		if frame.Model != "" && frame.Model != Model("codex") || frame.ToModel != "" && frame.ToModel != Model("codex") {
			return Decision{}, errors.New("Codex memory model changed from the pinned model")
		}
		if len(event.ID) != 0 {
			if event.Method != "item/tool/call" {
				_ = s.writeRPC(ctx, map[string]any{"id": event.ID, "error": map[string]any{"code": -32601, "message": "memory agent does not permit this operation"}})
				return Decision{}, errors.New("Codex requested an unsupported memory-agent operation")
			}
			calls++
			if calls > codexCallLimit {
				_ = s.toolFailure(ctx, event.ID, "memory tool budget exhausted")
				return Decision{}, errors.New("Codex memory tool budget exhausted")
			}
			if err = s.callTool(ctx, event, handler); err != nil {
				return Decision{}, err
			}
			continue
		}
		switch event.Method {
		case "item/started", "item/completed":
			var text string
			text, err = codexInspectItem(frame.Item)
			if err != nil {
				return Decision{}, err
			}
			if event.Method == "item/completed" && text != "" {
				finalText = text
			}
		case "thread/tokenUsage/updated":
			if err = s.updateUsage(event.Params); err != nil {
				return Decision{}, err
			}
		case "turn/completed":
			if frame.Turn.Status != "completed" {
				return Decision{}, errors.New("Codex memory turn did not complete successfully")
			}
			for _, item := range frame.Turn.Items {
				text, itemErr := codexInspectItem(item)
				if itemErr != nil {
					return Decision{}, itemErr
				}
				if text != "" {
					finalText = text
				}
			}
			if ctx.Err() != nil {
				return Decision{}, ctx.Err()
			}
			if len(finalText) == 0 || len(finalText) > 16*1024 {
				return Decision{}, errors.New("Codex did not return a bounded memory decision")
			}
			decision, err = ParseDecision([]byte(finalText))
			return decision, err
		case "error":
			// Avoid returning provider messages which may include private input.
			return Decision{}, errors.New("Codex reported a memory-turn error")
		}
	}
}

func codexValidateRequest(r Request) error {
	if r.ConversationID == "" || r.RequestID == "" || len(r.ConversationID) > 256 || len(r.RequestID) > 256 || len(r.TurnID) > 256 {
		return errors.New("Codex memory request requires bounded conversation and request IDs")
	}
	if r.Query == "" && r.Context == "" {
		return errors.New("Codex memory request has no observations")
	}
	b, err := json.Marshal(r)
	if err != nil || len(b) > 64*1024 || !utf8.ValidString(r.Query) || !utf8.ValidString(r.Context) {
		return errors.New("Codex memory observations exceed their input budget or are not UTF-8")
	}
	return nil
}

func (s *codexSession) ensureStarted(ctx context.Context) error {
	if s.ID() != "" {
		return nil
	}
	args := []string{"--no-daemon", "app-server", "--stdio"}
	for _, feature := range codexMemoryDisabled {
		args = append(args, "--disable", feature)
	}
	for _, override := range []string{
		`model_provider="openai"`, `model="gpt-6-luna"`, `service_tier="fast"`,
		`model_reasoning_effort="low"`, `sandbox_mode="read-only"`, `approval_policy="never"`,
		`web_search="disabled"`, `mcp_servers={}`, `plugins={}`, `hooks={}`,
		`project_doc_max_bytes=0`, `skills.include_instructions=false`,
		`skills.bundled.enabled=false`, `tools.update_plan.enabled=false`, `agents.enabled=false`,
	} {
		args = append(args, "-c", override)
	}
	cmd := exec.Command(s.cfg.Executable, args...)
	cmd.Dir = s.cwd
	cmd.Env = codexMemoryEnvironment()
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.WaitDelay = time.Second
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return errors.New("create Codex memory input pipe")
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return errors.New("create Codex memory output pipe")
	}
	cmd.Stderr = &s.stderr
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		_ = stdin.Close()
		_ = stdout.Close()
		return errors.New("Codex memory session is closed")
	}
	if err = cmd.Start(); err != nil {
		s.mu.Unlock()
		return fmt.Errorf("start Codex memory app-server: %w", err)
	}
	s.cmd, s.stdin = cmd, stdin
	s.events = make(chan codexRPC, 16)
	s.processDone = make(chan struct{})
	s.mu.Unlock()
	readDone := make(chan struct{})
	go s.readRPC(stdout, readDone)
	go func() {
		<-readDone
		_ = cmd.Wait()
		// Descendants must not outlive this dedicated runtime.
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		close(s.processDone)
	}()

	id, err := s.sendRequest(ctx, "initialize", map[string]any{
		"clientInfo":   map[string]any{"name": "ein-sniffer-memory", "version": "1"},
		"capabilities": map[string]any{"experimentalApi": true},
	})
	if err != nil {
		return err
	}
	if _, err = s.awaitResponse(ctx, id, nil); err != nil {
		return err
	}
	if err = s.writeRPC(ctx, map[string]any{"method": "initialized", "params": map[string]any{}}); err != nil {
		return err
	}
	// An empty TOML table can merge with existing configuration. Discover only
	// the server names through the supported configuration API and explicitly
	// disable each one before a thread (and its model/tools) can start. Never
	// retain, log, or forward the configuration values to the model.
	disabledMCP, err := s.disabledMCP(ctx)
	if err != nil {
		return err
	}
	tools := ToolDefinitions()
	for _, tool := range tools {
		tool["type"] = "function"
	}
	config := map[string]any{
		"model_provider": "openai", "model_reasoning_effort": "low", "service_tier": "fast",
		"web_search": "disabled", "mcp_servers": disabledMCP, "plugins": map[string]any{},
		"hooks": map[string]any{}, "project_doc_max_bytes": 0,
		"skills.include_instructions": false, "skills.bundled.enabled": false,
		"tools.update_plan.enabled": false, "agents.enabled": false,
	}
	for _, feature := range codexMemoryDisabled {
		config["features."+feature] = false
	}
	id, err = s.sendRequest(ctx, "thread/start", map[string]any{
		"model": Model("codex"), "modelProvider": "openai", "serviceTier": "fast",
		"allowProviderModelFallback": false, "cwd": s.cwd,
		"approvalPolicy": "never", "sandbox": "read-only", "environments": []any{},
		"ephemeral": true, "developerInstructions": SystemPrompt,
		"dynamicTools": tools, "config": config,
	})
	if err != nil {
		return err
	}
	raw, err := s.awaitResponse(ctx, id, nil)
	if err != nil {
		return err
	}
	var effective struct {
		Thread struct {
			ID string `json:"id"`
		} `json:"thread"`
		Model           string `json:"model"`
		ModelProvider   string `json:"modelProvider"`
		ReasoningEffort string `json:"reasoningEffort"`
		ServiceTier     string `json:"serviceTier"`
		ApprovalPolicy  string `json:"approvalPolicy"`
		Cwd             string `json:"cwd"`
		Sandbox         struct {
			Type          string `json:"type"`
			NetworkAccess bool   `json:"networkAccess"`
		} `json:"sandbox"`
	}
	if json.Unmarshal(raw, &effective) != nil || effective.Thread.ID == "" {
		return errors.New("Codex thread/start response is not recognized")
	}
	if effective.Model != Model("codex") || effective.ModelProvider != "openai" || effective.ReasoningEffort != "low" || effective.ServiceTier != "fast" {
		return errors.New("Codex did not confirm GPT-6 Luna, reasoning low and Fast; check the installed CLI and account model access")
	}
	if effective.ApprovalPolicy != "never" || effective.Sandbox.Type != "readOnly" || effective.Sandbox.NetworkAccess {
		return errors.New("Codex did not confirm the read-only, no-network memory sandbox")
	}
	if !filepath.IsAbs(effective.Cwd) || filepath.Clean(effective.Cwd) != s.cwd {
		return errors.New("Codex did not retain the stable memory working directory")
	}
	s.mu.Lock()
	s.threadID = effective.Thread.ID
	s.mu.Unlock()
	return nil
}

func (s *codexSession) disabledMCP(ctx context.Context) (map[string]any, error) {
	id, err := s.sendRequest(ctx, "config/read", map[string]any{"includeLayers": false, "cwd": s.cwd})
	if err != nil {
		return nil, err
	}
	raw, err := s.awaitResponse(ctx, id, nil)
	if err != nil {
		return nil, err
	}
	var doc struct {
		Config map[string]json.RawMessage `json:"config"`
	}
	if json.Unmarshal(raw, &doc) != nil || doc.Config == nil {
		return nil, errors.New("Codex could not expose the effective MCP configuration before startup")
	}
	var servers map[string]json.RawMessage
	if value := doc.Config["mcp_servers"]; len(value) != 0 && !bytes.Equal(value, []byte("null")) {
		if json.Unmarshal(value, &servers) != nil {
			return nil, errors.New("Codex effective MCP configuration is not recognized")
		}
	}
	if len(servers) > 128 {
		return nil, errors.New("Codex effective MCP configuration exceeds its budget")
	}
	disabled := make(map[string]any, len(servers))
	for name := range servers {
		if name == "" || len(name) > 256 || !utf8.ValidString(name) || strings.ContainsAny(name, "\x00\r\n") {
			return nil, errors.New("Codex MCP configuration has an invalid server name")
		}
		disabled[name] = map[string]any{"enabled": false}
	}
	return disabled, nil
}

func codexMemoryEnvironment() []string {
	env := make([]string, 0, len(os.Environ())+1)
	for _, value := range os.Environ() {
		key, _, _ := strings.Cut(value, "=")
		if !strings.HasPrefix(key, "EIN_SNIFFER_") {
			env = append(env, value)
		}
	}
	// CODEX_HOME, normal keyring access and product auth environment stay intact.
	// No credential file is read or copied by this adapter.
	return append(env, "EIN_SNIFFER_ROLE=memory-agent")
}

func (s *codexSession) readRPC(stdout io.ReadCloser, done chan<- struct{}) {
	defer close(done)
	defer stdout.Close()
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 4096), codexFrameLimit)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var event codexRPC
		if json.Unmarshal(line, &event) != nil {
			s.deliver(codexRPC{readErr: errors.New("Codex emitted invalid JSON-RPC")})
			return
		}
		event.size = len(line)
		if !s.deliver(event) {
			return
		}
	}
	err := errors.New("Codex memory app-server closed its output")
	if scanner.Err() != nil {
		err = errors.New("Codex memory output frame is invalid or exceeds its budget")
	}
	s.deliver(codexRPC{readErr: err})
}

func (s *codexSession) deliver(event codexRPC) bool {
	select {
	case s.events <- event:
		return true
	case <-s.stop:
		return false
	}
}

func (s *codexSession) next(ctx context.Context) (codexRPC, error) {
	if ctx.Err() != nil {
		return codexRPC{}, ctx.Err()
	}
	select {
	case <-ctx.Done():
		return codexRPC{}, ctx.Err()
	case <-s.stop:
		return codexRPC{}, errors.New("Codex memory session is closed")
	case event := <-s.events:
		return event, event.readErr
	}
}

func (s *codexSession) sendRequest(ctx context.Context, method string, params any) (string, error) {
	s.seq++
	id := "sniffer-" + strconv.FormatUint(s.seq, 10)
	return id, s.writeRPC(ctx, map[string]any{"id": id, "method": method, "params": params})
}

func (s *codexSession) writeRPC(ctx context.Context, value any) error {
	b, err := json.Marshal(value)
	if err != nil || len(b)+1 > codexFrameLimit {
		return errors.New("Codex memory RPC exceeds its input budget")
	}
	s.mu.Lock()
	stdin, closed := s.stdin, s.closed
	s.mu.Unlock()
	if stdin == nil || closed {
		return errors.New("Codex memory input is closed")
	}
	done := make(chan error, 1)
	go func() {
		_, err := stdin.Write(append(b, '\n'))
		done <- err
	}()
	select {
	case <-ctx.Done():
		_ = stdin.Close() // Unblock a child that stopped consuming stdin.
		return ctx.Err()
	case <-s.stop:
		return errors.New("Codex memory session is closed")
	case err := <-done:
		if err != nil {
			return errors.New("Codex memory RPC write failed")
		}
		return nil
	}
}

func (s *codexSession) awaitResponse(ctx context.Context, id string, buffered *[]codexRPC) (json.RawMessage, error) {
	total := 0
	for {
		event, err := s.next(ctx)
		if err != nil {
			return nil, err
		}
		total += event.size
		if total > codexRunLimit || s.stderr.exceeded() {
			return nil, errors.New("Codex initialization output exceeds its budget")
		}
		var replyID string
		_ = json.Unmarshal(event.ID, &replyID)
		if event.Method == "" && replyID == id {
			if event.Error != nil {
				return nil, fmt.Errorf("Codex RPC rejected the request (code %d)", event.Error.Code)
			}
			if len(event.Result) == 0 || bytes.Equal(event.Result, []byte("null")) {
				return nil, errors.New("Codex RPC response omitted its result")
			}
			return event.Result, nil
		}
		if event.Method != "" && buffered != nil {
			if len(*buffered) >= 32 {
				return nil, errors.New("Codex emitted too many events before acknowledging the turn")
			}
			*buffered = append(*buffered, event)
		} else if event.Method != "" && len(event.ID) != 0 {
			_ = s.writeRPC(ctx, map[string]any{"id": event.ID, "error": map[string]any{"code": -32601, "message": "memory initialization does not permit tool requests"}})
			return nil, errors.New("Codex requested a tool before the memory turn started")
		}
	}
}

func codexAllowedTool(name string) bool {
	return name == "memory_search" || name == "memory_read" || name == "memory_context"
}

func (s *codexSession) callTool(ctx context.Context, event codexRPC, handler ToolHandler) error {
	var call struct {
		Tool      string          `json:"tool"`
		Namespace string          `json:"namespace"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if json.Unmarshal(event.Params, &call) != nil || !codexAllowedTool(call.Tool) || call.Namespace != "" {
		_ = s.toolFailure(ctx, event.ID, "only memory_search, memory_read and memory_context are permitted")
		return errors.New("Codex attempted a non-reader memory tool")
	}
	if len(call.Arguments) > 16*1024 || !json.Valid(call.Arguments) || !bytes.HasPrefix(bytes.TrimSpace(call.Arguments), []byte("{")) {
		_ = s.toolFailure(ctx, event.ID, "invalid memory tool arguments")
		return errors.New("Codex emitted invalid memory tool arguments")
	}
	if handler == nil {
		_ = s.toolFailure(ctx, event.ID, "memory tools are unavailable")
		return errors.New("Codex memory tool handler is unavailable")
	}
	type outcome struct {
		value any
		err   error
	}
	done := make(chan outcome, 1)
	go func() {
		defer func() {
			if recover() != nil {
				done <- outcome{err: errors.New("memory tool handler failed")}
			}
		}()
		value, err := handler(ctx, call.Tool, call.Arguments)
		done <- outcome{value, err}
	}()
	var result outcome
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-s.stop:
		return errors.New("Codex memory session is closed")
	case result = <-done:
	}
	if result.err != nil {
		// Handler errors may contain internal paths. The model receives only
		// a stable bounded failure and may try a different read-only query.
		return s.toolFailure(ctx, event.ID, "memory tool could not complete this request")
	}
	b, err := json.Marshal(result.value)
	if err != nil || len(b) > codexToolLimit {
		_ = s.toolFailure(ctx, event.ID, "memory tool output exceeds its budget; use paging")
		return errors.New("Codex memory tool result exceeds its output budget")
	}
	return s.writeRPC(ctx, map[string]any{"id": event.ID, "result": map[string]any{
		"success": true, "contentItems": []map[string]any{{"type": "inputText", "text": string(b)}},
	}})
}

func (s *codexSession) toolFailure(ctx context.Context, id json.RawMessage, message string) error {
	return s.writeRPC(ctx, map[string]any{"id": id, "result": map[string]any{
		"success": false, "contentItems": []map[string]any{{"type": "inputText", "text": message}},
	}})
}

func codexInspectItem(raw json.RawMessage) (string, error) {
	var item struct {
		Type      string `json:"type"`
		Text      string `json:"text"`
		Tool      string `json:"tool"`
		Namespace string `json:"namespace"`
	}
	if json.Unmarshal(raw, &item) != nil {
		return "", errors.New("Codex emitted an invalid memory item")
	}
	switch item.Type {
	case "agentMessage":
		return item.Text, nil
	case "userMessage", "reasoning", "contextCompaction":
		return "", nil
	case "dynamicToolCall":
		if codexAllowedTool(item.Tool) && item.Namespace == "" {
			return "", nil
		}
	}
	return "", errors.New("Codex attempted a native or non-reader tool in the memory session")
}

func (s *codexSession) updateUsage(raw json.RawMessage) error {
	var event struct {
		TokenUsage struct {
			Total struct {
				Input      int64 `json:"inputTokens"`
				Output     int64 `json:"outputTokens"`
				Cached     int64 `json:"cachedInputTokens"`
				CacheWrite int64 `json:"cacheWriteInputTokens"`
			} `json:"total"`
		} `json:"tokenUsage"`
	}
	if json.Unmarshal(raw, &event) != nil {
		return errors.New("Codex emitted invalid token usage")
	}
	u := event.TokenUsage.Total
	if u.Input < 0 || u.Output < 0 || u.Cached < 0 || u.CacheWrite < 0 {
		return errors.New("Codex emitted negative token usage")
	}
	s.mu.Lock()
	s.usage = Usage{InputTokens: u.Input, OutputTokens: u.Output, CacheReadTokens: u.Cached, CacheCreationTokens: u.CacheWrite}
	s.mu.Unlock()
	return nil
}

// Close is safe concurrently with Run and is idempotent. A failed or canceled
// Session is terminal; callers create a new one and explicitly reseed context.
func (s *codexSession) Close() error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	close(s.stop)
	cmd, stdin, done := s.cmd, s.stdin, s.processDone
	s.mu.Unlock()
	if stdin != nil {
		_ = stdin.Close()
	}
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)
	select {
	case <-done:
		return nil
	case <-time.After(500 * time.Millisecond):
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
	select {
	case <-done:
		return nil
	case <-time.After(time.Second):
		return errors.New("Codex memory process did not exit after cancellation")
	}
}

type codexBoundedDiagnostics struct {
	mu       sync.Mutex
	bytes    int
	overflow bool
}

// Count stderr without retaining text that may contain account or prompt data.
func (b *codexBoundedDiagnostics) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(p) > 32*1024-b.bytes {
		b.bytes = 32 * 1024
		b.overflow = true
	} else {
		b.bytes += len(p)
	}
	return len(p), nil
}

func (b *codexBoundedDiagnostics) exceeded() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.overflow
}
