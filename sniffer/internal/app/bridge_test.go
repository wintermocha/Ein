package app

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"ein.local/sniffer/internal/config"
	"ein.local/sniffer/internal/native"
	"ein.local/sniffer/internal/recall"
	"ein.local/sniffer/internal/store"
)

func bridgeCall(t *testing.T, p config.Paths, op string, in any) (map[string]any, error) {
	t.Helper()
	raw, _ := json.Marshal(in)
	var out, errout bytes.Buffer
	err := Run([]string{"--home", p.Home, "bridge", op}, bytes.NewReader(raw), &out, &errout)
	value := map[string]any{}
	if err == nil {
		if e := json.Unmarshal(out.Bytes(), &value); e != nil {
			t.Fatalf("bridge output: %s %v", out.String(), e)
		}
	}
	return value, err
}

func TestBridgeNativeAgentChoosesSearchAndMainAloneWrites(t *testing.T) {
	p, project, m := fixture(t)
	before, _ := store.New(p.Store, p.State).Snapshot(context.Background())
	binding := recall.Binding{Host: "claude", ConversationID: "main-one", Cwd: project, TurnID: "turn-one", EventID: "event-one"}
	begin, err := bridgeCall(t, p, "begin", recall.BeginInput{Binding: binding, Query: "어제 정한 값이 뭐였지?", Context: "The current main session is working on the development server."})
	if err != nil {
		t.Fatal(err)
	}
	binding.RequestID = begin["request_id"].(string)
	input := bridgeInput{Binding: binding, Name: "memory_search", Arguments: json.RawMessage(`{"query":"development port"}`)}
	found, err := bridgeCall(t, p, "tool", input)
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(found)
	if !bytes.Contains(encoded, []byte(m.ID)) {
		t.Fatalf("agent-chosen query was gated by initial user wording: %s", encoded)
	}
	input.Name = "memory_save"
	input.Arguments = json.RawMessage(`{}`)
	if _, err = bridgeCall(t, p, "tool", input); err == nil {
		t.Fatal("read-only agent exposed save")
	}
	decision := native.Decision{Decision: "inject", References: []native.Reference{{ID: m.ID, Revision: m.Revision}}, Reason: "Fictional fixture relevance"}
	result, err := bridgeCall(t, p, "complete", bridgeInput{Binding: binding, Decision: decision})
	if err != nil {
		t.Fatal(err)
	}
	if result["status"] != "claimed" || !strings.Contains(result["context"].(string), "4317") {
		t.Fatalf("bad delivery: %v", result)
	}
	if _, err = bridgeCall(t, p, "ack", bridgeInput{Binding: binding, DeliveryID: result["delivery_id"].(string), Epoch: int(result["epoch"].(float64)), Outcome: "emitted"}); err != nil {
		t.Fatal(err)
	}
	after, _ := store.New(p.Store, p.State).Snapshot(context.Background())
	if after.Commit != before.Commit {
		t.Fatal("reader changed Git")
	}
	markdown := "---\nschema_version: 1\nid: m-main-only\nscope: project:app\ndescription: Fictional main-requested memory\n---\nOnly the main LLM requests this save.\n"
	// The supported YAML key is scope_id, matching the public storage schema.
	markdown = strings.Replace(markdown, "scope:", "scope_id:", 1)
	args, _ := json.Marshal(map[string]any{"markdown": markdown, "if_revision": "new", "request_id": "main-write-one"})
	writer := bridgeInput{Binding: binding, Role: "main", AgentID: "sniffer-agent", Name: "memory_save", Arguments: args}
	if _, err = bridgeCall(t, p, "write", writer); err == nil {
		t.Fatal("subagent used main writer")
	}
	writer.AgentID = ""
	writer.Role = "memory-agent"
	if _, err = bridgeCall(t, p, "write", writer); err == nil {
		t.Fatal("reader role wrote memory")
	}
	writer.Role = "main"
	if _, err = bridgeCall(t, p, "write", writer); err != nil {
		t.Fatal(err)
	}
	after, _ = store.New(p.Store, p.State).Snapshot(context.Background())
	if after.Commit == before.Commit {
		t.Fatal("main writer did not commit")
	}
}

func TestBridgeStaleCancelCannotResetNewGeneration(t *testing.T) {
	p, project, m := fixture(t)
	b := recall.Binding{Host: "claude", ConversationID: "same-session", Cwd: project, TurnID: "one", EventID: "one"}
	first, e := bridgeCall(t, p, "begin", recall.BeginInput{Binding: b, Query: "port"})
	if e != nil {
		t.Fatal(e)
	}
	b.RequestID = first["request_id"].(string)
	old := b
	b.TurnID = "two"
	b.EventID = "two"
	b.RequestID = ""
	second, e := bridgeCall(t, p, "begin", recall.BeginInput{Binding: b, Query: "development port"})
	if e != nil {
		t.Fatal(e)
	}
	b.RequestID = second["request_id"].(string)
	for _, op := range []string{"cancel", "reset"} {
		r, e := bridgeCall(t, p, op, bridgeInput{Binding: old})
		if e != nil || r["status"] != "stale" {
			t.Fatalf("%s: %v %v", op, r, e)
		}
	}
	r, e := bridgeCall(t, p, "complete", bridgeInput{Binding: b, Decision: native.Decision{Decision: "inject", References: []native.Reference{{ID: m.ID, Revision: m.Revision}}, Reason: "current"}})
	if e != nil || r["status"] != "claimed" || r["epoch"] != second["epoch"] {
		t.Fatalf("old cancellation affected new generation: %v %v", r, e)
	}
}

func TestMemoryAgentProcessRoleAndAGYPreExecutionGuard(t *testing.T) {
	p, _, _ := fixture(t)
	t.Setenv("EIN_SNIFFER_ROLE", "memory-agent")
	for _, args := range [][]string{{"memory", "init"}, {"run", "codex"}, {"mcp", "--role", "writer", "--project", "app"}, {"bridge", "write"}} {
		if _, err := cli(t, p.Home, args...); err == nil {
			t.Fatalf("agent allowed %v", args)
		}
	}
	for _, name := range []string{"mcp_sniffer_memory_search", "mcp_sniffer_memory_read", "mcp_sniffer_memory_context", "send_message", "ask_permission", "run_command", "mcp_other_memory_save"} {
		raw, _ := json.Marshal(map[string]any{"toolCall": map[string]string{"name": name}})
		var out, stderr bytes.Buffer
		if err := Run([]string{"--home", p.Home, "agent-guard", "agy"}, bytes.NewReader(raw), &out, &stderr); err != nil {
			t.Fatal(err)
		}
		var r map[string]string
		_ = json.Unmarshal(out.Bytes(), &r)
		want := "deny"
		if strings.HasPrefix(name, "mcp_sniffer_memory_") {
			want = "auto_approve"
		}
		if r["decision"] != want {
			t.Fatalf("guard %s: %v", name, r)
		}
	}
}

func TestClaudeLauncherUsesNativeModWithoutWorker(t *testing.T) {
	p, project, _ := fixture(t)
	plugin := filepath.Join(p.Adapters, "claude-mod", ".claude-plugin")
	if err := os.MkdirAll(plugin, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(plugin, "plugin.json"), []byte(`{"name":"sniffer-memory"}`), 0600); err != nil {
		t.Fatal(err)
	}
	fake := filepath.Join(t.TempDir(), "fake-claude")
	script := `#!/bin/sh
[ "$1" = --plugin-dir ] || exit 20
[ -z "${EIN_SNIFFER_ENDPOINT:-}" ] || exit 21
[ -n "$EIN_SNIFFER_BIN" ] || exit 22
[ "$EIN_SNIFFER_DELEGATION" = assigned ] || exit 23
printf '%s' "$EIN_SNIFFER_DELEGATE_GUIDE"
`
	if err := os.WriteFile(fake, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	if err := config.Update(p, func(c *config.Config) error { c.Agents["claude"] = config.HostAgent{Executable: fake}; return nil }); err != nil {
		t.Fatal(err)
	}
	t.Chdir(project)
	t.Setenv(delegationEnv, "assigned")
	t.Setenv(expectedProjectEnv, "app")
	out, err := cli(t, p.Home, "run", "claude")
	if err != nil || out != delegationGuide {
		t.Fatalf("%q %v", out, err)
	}
	entries, err := os.ReadDir(p.Run)
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatal("Claude unexpectedly created a worker runtime")
	}
}
