package native

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func agyTestConfig(t *testing.T, mode string) (Config, string) {
	t.Helper()
	dir := t.TempDir()
	bin, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	launcher := filepath.Join(dir, "fake-agy")
	contents := "#!/bin/sh\nSNIFFER_TEST_AGY_HELPER=1 exec " + agyShellQuote(bin) + " -test.run='^TestAGYHelperProcess$' -- \"$@\"\n"
	if err = os.WriteFile(launcher, []byte(contents), 0700); err != nil {
		t.Fatal(err)
	}
	log := filepath.Join(dir, "events.jsonl")
	t.Setenv("SNIFFER_TEST_AGY_LOG", log)
	t.Setenv("SNIFFER_TEST_AGY_MODE", mode)
	t.Setenv("EIN_SNIFFER_WORKER_TOKEN", "must-not-reach-memory-agent")
	t.Setenv("AGY_TEST_AUTH_SENTINEL", "inherited-without-reading-credentials")
	return Config{Host: "agy", Executable: launcher, SnifferExecutable: "true", EinHome: filepath.Join(dir, "ein"), RuntimeDir: dir, ProjectID: "project-a"}, log
}

func TestAGYTwoTurnsUseOneProcessAndConversation(t *testing.T) {
	cfg, log := agyTestConfig(t, "normal")
	s, err := NewAGY(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	request := Request{ConversationID: "main-a", RequestID: "request-1", Query: "인증 정책", Context: "먼저 프로젝트 인증 방식을 검토했다."}
	first, err := s.Run(context.Background(), request, nil)
	if err != nil {
		t.Fatal(err)
	}
	id := s.ID()
	request.RequestID, request.Query = "request-2", "앞서 말한 정책을 다시 확인해줘"
	second, err := s.Run(context.Background(), request, nil)
	if err != nil {
		t.Fatal(err)
	}
	if first.Decision != "none" || second.Decision != "none" || id == "" || s.ID() != id {
		t.Fatalf("two turns did not preserve one session: %q %q %#v %#v", id, s.ID(), first, second)
	}
	u := s.Usage()
	if u.InputTokens != 200 || u.OutputTokens != 20 || u.CacheReadTokens != 30 {
		t.Fatalf("usage must use cumulative deltas, got %#v", u)
	}
	starts, prompts := 0, 0
	for _, entry := range agyReadLog(t, log) {
		switch entry["kind"] {
		case "start":
			starts++
		case "prompt":
			prompts++
		}
	}
	if starts != 1 || prompts != 2 {
		t.Fatalf("expected one start and two prompts, got %d and %d", starts, prompts)
	}
}

func TestAGYRejectsUntrustedInitBeforeSendingObservation(t *testing.T) {
	for _, mode := range []string{"wrong-model", "extra-tool", "missing-reader", "wrong-agent", "unsafe-permissions"} {
		t.Run(mode, func(t *testing.T) {
			cfg, log := agyTestConfig(t, mode)
			s, err := NewAGY(cfg)
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			_, err = s.Run(context.Background(), Request{ConversationID: "main-a", RequestID: "request-1", Query: "private memory"}, nil)
			if err == nil {
				t.Fatal("unexpected init was accepted")
			}
			for _, entry := range agyReadLog(t, log) {
				if entry["kind"] == "prompt" {
					t.Fatal("private observation was sent before validating init")
				}
			}
		})
	}
}

func TestAGYCancellationRestartsWithExplicitObservationSeed(t *testing.T) {
	cfg, log := agyTestConfig(t, "normal")
	s, err := NewAGY(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	base := Request{ConversationID: "main-a", RequestID: "request-1", Query: "previous completed observation"}
	if _, err = s.Run(context.Background(), base, nil); err != nil {
		t.Fatal(err)
	}
	oldID := s.ID()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := s.Run(ctx, Request{ConversationID: "main-a", RequestID: "request-2", Query: "hang"}, nil)
		done <- err
	}()
	agyWaitForPrompt(t, log, "request-2")
	cancel()
	select {
	case err = <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancellation was lost: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("canceled agy process did not stop")
	}
	if _, err = s.Run(context.Background(), Request{ConversationID: "main-a", RequestID: "request-3", Query: "expect-recovery"}, nil); err != nil {
		t.Fatal(err)
	}
	if s.ID() == oldID || s.ID() == "" {
		t.Fatal("interrupted process must create an explicitly new conversation")
	}
	if s.Usage().InputTokens != 200 {
		t.Fatalf("restart usage delta incorrect: %#v", s.Usage())
	}
	starts := 0
	for _, entry := range agyReadLog(t, log) {
		if entry["kind"] == "start" {
			starts++
		}
		if entry["request_id"] == "request-3" && entry["reseed"] != true {
			t.Fatal("restart silently discarded context instead of explicit reseed")
		}
	}
	if starts != 2 {
		t.Fatalf("expected exactly two process starts, got %d", starts)
	}
}

func TestAGYCloseInterruptsRunningTurnAndRemovesPrivateRuntime(t *testing.T) {
	cfg, log := agyTestConfig(t, "normal")
	api, err := NewAGY(cfg)
	if err != nil {
		t.Fatal(err)
	}
	s := api.(*agySession)
	done := make(chan error, 1)
	go func() {
		_, err := s.Run(context.Background(), Request{ConversationID: "main-a", RequestID: "hanging", Query: "hang"}, nil)
		done <- err
	}()
	agyWaitForPrompt(t, log, "hanging")
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("closed running turn unexpectedly succeeded")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Close left the running turn blocked")
	}
	if _, err = os.Stat(s.dir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("private runtime was not removed: %v", err)
	}
	if _, err = s.Run(context.Background(), Request{ConversationID: "main-a", RequestID: "later", Query: "later"}, nil); err == nil {
		t.Fatal("closed session accepted a new run")
	}
}

func TestAGYRejectsUnexpectedToolAndChangedConversation(t *testing.T) {
	for _, mode := range []string{"tool-event", "changed-conversation", "changed-model", "bad-decision"} {
		t.Run(mode, func(t *testing.T) {
			cfg, _ := agyTestConfig(t, mode)
			s, err := NewAGY(cfg)
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			if _, err = s.Run(context.Background(), Request{ConversationID: "main-a", RequestID: "request", Query: "check"}, nil); err == nil {
				t.Fatal("unexpected tool, identity, model or decision was accepted")
			}
		})
	}
}

func TestAGYBindsMainConversationAndProtectsGuardConfiguration(t *testing.T) {
	cfg, _ := agyTestConfig(t, "normal")
	s, err := NewAGY(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err = s.Run(context.Background(), Request{ConversationID: "main-a", RequestID: "first", Query: "one"}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Run(context.Background(), Request{ConversationID: "main-b", RequestID: "second", Query: "two"}, nil); err == nil {
		t.Fatal("sidecar crossed the main-conversation boundary")
	}
	a := s.(*agySession)
	hooks, err := os.ReadFile(filepath.Join(a.dir, ".agents", "hooks.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(hooks), "agent-guard agy") || !strings.Contains(string(hooks), "PreToolUse") {
		t.Fatal("read-only policy needs the actual pre-execution guard, not only output observation")
	}
	for _, path := range []string{a.contextPath, a.schemaPath, filepath.Join(a.dir, ".agents", "mcp_config.json")} {
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm() != 0600 {
			t.Fatalf("runtime file is not private: %s %v", path, err)
		}
	}
}

// The child implements the documented native protocol. It checks actual flags,
// runtime setup, environment, snapshots, multiple stdin prompts and usage.
func TestAGYHelperProcess(t *testing.T) {
	if os.Getenv("SNIFFER_TEST_AGY_HELPER") != "1" {
		return
	}
	fail := func(message string) {
		_, _ = fmt.Fprintln(os.Stderr, message)
		os.Exit(7)
	}
	args := os.Args
	for len(args) > 0 && args[0] != "--" {
		args = args[1:]
	}
	if len(args) == 0 {
		fail("missing argument boundary")
	}
	args = args[1:]
	flags := map[string]string{}
	for i := 0; i < len(args); i++ {
		if args[i] == "--disable-slash-commands" {
			flags[args[i]] = "true"
			continue
		}
		if i+1 >= len(args) {
			fail("missing flag value")
		}
		flags[args[i]], i = args[i+1], i+1
	}
	if flags["--model"] != Model("agy") || flags["--agent"] != agyAgentName || flags["--input-format"] != "stream-json" || flags["--output-format"] != "stream-json" || flags["--disable-slash-commands"] != "true" || flags["--mode"] != "plan" {
		fail("native agy flags differ from policy")
	}
	if os.Getenv("EIN_SNIFFER_ROLE") != "memory-agent" || os.Getenv("EIN_SNIFFER_PROJECT_ID") != "project-a" || os.Getenv("EIN_SNIFFER_WORKER_TOKEN") != "" || os.Getenv("AGY_TEST_AUTH_SENTINEL") == "" {
		fail("role or authentication environment was not preserved correctly")
	}
	cwd, _ := os.Getwd()
	contextPath := filepath.Join(cwd, "context.json")
	contextBytes, err := os.ReadFile(contextPath)
	if err != nil || strings.TrimSpace(string(contextBytes)) != "{}" {
		fail("private observation arrived before init was checked")
	}
	agent, err := os.ReadFile(filepath.Join(cwd, ".agents", "agents", agyAgentName+".md"))
	if err != nil || !strings.Contains(string(agent), SystemPrompt) || !strings.Contains(string(agent), "tools: []") || !strings.Contains(string(agent), "inheritCustomizations: true") {
		fail("dedicated agent or runtime guard inheritance is missing")
	}
	mcpBytes, err := os.ReadFile(filepath.Join(cwd, ".agents", "mcp_config.json"))
	var mcp struct {
		Servers map[string]struct {
			Args    []string       `json:"args"`
			Enabled []string       `json:"enabledTools"`
			Tools   map[string]any `json:"tools"`
		} `json:"mcpServers"`
	}
	if err != nil || json.Unmarshal(mcpBytes, &mcp) != nil {
		fail("MCP setup missing")
	}
	reader := mcp.Servers[agyServerName]
	if len(mcp.Servers) != 1 || len(reader.Enabled) != 3 || len(reader.Tools) != 3 || !strings.Contains(strings.Join(reader.Args, " "), "mcp --role agent-reader --project project-a --context-file ") {
		fail("MCP reader is not strictly role/project bound")
	}
	logPath := os.Getenv("SNIFFER_TEST_AGY_LOG")
	logEntry := func(value map[string]any) {
		f, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
		if err != nil {
			fail("cannot log helper events")
		}
		_ = json.NewEncoder(f).Encode(value)
		_ = f.Close()
	}
	logEntry(map[string]any{"kind": "start", "pid": os.Getpid(), "cwd": cwd})
	mode := os.Getenv("SNIFFER_TEST_AGY_MODE")
	id := "agy-" + strconv.Itoa(os.Getpid())
	tools := []string{"mcp_sniffer_memory_search", "mcp_sniffer_memory_read", "mcp_sniffer_memory_context", "send_message", "ask_permission"}
	model, agentName, permission := Model("agy"), agyAgentName, "request-review"
	switch mode {
	case "wrong-model":
		model = "other-model"
	case "extra-tool":
		tools = append(tools, "run_command")
	case "missing-reader":
		tools = tools[1:]
	case "wrong-agent":
		agentName = "general-agent"
	case "unsafe-permissions":
		permission = "always-proceed"
	}
	enc := json.NewEncoder(os.Stdout)
	_ = enc.Encode(map[string]any{"event": "init", "conversation_id": id, "init": map[string]any{"cwd": cwd, "model": model, "agent": agentName, "permission_mode": permission, "tools": tools}})
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4096), 512*1024)
	turn := 0
	for scanner.Scan() {
		turn++
		var message struct {
			Event   string `json:"event"`
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		}
		if json.Unmarshal(scanner.Bytes(), &message) != nil || message.Event != "user" {
			fail("bad user event")
		}
		_, observation, ok := strings.Cut(message.Message.Content, "CURRENT_OBSERVATION_JSON\n")
		if !ok {
			fail("missing observation envelope")
		}
		var request, onDisk Request
		if json.Unmarshal([]byte(observation), &request) != nil {
			fail("invalid observation")
		}
		b, err := os.ReadFile(contextPath)
		if err != nil || json.Unmarshal(b, &onDisk) != nil || onDisk != request {
			fail("MCP context snapshot was not updated before the prompt")
		}
		reseed := strings.HasPrefix(message.Message.Content, "RECOVERY_SEED_JSON\n")
		logEntry(map[string]any{"kind": "prompt", "request_id": request.RequestID, "reseed": reseed, "turn": turn})
		if request.Query == "hang" {
			for {
				time.Sleep(time.Hour)
			}
		}
		if request.Query == "expect-recovery" && (!reseed || !strings.Contains(message.Message.Content, `"query":"hang"`) || !strings.Contains(message.Message.Content, "previous completed observation")) {
			fail("interruption lost earlier observations without reseed")
		}
		if mode == "tool-event" {
			_ = enc.Encode(map[string]any{"event": "step_update", "step_update": map[string]any{"conversation_id": id, "step_type": "tool", "tool_name": "write_to_file", "state": "ACTIVE"}})
		}
		resultID := id
		if mode == "changed-conversation" {
			resultID = "other-conversation"
		}
		decision := map[string]any{"decision": "none", "references": []any{}, "reason": "Nothing useful in this fictional fixture."}
		if mode == "bad-decision" {
			decision["decision"] = "inject"
		}
		result := map[string]any{
			"conversation_id": resultID, "status": "SUCCESS", "structured_output": decision,
			"num_turns": turn, "usage": map[string]any{"input_tokens": 100 * turn, "output_tokens": 10 * turn, "cache_read_tokens": 30 * (turn - 1)},
		}
		if mode == "changed-model" {
			result["model"] = "other-model"
		}
		_ = enc.Encode(map[string]any{"event": "result", "result": result})
	}
	os.Exit(0)
}

func agyReadLog(t *testing.T, path string) []map[string]any {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var result []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		if line == "" {
			continue
		}
		var entry map[string]any
		if json.Unmarshal([]byte(line), &entry) != nil {
			t.Fatalf("invalid helper log: %q", line)
		}
		result = append(result, entry)
	}
	return result
}

func agyWaitForPrompt(t *testing.T, path, requestID string) {
	t.Helper()
	deadline := time.NewTimer(3 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(5 * time.Millisecond)
	defer tick.Stop()
	for {
		b, _ := os.ReadFile(path)
		if strings.Contains(string(b), `"request_id":"`+requestID+`"`) {
			return
		}
		select {
		case <-deadline.C:
			t.Fatal("fake agy did not receive prompt")
		case <-tick.C:
		}
	}
}
