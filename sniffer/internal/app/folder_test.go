package app

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"ein.local/sniffer/internal/config"
	"ein.local/sniffer/internal/recall"
	"ein.local/sniffer/internal/store"
)

func workspaceNote(t *testing.T, home, id, scope string, flags ...string) error {
	t.Helper()
	args := append([]string{"--home", home, "memory", "save", "--input", "-", "--if-revision", "new", "--request-id", id}, flags...)
	note := "---\nschema_version: 1\nid: " + id + "\nscope_id: " + scope + "\ndescription: integration memory\n---\n" + id + " body\n"
	return Run(args, strings.NewReader(note), io.Discard, io.Discard)
}

func TestFolderPrivateScopeSurvivesLinkingAndIsolatesNativeReaders(t *testing.T) {
	base := t.TempDir()
	p, err := config.Locate(filepath.Join(base, "home"))
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("EIN_CONFIG", filepath.Join(base, "unconfigured"))
	first, second := filepath.Join(base, "one"), filepath.Join(base, "two")
	child := filepath.Join(first, "nested")
	for _, dir := range []string{child, second} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	folder := func(action, path string, args ...string) folderInfo {
		t.Helper()
		raw, err := cli(t, p.Home, append([]string{"folder", action, "--path", path}, args...)...)
		if err != nil {
			t.Fatal(err)
		}
		var f folderInfo
		if err := json.Unmarshal([]byte(raw), &f); err != nil {
			t.Fatal(err)
		}
		return f
	}
	preview := folder("inspect", first, "--project", "app", "--group", "work")
	if preview.Bound || !slices.Equal(preview.Groups, []string{"work"}) {
		t.Fatalf("preview %+v", preview)
	}
	if _, err := os.Stat(p.Home); !os.IsNotExist(err) {
		t.Fatalf("inspect created state: %v", err)
	}
	private := folder("bind", first)
	t.Chdir(child)
	if err := workspaceNote(t, p.Home, "m-private", "folder:current"); err != nil {
		t.Fatal(err)
	}
	if got, err := cli(t, p.Home, "memory", "read", "--id", "m-private"); err != nil || !strings.Contains(got, private.FolderID) {
		t.Fatalf("unlinked folder read: %s %v", got, err)
	}
	linked := folder("bind", child, "--project", "app", "--group", "work")
	if linked.FolderID != preview.FolderID || linked.Root != private.Root || !linked.Bound || linked.ProjectID != "app" || !slices.Equal(linked.Groups, preview.Groups) {
		t.Fatalf("linked %+v", linked)
	}
	st := store.New(p.Store, p.State)
	before, err := st.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	folder("bind", child, "--project", "app", "--group", "work")
	after, err := st.Snapshot(context.Background())
	if err != nil || before.Commit != after.Commit {
		t.Fatal("retry changed store", err)
	}
	for _, scope := range []string{"project:app", "group:work", "global"} {
		if err := workspaceNote(t, p.Home, "m-"+strings.ReplaceAll(scope, ":", "-"), scope); err != nil {
			t.Fatal(err)
		}
	}
	b := recall.Binding{Host: "claude", ConversationID: "chat", Cwd: child}
	res, err := bridgeCall(t, p, "begin", recall.BeginInput{Binding: b, Query: "integration"})
	if err != nil {
		t.Fatal(err)
	}
	b.RequestID = res["request_id"].(string)
	found, err := bridgeCall(t, p, "tool", bridgeInput{Binding: b, Name: "memory_search", Arguments: json.RawMessage(`{"query":"integration"}`)})
	raw, _ := json.Marshal(found)
	if err != nil || !bytes.Contains(raw, []byte("m-private")) {
		t.Fatalf("native read: %s %v", raw, err)
	}
	md := "---\nschema_version: 1\nid: m-native-private\nscope_id: folder:current\ndescription: private writer\n---\nNative writer body.\n"
	writerArgs, err := json.Marshal(map[string]string{"markdown": md, "if_revision": "new", "request_id": "native-private"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := bridgeCall(t, p, "write", bridgeInput{Binding: b, Role: "main", Name: "memory_save", Arguments: writerArgs}); err != nil {
		t.Fatal(err)
	}
	note, err := cli(t, p.Home, "memory", "read", "--project", "app", "--id", "m-native-private")
	if err != nil || !strings.Contains(note, private.FolderID) {
		t.Fatalf("native writer saved outside folder: %s %v", note, err)
	}
	if _, err := cli(t, p.Home, "folder", "bind", "--path", first, "--project", "app", "--group", "unrelated"); err == nil {
		t.Fatal("changed an existing project's group")
	}
	sibling := folder("bind", second, "--project", "app")
	if sibling.FolderID == linked.FolderID {
		t.Fatal("two roots share folder identity")
	}
	t.Chdir(second)
	out, err := cli(t, p.Home, "memory", "list")
	if err != nil || strings.Contains(out, "m-private") || !strings.Contains(out, "m-project-app") || !strings.Contains(out, "m-group-work") || !strings.Contains(out, "m-global") {
		t.Fatalf("sibling read: %s %v", out, err)
	}
	if err := workspaceNote(t, p.Home, "m-intruder", "folder:"+private.FolderID); err == nil {
		t.Fatal("sibling wrote private scope")
	}
	if _, err := cli(t, p.Home, "memory", "read", "--id", "m-private", "--project", "app"); err == nil {
		t.Fatal("project flag granted private access")
	}
	if _, err := bridgeCall(t, p, "tool", bridgeInput{Binding: b, Name: "memory_read", Arguments: json.RawMessage(`{"id":"m-private"}`)}); err == nil {
		t.Fatal("sibling replayed native session")
	}
	c, err := config.Load(p)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.ResolveWorkspaces([]string{first, second}); err == nil {
		t.Fatal("mixed folders accepted")
	}

	t.Run("isolated native reader", func(t *testing.T) {
		runtime := t.TempDir()
		t.Chdir(runtime)
		t.Setenv("EIN_SNIFFER_ROLE", "memory-agent")
		t.Setenv(expectedProjectEnv, "app")
		t.Setenv(expectedFolderEnv, "folder:"+private.FolderID)
		file := filepath.Join(runtime, "request.json")
		if err := os.WriteFile(file, []byte(`{"request_id":"test-native"}`), 0600); err != nil {
			t.Fatal(err)
		}
		rpc := strings.Join([]string{
			`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}`,
			`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
			`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"memory_read","arguments":{"id":"m-private"}}}`,
		}, "\n")
		args := []string{"--home", p.Home, "mcp", "--role", "agent-reader", "--project", "app", "--context-file", file, "--workspace"}
		var out bytes.Buffer
		if err := Run(append(args, first), strings.NewReader(rpc), &out, io.Discard); err != nil || !strings.Contains(out.String(), "m-private body") {
			t.Fatalf("isolated folder reader: %s %v", out.String(), err)
		}
		if err := Run(append(args, second), strings.NewReader(rpc), io.Discard, io.Discard); err == nil {
			t.Fatal("private reader rebound to a sibling checkout")
		}
	})
}

func TestStandaloneGlobalImportRequiresGlobalScope(t *testing.T) {
	base := t.TempDir()
	home := filepath.Join(base, "home")
	t.Setenv("EIN_CONFIG", filepath.Join(base, "unconfigured"))
	if err := workspaceNote(t, home, "m-wrong", "folder:current", "--global"); err == nil {
		t.Fatal("global writer accepted folder scope")
	}
	if err := workspaceNote(t, home, "m-global", "global", "--global"); err != nil {
		t.Fatal(err)
	}
	got, err := cli(t, home, "memory", "list", "--global")
	if err != nil || !strings.Contains(got, "m-global") {
		t.Fatalf("global list: %s %v", got, err)
	}
	for _, flags := range [][]string{{"--project", "app"}, {"--scope", "group:work"}} {
		if _, err := cli(t, home, append([]string{"memory", "list", "--global"}, flags...)...); err == nil {
			t.Fatalf("accepted global flags %v", flags)
		}
	}
	t.Setenv(expectedProjectEnv, "app")
	if err := workspaceNote(t, home, "m-dispatched", "global", "--global"); err == nil {
		t.Fatal("dispatched session used standalone global mode")
	}
}

func TestExactSourceFoldersWithinProject(t *testing.T) {
	base := t.TempDir()
	home := filepath.Join(base, "home")
	t.Setenv("EIN_CONFIG", filepath.Join(base, "unconfigured"))
	repo := filepath.Join(base, "repo")
	for _, dir := range []string{"early", "a", "b"} {
		if err := os.MkdirAll(filepath.Join(repo, dir, "nested"), 0700); err != nil {
			t.Fatal(err)
		}
	}
	do := func(args ...string) string {
		t.Helper()
		out, err := cli(t, home, args...)
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	early := filepath.Join(repo, "early")
	do("folder", "bind", "--exact", "--path", early)
	t.Chdir(early)
	if err := workspaceNote(t, home, "early-note", "folder:current"); err != nil {
		t.Fatal(err)
	}
	do("project", "add", "--id", "app", "--path", repo)
	var standalone folderInfo
	if err := json.Unmarshal([]byte(do("folder", "inspect", "--path", filepath.Join(early, "nested"))), &standalone); err != nil {
		t.Fatal(err)
	}
	if standalone.ProjectID != "" || !standalone.Bound || !strings.Contains(do("memory", "list"), "early-note") {
		t.Fatalf("existing standalone folder was reparented: %+v", standalone)
	}
	for _, dir := range []string{"a", "b"} {
		source := filepath.Join(repo, dir)
		for _, action := range []string{"inspect", "bind"} {
			var f folderInfo
			if err := json.Unmarshal([]byte(do("folder", action, "--path", source, "--exact")), &f); err != nil {
				t.Fatal(err)
			}
			want, _ := config.CanonicalDir(source)
			if f.Root != want || f.ProjectID != "app" || f.Bound != (action == "bind") {
				t.Fatalf("%s %s: %+v", dir, action, f)
			}
		}
		t.Chdir(filepath.Join(source, "nested"))
		if err := workspaceNote(t, home, "private-"+dir, "folder:current"); err != nil {
			t.Fatal(err)
		}
	}
	if err := workspaceNote(t, home, "project-wide", "project:app"); err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{"a", "b"} {
		t.Chdir(filepath.Join(repo, dir, "nested"))
		var list struct{ Memories []struct{ ID string } }
		if err := json.Unmarshal([]byte(do("memory", "list")), &list); err != nil {
			t.Fatal(err)
		}
		if len(list.Memories) != 2 || list.Memories[0].ID != "private-"+dir || list.Memories[1].ID != "project-wide" {
			t.Fatalf("private root %s: %+v", dir, list)
		}
	}
	t.Chdir(early)
	if strings.Contains(do("memory", "list"), "project-wide") {
		t.Fatal("standalone folder inherited an ancestor project's memory")
	}
	do("folder", "bind", "--path", early, "--project", "app")
	got := do("memory", "list")
	if !strings.Contains(got, "early-note") || !strings.Contains(got, "project-wide") {
		t.Fatal("explicit linking lost saved memories or project access")
	}
}
