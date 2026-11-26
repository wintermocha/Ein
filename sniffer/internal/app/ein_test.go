package app

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"ein.local/sniffer/internal/config"
	"ein.local/sniffer/internal/model"
	"ein.local/sniffer/internal/recall"
	"ein.local/sniffer/internal/store"
)

func TestEinProjectSharedByBridgeAndTerminal(t *testing.T) {
	base := t.TempDir()
	p, err := config.Locate(filepath.Join(base, "sniffer"))
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(base, "workspace")
	child := filepath.Join(root, "subdir")
	if err := os.MkdirAll(child, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(base, "sibling"), 0700); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(base, "ein.json")
	original := []byte(`{"projects":{"app":{"path":"workspace"},"other":{"path":"sibling"}},"botTokenFile":"unavailable"}`)
	if err := os.WriteFile(file, original, 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("EIN_CONFIG", file)
	t.Chdir(child)
	firstUse := make(chan error, 2)
	for range 2 {
		go func() {
			_, err := cli(t, p.Home, "memory", "list")
			firstUse <- err
		}()
	}
	for range 2 {
		if err := <-firstUse; err != nil {
			t.Fatal(err)
		}
	}
	s := store.New(p.Store, p.State)
	snap, err := s.Snapshot(context.Background())
	if err != nil || len(snap.Registry.Scopes) != 2 || snap.Registry.Scopes[1].ID != "project:app" {
		t.Fatalf("first use should create only the selected scope: %+v %v", snap.Registry, err)
	}
	markdown := "---\nschema_version: 1\nid: m-shared\nscope_id: project:app\ndescription: team port\n---\nUse port 4317.\n"
	args, err := json.Marshal(map[string]string{"markdown": markdown, "if_revision": "new", "request_id": "shared-port"})
	if err != nil {
		t.Fatal(err)
	}
	b := recall.Binding{Host: "claude", Cwd: root, ConversationID: "slack", TurnID: "one", EventID: "one"}
	if _, err := bridgeCall(t, p, "write", bridgeInput{Binding: b, Role: "main", Name: "memory_save", Arguments: args}); err != nil {
		t.Fatal(err)
	}
	out, err := cli(t, p.Home, "memory", "read", "--id", "m-shared")
	if err != nil || !strings.Contains(out, "4317") {
		t.Fatalf("terminal read from subfolder: %s %v", out, err)
	}
	b.Cwd = child
	begin, err := bridgeCall(t, p, "begin", recall.BeginInput{Binding: b, Query: "port"})
	if err != nil || begin["project_id"] != "app" {
		t.Fatalf("binding: %+v %v", begin, err)
	}
	b.RequestID = begin["request_id"].(string)
	reply, err := bridgeCall(t, p, "tool", bridgeInput{Binding: b, Name: "memory_search", Arguments: json.RawMessage(`{"query":"port"}`)})
	raw, _ := json.Marshal(reply)
	if err != nil || !bytes.Contains(raw, []byte("m-shared")) {
		t.Fatalf("bridge lookup: %s %v", raw, err)
	}
	if _, err := cli(t, p.Home, "memory", "read", "--project", "other", "--id", "m-shared"); err == nil {
		t.Fatal("sibling project read private memory")
	}
	if err := config.Update(p, func(c *config.Config) error { c.Recall.WaitMillis = 100; return nil }); err != nil {
		t.Fatal(err)
	}
	raw, err = os.ReadFile(file)
	if err != nil || !bytes.Equal(raw, original) {
		t.Fatal("Ein configuration was modified")
	}
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	if _, err := cli(t, p.Home, "memory", "list"); err == nil {
		t.Fatal("removed Slack registration still bound to working folder")
	}
}

func TestEinProjectUsesExistingStoreAncestry(t *testing.T) {
	p, project, _ := fixture(t)
	file := filepath.Join(t.TempDir(), "ein.json")
	raw, _ := json.Marshal(map[string]any{"projects": map[string]any{"app": map[string]string{"path": project}}})
	if err := os.WriteFile(file, raw, 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("EIN_CONFIG", file)
	if err := config.Update(p, func(c *config.Config) error {
		c.Projects = nil // Existing Git hierarchy without a local folder registration.
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	t.Chdir(project)
	s := store.New(p.Store, p.State)
	group := model.Memory{SchemaVersion: 1, ID: "m-group", ScopeID: "group:work", Description: "Shared by team", Body: "group value"}
	if _, err := s.Save(context.Background(), group, "new", "group-note"); err != nil {
		t.Fatal(err)
	}
	before, err := s.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	got, err := cli(t, p.Home, "memory", "read", "--id", "m-group")
	if err != nil || !strings.Contains(got, "group value") {
		t.Fatalf("group ancestry: %s %v", got, err)
	}
	after, err := s.Snapshot(context.Background())
	if err != nil || before.Commit != after.Commit {
		t.Fatalf("lookup changed existing hierarchy: %v", err)
	}
}

func TestDispatchedProjectRejectsReassignedWorkspace(t *testing.T) {
	base := t.TempDir()
	p, err := config.Locate(filepath.Join(base, "sniffer"))
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(base, "ein.json")
	root := filepath.Join(base, "checkout")
	for _, path := range []string{root, filepath.Join(base, "elsewhere")} {
		if err := os.Mkdir(path, 0700); err != nil {
			t.Fatal(err)
		}
	}
	setRoots := func(alpha, beta string) {
		t.Helper()
		data, err := json.Marshal(map[string]any{"projects": map[string]any{"alpha": map[string]string{"path": alpha}, "beta": map[string]string{"path": beta}}})
		if err != nil {
			t.Fatal(err)
		}
		if err := config.AtomicWrite(file, data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	setRoots("checkout", "elsewhere")
	t.Chdir(root)
	t.Setenv("EIN_CONFIG", file)
	t.Setenv(expectedProjectEnv, "")
	markdown := "---\nschema_version: 1\nid: m-private\nscope_id: project:beta\ndescription: private formula\n---\nbeta-only-content\n"
	save := []string{"--home", p.Home, "memory", "save", "--project", "beta", "--input", "-", "--if-revision", "new", "--request-id", "beta-initial"}
	if err := Run(save, strings.NewReader(markdown), io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
	t.Setenv(expectedProjectEnv, "alpha")
	if _, err := cli(t, p.Home, "memory", "list"); err != nil {
		t.Fatal(err)
	}
	if _, err := cli(t, p.Home, "memory", "list", "--project", "beta"); err == nil {
		t.Fatal("explicit project overrode dispatch")
	}
	// The same stdio writer process handles requests both before and after remapping.
	serverIn, clientOut := io.Pipe()
	clientIn, serverOut := io.Pipe()
	done := make(chan error, 1)
	go func() {
		err := Run([]string{"--home", p.Home, "mcp", "--role", "writer", "--project", "alpha"}, serverIn, serverOut, io.Discard)
		serverOut.CloseWithError(err)
		serverIn.CloseWithError(err)
		done <- err
	}()
	t.Cleanup(func() { clientOut.Close(); clientIn.Close() })
	enc, dec := json.NewEncoder(clientOut), json.NewDecoder(clientIn)
	send := func(value any) {
		t.Helper()
		if err := enc.Encode(value); err != nil {
			t.Fatal(err)
		}
	}
	var init json.RawMessage
	send(map[string]any{"jsonrpc": "2.0", "method": "initialize", "id": 1, "params": map[string]any{"protocolVersion": "2025-11-25"}})
	if err := dec.Decode(&init); err != nil {
		t.Fatal(err)
	}
	send(map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"})
	before, err := store.New(p.Store, p.State).Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	setRoots("elsewhere", "checkout")
	for _, selector := range [][]string{nil, {"--project", "alpha"}, {"--project", "beta"}} {
		cmd := append([]string{"memory", "read", "--id", "m-private"}, selector...)
		if out, err := cli(t, p.Home, cmd...); err == nil || out != "" {
			t.Fatalf("remapped read allowed: %s %v", out, err)
		}
	}
	if err := Run(save, strings.NewReader(markdown), io.Discard, io.Discard); err == nil {
		t.Fatal("remapped save accepted")
	}
	if _, err := bridgeCall(t, p, "begin", recall.BeginInput{Binding: recall.Binding{Host: "claude", Cwd: root, ConversationID: "chat"}, Query: "private formula"}); err == nil {
		t.Fatal("bridge used remapped workspace")
	}
	args := map[string]any{"markdown": strings.ReplaceAll(markdown, "project:beta", "project:alpha"), "if_revision": "new", "request_id": "remapped-save"}
	send(map[string]any{"jsonrpc": "2.0", "method": "tools/call", "id": 2, "params": map[string]any{"name": "memory_save", "arguments": args}})
	var reply struct {
		Result struct {
			IsError bool                    `json:"isError"`
			Content []struct{ Text string } `json:"content"`
		} `json:"result"`
	}
	if err := dec.Decode(&reply); err != nil || !reply.Result.IsError || len(reply.Result.Content) != 1 || reply.Result.Content[0].Text != "workspace project changed" {
		t.Fatalf("long-lived writer after reassignment: %+v %v", reply, err)
	}
	clientOut.Close()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	after, err := store.New(p.Store, p.State).Snapshot(context.Background())
	if err != nil || before.Commit != after.Commit {
		t.Fatalf("rejected writes changed Git: %v", err)
	}
}
