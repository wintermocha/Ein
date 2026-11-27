package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"ein.local/sniffer/internal/config"
	"ein.local/sniffer/internal/model"
	"ein.local/sniffer/internal/store"
)

// This opt-in helper runs the real command dispatcher in fresh OS processes.
// It is test-only and is never linked into the distributed sniffer binary.
func init() {
	if os.Getenv("TEST_EIN_SNIFFER_APP_HELPER") == "1" {
		err := Run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		os.Exit(0)
	}
}
func cli(t *testing.T, home string, args ...string) (string, error) {
	t.Helper()
	var out, errout bytes.Buffer
	err := Run(append([]string{"--home", home}, args...), strings.NewReader(""), &out, &errout)
	return out.String(), err
}
func fixture(t *testing.T) (config.Paths, string, model.Memory) {
	t.Helper()
	base := t.TempDir()
	p, err := config.Locate(filepath.Join(base, "sniffer"))
	if err != nil {
		t.Fatal(err)
	}
	project := filepath.Join(base, "project")
	if err = os.Mkdir(project, 0700); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"memory", "init"}, {"group", "add", "--id", "work"}, {"project", "add", "--id", "app", "--path", project, "--parent", "group:work"}} {
		if _, err = cli(t, p.Home, args...); err != nil {
			t.Fatal(err)
		}
	}
	m := model.Memory{SchemaVersion: 1, ID: "m-port", ScopeID: "project:app", Description: "가상 샘플: 개발 서버 포트", Aliases: []string{"development port", "dev port"}, Body: "Fictional sample only. Use port 4317."}
	if _, err = store.New(p.Store, p.State).Save(context.Background(), m, "new", "fixture-save"); err != nil {
		t.Fatal(err)
	}
	snap, err := store.New(p.Store, p.State).Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	m = snap.Memories[0]
	return p, project, m
}
func TestCLIReadSearchCASAndScope(t *testing.T) {
	p, project, m := fixture(t)
	_ = project
	before, _ := store.New(p.Store, p.State).Snapshot(context.Background())
	out, err := cli(t, p.Home, "memory", "search", "--project", "app", "--query", "development port")
	if err != nil || !strings.Contains(out, "m-port") {
		t.Fatalf("%s %v", out, err)
	}
	out, err = cli(t, p.Home, "memory", "read", "--project", "app", "--id", "m-port", "--format", "markdown")
	if err != nil {
		t.Fatal(err)
	}
	input := filepath.Join(t.TempDir(), "updated.md")
	if err = os.WriteFile(input, []byte(strings.ReplaceAll(out, "4317", "4318")), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = cli(t, p.Home, "memory", "save", "--project", "app", "--input", input, "--if-revision", "new", "--request-id", "bad-create"); err == nil {
		t.Fatal("existing memory overwritten as new")
	}
	after, _ := store.New(p.Store, p.State).Snapshot(context.Background())
	if before.Commit != after.Commit {
		t.Fatal("read or rejected CAS changed HEAD")
	}
	if _, err = cli(t, p.Home, "memory", "save", "--project", "app", "--input", input, "--if-revision", m.Revision, "--request-id", "update-port"); err != nil {
		t.Fatal(err)
	}
	if _, err = cli(t, p.Home, "memory", "save", "--project", "app", "--input", input, "--if-revision", m.Revision, "--request-id", "stale-update"); err == nil {
		t.Fatal("stale update accepted")
	}
	if _, err = cli(t, p.Home, "memory", "list", "--project", "app", "--scope", "project:sibling"); err == nil {
		t.Fatal("sibling scope accepted")
	}
}
func TestMCPReaderCannotWriteAndIsProjectBound(t *testing.T) {
	p, _, _ := fixture(t)
	before, _ := store.New(p.Store, p.State).Snapshot(context.Background())
	input := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"memory_save","arguments":{}}}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"memory_search","arguments":{"query":"development port","project":"sibling"}}}
{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"memory_read","arguments":{"id":"m-port"}}}
`
	var out, stderr bytes.Buffer
	if err := Run([]string{"--home", p.Home, "mcp", "--role", "reader", "--project", "app"}, strings.NewReader(input), &out, &stderr); err != nil {
		t.Fatal(err)
	}
	d := json.NewDecoder(&out)
	var messages []map[string]any
	for {
		var x map[string]any
		if err := d.Decode(&x); err == io.EOF {
			break
		} else if err != nil {
			t.Fatal(err)
		}
		messages = append(messages, x)
	}
	if len(messages) != 5 {
		t.Fatalf("unexpected protocol count %d", len(messages))
	}
	if messages[2]["error"] == nil {
		t.Fatal("reader exposed writer")
	}
	if messages[3]["result"].(map[string]any)["isError"] != true {
		t.Fatal("caller overrode bound project")
	}
	if messages[4]["result"].(map[string]any)["isError"] != false {
		t.Fatal("bound read failed")
	}
	after, _ := store.New(p.Store, p.State).Snapshot(context.Background())
	if before.Commit != after.Commit {
		t.Fatal("reader changed store")
	}
}
func TestHookInactiveOutsideLauncherAndInsideMemoryAgent(t *testing.T) {
	t.Setenv("EIN_SNIFFER_RUN_ID", "")
	out, err := cli(t, t.TempDir(), "hook", "codex")
	if err != nil || strings.TrimSpace(out) != "{}" {
		t.Fatalf("%q %v", out, err)
	}
	t.Setenv("EIN_SNIFFER_RUN_ID", "some-run")
	t.Setenv("EIN_SNIFFER_ROLE", "memory-agent")
	out, err = cli(t, t.TempDir(), "hook", "codex")
	if err != nil || strings.TrimSpace(out) != "{}" {
		t.Fatalf("%q %v", out, err)
	}
	if _, err = cli(t, t.TempDir(), "memory", "init"); err == nil {
		t.Fatal("memory agent invoked writer")
	}
}
func TestLauncherWorkerLifetimeAndExplicitRecall(t *testing.T) {
	p, project, _ := fixture(t)
	base := t.TempDir()
	// Launch from an additional checkout known only to Ein. The worker and
	// hooks must still find the existing project's committed memory.
	project = filepath.Join(base, "checkout", "subdir")
	if err := os.MkdirAll(project, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(base, "ein.json"), []byte(`{"projects":{"app":{"path":"checkout"}}}`), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("EIN_CONFIG", "../../ein.json")
	result := filepath.Join(base, "recall.json")
	endpointFile := filepath.Join(base, "endpoint")
	pidFile := filepath.Join(base, "main.pid")
	// The fake CLI observes one authentic hook envelope and then explicitly reads
	// memory through the live worker. It never simulates a paid LLM response.
	script := filepath.Join(base, "fake-codex")
	body := `#!/bin/sh
if [ "$1" = app-server ]; then exit 0; fi
printf '%s' "$EIN_SNIFFER_ENDPOINT" > "$TEST_ENDPOINT_FILE"
printf '%s' "$$" > "$TEST_MAIN_PID_FILE"
printf '{"hook_event_name":"UserPromptSubmit","session_id":"launcher-test","cwd":"%s","prompt":"development port"}\n' "$PWD" | "$EIN_SNIFFER_BIN" hook codex >/dev/null
"$EIN_SNIFFER_BIN" memory recall --id m-port --force > "$TEST_RECALL_FILE"
if [ "$TEST_STAY_ALIVE" = 1 ]; then
  while :; do sleep 1; done
fi
`
	if err := os.WriteFile(script, []byte(body), 0700); err != nil {
		t.Fatal(err)
	}
	if err := config.Update(p, func(c *config.Config) error { c.Agents["codex"] = config.HostAgent{Executable: script}; return nil }); err != nil {
		t.Fatal(err)
	}
	exe, _ := os.Executable()
	cmd := exec.Command(exe, "--home", p.Home, "run", "codex")
	cmd.WaitDelay = 500 * time.Millisecond
	cmd.Dir = project
	cmd.Env = append(os.Environ(), "TEST_EIN_SNIFFER_APP_HELPER=1", "TEST_ENDPOINT_FILE="+endpointFile, "TEST_MAIN_PID_FILE="+pidFile, "TEST_RECALL_FILE="+result)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("launcher: %v: %s", err, stderr.String())
	}
	b, err := os.ReadFile(result)
	if err != nil || !bytes.Contains(b, []byte("4317")) {
		t.Fatalf("recall: %s %v", b, err)
	}
	b, err = os.ReadFile(endpointFile)
	if err != nil {
		t.Fatal(err)
	}
	u, _ := url.Parse(string(b))
	conn, err := net.DialTimeout("tcp", u.Host, 100*time.Millisecond)
	if err == nil {
		conn.Close()
		t.Fatal("worker survived main CLI exit")
	}
	runs, err := os.ReadDir(p.Run)
	if err != nil || len(runs) != 0 {
		t.Fatalf("run artifacts not removed: %v %v", runs, err)
	}
	// A killed launcher cannot run a defer. The worker must still observe owner
	// pipe EOF, close its listener and remove its own ephemeral run directory.
	_ = os.Remove(result)
	_ = os.Remove(endpointFile)
	_ = os.Remove(pidFile)
	cmd = exec.Command(exe, "--home", p.Home, "run", "codex")
	cmd.WaitDelay = 500 * time.Millisecond
	cmd.Dir = project
	cmd.Env = append(os.Environ(), "TEST_EIN_SNIFFER_APP_HELPER=1", "TEST_ENDPOINT_FILE="+endpointFile, "TEST_MAIN_PID_FILE="+pidFile, "TEST_RECALL_FILE="+result, "TEST_STAY_ALIVE=1")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Stderr = &stderr
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	deadline := time.Now().Add(15 * time.Second)
	for {
		if b, e := os.ReadFile(result); e == nil && bytes.Contains(b, []byte("4317")) {
			break
		}
		if time.Now().After(deadline) {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
			t.Fatalf("fake CLI did not initialize: %s", stderr.String())
		}
		time.Sleep(20 * time.Millisecond)
	}
	b, _ = os.ReadFile(endpointFile)
	u, _ = url.Parse(string(b))
	if err = cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = cmd.Wait()
	deadline = time.Now().Add(6 * time.Second)
	for {
		conn, e := net.DialTimeout("tcp", u.Host, 100*time.Millisecond)
		if e != nil {
			break
		}
		conn.Close()
		if time.Now().After(deadline) {
			t.Fatal("worker survived owner loss")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestLauncherDeliversOrdinaryDelegationGuidanceThroughNativeHooks(t *testing.T) {
	for _, name := range []string{"codex", "agy"} {
		t.Run(name, func(t *testing.T) {
			p, project, _ := fixture(t)
			fake := filepath.Join(t.TempDir(), "host")
			body := `#!/bin/sh
[ "$EIN_SNIFFER_DELEGATION" = assigned ] || exit 20
case "$EIN_SNIFFER_HOST" in
  codex) printf '{"hook_event_name":"SessionStart","source":"startup","session_id":"main","cwd":"%s"}' "$PWD" | "$EIN_SNIFFER_BIN" hook codex ;;
  agy) printf '{"conversationId":"main","workspacePaths":["%s"]}' "$PWD" | "$EIN_SNIFFER_BIN" hook agy --event PreInvocation ;;
esac
`
			if err := os.WriteFile(fake, []byte(body), 0700); err != nil {
				t.Fatal(err)
			}
			if err := config.Update(p, func(c *config.Config) error {
				c.Agents[name] = config.HostAgent{Executable: fake}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			exe, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			cmd := exec.Command(exe, "--home", p.Home, "run", name)
			cmd.Env = append(os.Environ(), "TEST_EIN_SNIFFER_APP_HELPER=1", delegationEnv+"=assigned", expectedProjectEnv+"=app")
			cmd.Dir = project
			b, err := cmd.CombinedOutput()
			if err != nil {
				t.Fatalf("run %s: %s %v", name, b, err)
			}
			var output struct {
				HookSpecificOutput struct{ AdditionalContext string }
				InjectSteps        []struct {
					SystemMessage struct{ SystemMessage string }
				}
			}
			if err := json.Unmarshal(b, &output); err != nil {
				t.Fatalf("invalid %s hook output: %s (%v)", name, b, err)
			}
			if name == "codex" && output.HookSpecificOutput.AdditionalContext != delegationGuide {
				t.Fatalf("Codex SessionStart context: %s", b)
			}
			if name == "agy" && (len(output.InjectSteps) != 1 || output.InjectSteps[0].SystemMessage.SystemMessage != delegationGuide) {
				t.Fatalf("Antigravity PreInvocation context: %s", b)
			}
		})
	}
}
