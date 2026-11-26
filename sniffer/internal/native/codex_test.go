package native

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

const codexTestRevision = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func codexFakeSession(t *testing.T, mode string) (Session, string) {
	t.Helper()
	dir := t.TempDir()
	log := filepath.Join(dir, "protocol.jsonl")
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	script := filepath.Join(dir, "codex-fake")
	quoted := "'" + strings.ReplaceAll(binary, "'", "'\\''") + "'"
	if err = os.WriteFile(script, []byte("#!/bin/sh\nexec "+quoted+" -test.run='^TestCodexProtocolHelper$' -- \"$@\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("EIN_TEST_CODEX_HELPER", "1")
	t.Setenv("EIN_TEST_CODEX_MODE", mode)
	t.Setenv("EIN_TEST_CODEX_LOG", log)
	// Race instrumentation remains enabled; only its child-process exit sleep
	// is removed so protocol shutdown tests measure the adapter's cleanup.
	t.Setenv("GORACE", strings.TrimSpace(os.Getenv("GORACE"))+" atexit_sleep_ms=0")
	t.Setenv("EIN_TEST_NORMAL_AUTH_MARKER", "kept-without-reading-credentials")
	t.Setenv("EIN_SNIFFER_WORKER_SECRET", "must-not-reach-child")
	t.Setenv("CODEX_HOME", filepath.Join(dir, "normal-codex-home"))
	s, err := NewCodex(Config{Host: "codex", Executable: script, RuntimeDir: filepath.Join(dir, "stable-runtime")})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s, log
}

func codexRequest(query string) Request {
	return Request{ConversationID: "main-one", RequestID: "request-" + query, TurnID: "parent-turn", Query: query, Context: "Current main-session observations only"}
}

func codexTestHandler(ctx context.Context, name string, args json.RawMessage) (any, error) {
	if name != "memory_search" {
		return nil, errors.New("unexpected test tool")
	}
	var q struct{ Query string }
	if err := json.Unmarshal(args, &q); err != nil || q.Query == "" {
		return nil, errors.New("bad search query")
	}
	return map[string]any{"memories": []Reference{{ID: "m-example", Revision: codexTestRevision}}}, nil
}

func TestCodexPersistentThreadAndCustomSearch(t *testing.T) {
	s, log := codexFakeSession(t, "normal")
	if _, err := os.Stat(log); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("constructor eagerly started the CLI")
	}
	var calls int
	for _, query := range []string{"first", "second"} {
		decision, err := s.Run(context.Background(), codexRequest(query), func(ctx context.Context, name string, args json.RawMessage) (any, error) {
			calls++
			return codexTestHandler(ctx, name, args)
		})
		if err != nil {
			t.Fatal(err)
		}
		if decision.Decision != "inject" || len(decision.References) != 1 || decision.References[0].ID != "m-example" {
			t.Fatalf("unexpected decision: %+v", decision)
		}
		if s.ID() != "memory-thread" {
			t.Fatalf("unexpected thread %q", s.ID())
		}
	}
	if calls != 2 {
		t.Fatalf("search callback count %d", calls)
	}
	usage := s.Usage()
	if usage.InputTokens != 200 || usage.CacheReadTokens != 140 || usage.OutputTokens != 20 || usage.CacheCreationTokens != 4 {
		t.Fatalf("usage not accumulated from provider total: %+v", usage)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(log)
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	if strings.Count(text, `"method":"process"`) != 1 || strings.Count(text, `"method":"thread/start"`) != 1 || strings.Count(text, `"method":"turn/start"`) != 2 {
		t.Fatalf("process/thread was not retained: %s", text)
	}
	if !strings.Contains(text, `"model":"gpt-6-luna"`) || !strings.Contains(text, `"effort":"low"`) || !strings.Contains(text, `"serviceTier":"fast"`) {
		t.Fatal("pinned model/effort/service tier not sent")
	}
	if strings.Contains(text, "must-not-reach-child") || strings.Contains(text, "MCP_CREDENTIAL_NOT_FOR_MODEL") || strings.Contains(text, `"candidates"`) {
		t.Fatal("worker/MCP secret or precomputed candidates reached child")
	}
}

func TestCodexRejectsWriterAndNativeTools(t *testing.T) {
	for _, mode := range []string{"writer", "namespace", "native-write", "approval"} {
		t.Run(mode, func(t *testing.T) {
			s, _ := codexFakeSession(t, mode)
			var called atomic.Int32
			_, err := s.Run(context.Background(), codexRequest("denied"), func(context.Context, string, json.RawMessage) (any, error) {
				called.Add(1)
				return nil, nil
			})
			if err == nil || called.Load() != 0 {
				t.Fatalf("forbidden tool reached handler or was accepted: err=%v called=%d", err, called.Load())
			}
		})
	}
}

func TestCodexRefusesDriftBeforeModelTurn(t *testing.T) {
	for _, mode := range []string{"model-drift", "tier-drift", "sandbox-drift", "effort-missing"} {
		t.Run(mode, func(t *testing.T) {
			s, log := codexFakeSession(t, mode)
			_, err := s.Run(context.Background(), codexRequest("first"), codexTestHandler)
			if err == nil {
				t.Fatal("effective settings drift accepted")
			}
			data, _ := os.ReadFile(log)
			if strings.Contains(string(data), `"method":"turn/start"`) {
				t.Fatal("sent observations before validating effective settings")
			}
		})
	}
}

func TestCodexCancellationInterruptsAndTerminatesSession(t *testing.T) {
	s, log := codexFakeSession(t, "normal")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	toolStarted := make(chan struct{})
	go func() {
		_, err := s.Run(ctx, codexRequest("cancel"), func(ctx context.Context, _ string, _ json.RawMessage) (any, error) {
			close(toolStarted)
			<-ctx.Done()
			return nil, ctx.Err()
		})
		done <- err
	}()
	select {
	case <-toolStarted:
	case <-time.After(3 * time.Second):
		t.Fatal("fake CLI did not start its tool call")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("expected cancellation, got %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("cancellation did not terminate the process")
	}
	if _, err := s.Run(context.Background(), codexRequest("later"), codexTestHandler); err == nil {
		t.Fatal("canceled Session was reused without explicit reseeding")
	}
	data, _ := os.ReadFile(log)
	if !strings.Contains(string(data), `"method":"turn/interrupt"`) {
		t.Fatal("active turn was not interrupted")
	}
}

func TestCodexRejectsInvalidDecisionAndProtocolFailures(t *testing.T) {
	for _, mode := range []string{"invalid-decision", "crash", "oversize", "runtime-model-drift"} {
		t.Run(mode, func(t *testing.T) {
			s, _ := codexFakeSession(t, mode)
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			if _, err := s.Run(ctx, codexRequest("first"), codexTestHandler); err == nil {
				t.Fatal("invalid output or failed CLI was accepted")
			}
		})
	}
}

func TestCodexBindsMainConversation(t *testing.T) {
	s, _ := codexFakeSession(t, "normal")
	if _, err := s.Run(context.Background(), codexRequest("first"), codexTestHandler); err != nil {
		t.Fatal(err)
	}
	other := codexRequest("second")
	other.ConversationID = "another-main"
	if _, err := s.Run(context.Background(), other, codexTestHandler); err == nil {
		t.Fatal("another main conversation reused the memory session")
	}
}

func TestCodexProtocolHelper(t *testing.T) {
	if os.Getenv("EIN_TEST_CODEX_HELPER") != "1" {
		return
	}
	// Let Close's EOF drain the already-written interrupt before exiting.
	signal.Ignore(syscall.SIGTERM)
	log, err := os.OpenFile(os.Getenv("EIN_TEST_CODEX_LOG"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		os.Exit(60)
	}
	defer log.Close()
	trace := json.NewEncoder(log)
	output := json.NewEncoder(os.Stdout)
	emit := func(v any) { _ = output.Encode(v) }
	mode := os.Getenv("EIN_TEST_CODEX_MODE")
	if os.Getenv("EIN_SNIFFER_ROLE") != "memory-agent" || os.Getenv("EIN_SNIFFER_WORKER_SECRET") != "" || os.Getenv("EIN_TEST_NORMAL_AUTH_MARKER") == "" || os.Getenv("CODEX_HOME") == "" {
		os.Exit(61)
	}
	args := strings.Join(os.Args, " ")
	for _, required := range []string{"--no-daemon app-server --stdio", "--disable shell_tool", "--disable hooks", `sandbox_mode="read-only"`, `mcp_servers={}`} {
		if !strings.Contains(args, required) {
			os.Exit(62)
		}
	}
	cwd, _ := os.Getwd()
	_ = trace.Encode(map[string]any{"method": "process", "pid": os.Getpid(), "cwd": cwd})
	threadCount, turns := 0, 0
	initialized, ready := false, false
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4096), codexFrameLimit)
	for scanner.Scan() {
		var rpc struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
			Result json.RawMessage `json:"result"`
		}
		if json.Unmarshal(scanner.Bytes(), &rpc) != nil {
			os.Exit(63)
		}
		_, _ = log.Write(append(append([]byte(nil), scanner.Bytes()...), '\n'))
		reply := func(v any) { emit(map[string]any{"id": rpc.ID, "result": v}) }
		switch rpc.Method {
		case "initialize":
			var params struct {
				Capabilities struct {
					ExperimentalAPI bool `json:"experimentalApi"`
				} `json:"capabilities"`
			}
			_ = json.Unmarshal(rpc.Params, &params)
			if !params.Capabilities.ExperimentalAPI {
				os.Exit(64)
			}
			initialized = true
			reply(map[string]any{"userAgent": "fake-codex"})
		case "initialized":
			ready = initialized
		case "config/read":
			reply(map[string]any{"config": map[string]any{"mcp_servers": map[string]any{
				"writer":            map[string]any{"enabled": true, "bearer_token": "MCP_CREDENTIAL_NOT_FOR_MODEL"},
				"writer.connection": map[string]any{"command": "must-not-run"},
			}}, "origins": map[string]any{}})
		case "thread/start":
			threadCount++
			var params struct {
				Model        string           `json:"model"`
				Instructions string           `json:"developerInstructions"`
				DynamicTools []map[string]any `json:"dynamicTools"`
				Fallback     bool             `json:"allowProviderModelFallback"`
				Cwd          string           `json:"cwd"`
				Environments []any            `json:"environments"`
				Config       struct {
					MCPServers map[string]struct {
						Enabled *bool `json:"enabled"`
					} `json:"mcp_servers"`
				} `json:"config"`
			}
			_ = json.Unmarshal(rpc.Params, &params)
			if !ready || threadCount != 1 || params.Model != Model("codex") || params.Instructions != SystemPrompt || params.Fallback || params.Cwd != cwd || params.Environments == nil || len(params.Environments) != 0 || len(params.DynamicTools) != 3 {
				os.Exit(65)
			}
			for _, tool := range params.DynamicTools {
				if tool["type"] != "function" || !codexAllowedTool(fmt.Sprint(tool["name"])) {
					os.Exit(66)
				}
			}
			for _, name := range []string{"writer", "writer.connection"} {
				server, ok := params.Config.MCPServers[name]
				if !ok || server.Enabled == nil || *server.Enabled {
					os.Exit(69)
				}
			}
			result := map[string]any{"thread": map[string]any{"id": "memory-thread"}, "cwd": cwd, "model": Model("codex"), "modelProvider": "openai", "reasoningEffort": "low", "serviceTier": "fast", "approvalPolicy": "never", "sandbox": map[string]any{"type": "readOnly", "networkAccess": false}}
			switch mode {
			case "model-drift":
				result["model"] = "other-model"
			case "tier-drift":
				result["serviceTier"] = "default"
			case "sandbox-drift":
				result["sandbox"] = map[string]any{"type": "dangerFullAccess"}
			case "effort-missing":
				delete(result, "reasoningEffort")
			}
			reply(result)
		case "turn/start":
			turns++
			turn := "turn-" + strconv.Itoa(turns)
			if turns > 1 { // Late completion from the previous turn must not win.
				emit(map[string]any{"method": "turn/completed", "params": map[string]any{"threadId": "memory-thread", "turn": map[string]any{"id": "turn-1", "status": "failed", "items": []any{}}}})
			}
			reply(map[string]any{"turn": map[string]any{"id": turn, "status": "inProgress", "items": []any{}}})
			if mode == "wait" {
				continue
			}
			if mode == "crash" {
				os.Exit(67)
			}
			if mode == "oversize" {
				fmt.Println(strings.Repeat("x", codexFrameLimit+1))
				continue
			}
			if mode == "runtime-model-drift" {
				emit(map[string]any{"method": "model/rerouted", "params": map[string]any{"threadId": "memory-thread", "turnId": turn, "toModel": "other-model"}})
				continue
			}
			if mode == "native-write" {
				emit(map[string]any{"method": "item/started", "params": map[string]any{"threadId": "memory-thread", "turnId": turn, "item": map[string]any{"type": "fileChange", "id": "forbidden-edit"}}})
				continue
			}
			if mode == "approval" {
				emit(map[string]any{"id": turns + 1000, "method": "item/fileChange/requestApproval", "params": map[string]any{"threadId": "memory-thread", "turnId": turn}})
				continue
			}
			tool := "memory_search"
			namespace := ""
			if mode == "writer" {
				tool = "memory_save"
			}
			if mode == "namespace" {
				namespace = "untrusted"
			}
			emit(map[string]any{"id": turns + 1000, "method": "item/tool/call", "params": map[string]any{"threadId": "memory-thread", "turnId": turn, "callId": "search-" + turn, "tool": tool, "namespace": namespace, "arguments": map[string]any{"query": "session-derived Korean English search", "limit": 5}}})
		case "turn/interrupt":
			reply(map[string]any{})
		case "":
			var response struct {
				Success bool `json:"success"`
				Items   []struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"contentItems"`
			}
			if json.Unmarshal(rpc.Result, &response) != nil || !response.Success {
				continue
			}
			if len(response.Items) != 1 || response.Items[0].Type != "inputText" || !strings.Contains(response.Items[0].Text, "m-example") {
				os.Exit(68)
			}
			turn := "turn-" + strconv.Itoa(turns)
			decision := `{"decision":"inject","references":[{"id":"m-example","revision":"` + codexTestRevision + `"}],"reason":"Relevant to the current task"}`
			if mode == "invalid-decision" {
				decision = `{"decision":"inject","references":[],"reason":"invalid"}`
			}
			item := map[string]any{"type": "agentMessage", "id": "answer-" + turn, "text": decision, "phase": "final_answer"}
			emit(map[string]any{"method": "item/completed", "params": map[string]any{"threadId": "memory-thread", "turnId": turn, "item": item}})
			emit(map[string]any{"method": "thread/tokenUsage/updated", "params": map[string]any{"threadId": "memory-thread", "turnId": turn, "tokenUsage": map[string]any{"total": map[string]any{"inputTokens": turns * 100, "outputTokens": turns * 10, "cachedInputTokens": turns * 70, "cacheWriteInputTokens": turns * 2}}}})
			emit(map[string]any{"method": "turn/completed", "params": map[string]any{"threadId": "memory-thread", "turn": map[string]any{"id": turn, "status": "completed", "items": []any{item}}}})
		}
	}
	os.Exit(0)
}
