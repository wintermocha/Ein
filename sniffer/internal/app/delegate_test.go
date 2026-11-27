package app

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"ein.local/sniffer/internal/config"
)

func delegationFixture(t *testing.T) (string, string) {
	t.Helper()
	base, err := config.CanonicalDir(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{"alpha/sub", "alpha/nested", "beta/sub", "local", "outside"} {
		if err := os.MkdirAll(filepath.Join(base, dir), 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(filepath.Join(base, "beta/sub"), filepath.Join(base, "alpha/sub/link")); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(base, "ein.json")
	if err := os.WriteFile(file, []byte(`{"projects":{"alpha":{"path":"alpha"},"nested":{"path":"alpha/nested"},"beta":{"path":"beta"}}}`), 0600); err != nil {
		t.Fatal(err)
	}
	home := filepath.Join(base, "home")
	p, err := config.Locate(home)
	if err != nil {
		t.Fatal(err)
	}
	if err := config.Update(p, func(c *config.Config) error {
		c.Projects = []config.Project{{ID: "beta", Roots: []string{filepath.Join(base, "local")}}}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	t.Chdir(filepath.Join(base, "alpha/sub"))
	t.Setenv("EIN_CONFIG", "../../ein.json")
	t.Setenv(expectedProjectEnv, "alpha")
	t.Setenv(delegationEnv, "")
	t.Setenv("EIN_SNIFFER_ROLE", "")
	return base, home
}

func TestDelegateResolvesParentAndTarget(t *testing.T) {
	base, home := delegationFixture(t)
	for _, tc := range []struct {
		name                         string
		args                         []string
		pin, policy, wantID, wantDir string
	}{
		{"inherit registered cwd", nil, "alpha", "", "alpha", "alpha/sub"},
		{"standalone terminal", nil, "", "", "alpha", "alpha/sub"},
		{"explicit same project keeps cwd", []string{"--project", "alpha"}, "alpha", "assigned", "alpha", "alpha/sub"},
		{"nested needs reassignment", []string{"--cwd", "../nested"}, "alpha", "", "", ""},
		{"explicit nested root", []string{"--project", "nested"}, "alpha", "", "nested", "alpha/nested"},
		{"ambiguous aliases need cwd", []string{"--project", "beta"}, "alpha", "", "", ""},
		{"explicit local alias", []string{"--project", "beta", "--cwd", "../../local"}, "alpha", "", "beta", "local"},
		{"symlink changes project", []string{"--cwd", "link"}, "alpha", "", "", ""},
		{"canonical symlink parent", []string{"--project", "beta", "--cwd", "link/.."}, "alpha", "", "beta", "beta"},
		{"Slack cannot reassign", []string{"--project", "nested"}, "alpha", "assigned", "", ""},
		{"pin disagrees with parent", []string{"--project", "nested"}, "beta", "", "", ""},
		{"unregistered target", []string{"--cwd", "../../outside"}, "alpha", "", "", ""},
		{"mismatched explicit target", []string{"--cwd", "link", "--project", "nested"}, "alpha", "", "", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv(expectedProjectEnv, tc.pin)
			t.Setenv(delegationEnv, tc.policy)
			out, err := cli(t, home, append([]string{"delegate"}, tc.args...)...)
			if tc.wantID == "" {
				if err == nil || out != "" {
					t.Fatalf("unexpected binding %s (err %v)", out, err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			var got delegatedProject
			if err := json.Unmarshal([]byte(out), &got); err != nil {
				t.Fatal(err)
			}
			if got.ProjectID != tc.wantID || got.Directory != filepath.Join(base, tc.wantDir) || got.Env[expectedProjectEnv] != tc.wantID || got.Env[delegationEnv] != tc.policy || got.Env["EIN_CONFIG"] != filepath.Join(base, "ein.json") || got.Env["EIN_HOME"] != home {
				t.Fatalf("wrong child binding: %s", out)
			}
		})
	}
}

func TestDelegateCannotReassignFromUnregisteredParent(t *testing.T) {
	base, home := delegationFixture(t)
	t.Setenv("EIN_CONFIG", filepath.Join(base, "ein.json"))
	t.Setenv(expectedProjectEnv, "")
	t.Chdir(filepath.Join(base, "outside"))
	out, err := cli(t, home, "delegate", "--project", "alpha")
	if err == nil || out != "" {
		t.Fatalf("unregistered parent received binding: %s, %v", out, err)
	}
}

func TestDelegateUnassignedAndMemoryReader(t *testing.T) {
	_, home := delegationFixture(t)
	for _, tc := range []struct{ name, pin, policy, role string }{
		{"memory reader", "alpha", "", "memory-agent"},
		{"memoryless child", "alpha", "none", ""},
		{"missing Slack pin", "", "assigned", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv(expectedProjectEnv, tc.pin)
			t.Setenv(delegationEnv, tc.policy)
			t.Setenv("EIN_SNIFFER_ROLE", tc.role)
			if out, err := cli(t, home, "delegate"); err == nil || out != "" {
				t.Fatalf("unexpected binding: %s, %v", out, err)
			}
			if out, err := cli(t, home, "memory", "list"); err == nil || out != "" {
				t.Fatalf("unexpected memory result: %s, %v", out, err)
			}
			if out, err := cli(t, home, "hook", "codex"); err != nil || strings.TrimSpace(out) != "{}" {
				t.Fatalf("hook: %s, %v", out, err)
			}
		})
	}
}

func TestDelegateExec(t *testing.T) {
	base, home := delegationFixture(t)
	t.Setenv("TEST_EIN_SNIFFER_APP_HELPER", "1")
	t.Setenv(delegationEnv, "assigned")
	t.Setenv("EIN_SNIFFER_ENDPOINT", "parent-worker")
	t.Setenv("EIN_APP_TOKEN", "parent-app")
	t.Setenv("HOGU_BOT_TOKEN", "parent-bot")
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := func(script string, args ...string) *exec.Cmd {
		return exec.Command(self, append([]string{"--home", home, "delegate", "--cwd", "..", "--", "/bin/sh", "-c", script, "child"}, args...)...)
	}
	literal := "literal $(exit 99); *"
	out, err := cmd(`printf '%s\n' "$(pwd -P)" "$PWD" "$EIN_CONFIG" "$EIN_HOME" "$EIN_SNIFFER_EXPECT_PROJECT" "$EIN_SNIFFER_DELEGATION" "${EIN_SNIFFER_ENDPOINT-missing}" "${EIN_APP_TOKEN-missing}" "${HOGU_BOT_TOKEN-missing}" "$1"; exit 37`, literal).CombinedOutput()
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 37 {
		t.Fatalf("exit: %v, child: %s", err, out)
	}
	want := strings.Join([]string{filepath.Join(base, "alpha"), filepath.Join(base, "alpha"), filepath.Join(base, "ein.json"), home, "alpha", "assigned", "missing", "missing", "missing", literal, ""}, "\n")
	if string(out) != want {
		t.Fatalf("child output %q; want %q", out, want)
	}
	err = cmd("kill -TERM $$").Run()
	if !errors.As(err, &exit) || exit.Sys().(syscall.WaitStatus).Signal() != syscall.SIGTERM {
		t.Fatalf("child termination: %v", err)
	}
}
