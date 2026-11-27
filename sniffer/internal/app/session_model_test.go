package app

import (
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"ein.local/sniffer/internal/config"
)

func TestRunSessionModel(t *testing.T) {
	base := t.TempDir()
	project := filepath.Join(base, "checkout")
	if err := os.Mkdir(project, 0700); err != nil {
		t.Fatal(err)
	}
	p, err := config.Locate(filepath.Join(base, "sniffer"))
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(base, "ein.json")
	t.Setenv("EIN_CONFIG", file)
	t.Setenv("TEST_EIN_SNIFFER_APP_HELPER", "1")
	if err := config.AtomicWrite(file, []byte(`{"projects":{"app":{"path":"checkout"}},"models":{"agy":"custom-carbon","codex":"custom-codex"}}`), 0600); err != nil {
		t.Fatal(err)
	}
	fake := filepath.Join(base, "host")
	if err := os.WriteFile(fake, []byte("#!/bin/sh\nprintf '%s\\n' \"$@\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := config.Update(p, func(c *config.Config) error {
		for host, agent := range c.Agents {
			agent.Executable = fake
			c.Agents[host] = agent
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	mod := filepath.Join(p.Adapters, "claude-mod")
	if err := config.AtomicWrite(filepath.Join(mod, ".claude-plugin", "plugin.json"), []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, host string
		native     []string
		want       []string
		delegated  bool
	}{
		{"claude default", "claude", []string{"-p", "two words"}, []string{"--model", "opus", "-p", "two words"}, false},
		{"claude explicit", "claude", []string{"--model=sonnet", "-p", "two words"}, nil, false},
		{"claude resume", "claude", []string{"--resume", "previous"}, nil, false},
		{"delegated codex exec", "codex", []string{"exec", "two words"}, []string{"-c", `model="custom-codex"`, "exec", "two words"}, true},
		{"codex explicit", "codex", []string{"exec", "-mcustom", "task"}, nil, false},
		{"codex explicit config", "codex", []string{"exec", "--config=model=manual", "-c", "sandbox_mode=read-only"}, nil, false},
		{"codex exec config scope", "codex", []string{"exec", "-c", "sandbox_mode=read-only", "task"}, []string{"exec", "-c", `model="custom-codex"`, "-c", "sandbox_mode=read-only", "task"}, false},
		{"codex exec resume", "codex", []string{"exec", "--json", "resume", "--last"}, nil, false},
		{"codex directory named resume", "codex", []string{"-C", "resume", "app-server"}, []string{"-c", `model="custom-codex"`, "-C", "resume", "app-server"}, false},
		{"codex exec prompt named fork", "codex", []string{"exec", "fork"}, []string{"-c", `model="custom-codex"`, "exec", "fork"}, false},
		{"codex literal argument", "codex", []string{"--", "--model"}, []string{"-c", `model="custom-codex"`, "--", "--model"}, false},
		{"agy override", "agy", []string{"--print", "two words"}, []string{"--model", "custom-carbon", "--print", "two words"}, false},
		{"agy flag as prompt", "agy", []string{"-p", "--model"}, []string{"--model", "custom-carbon", "-p", "--model"}, false},
		{"agy explicit", "agy", []string{"--model", "manual", "--print", "task"}, nil, false},
		{"agy resume", "agy", []string{"--conversation=previous"}, nil, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			args := []string{"--home", p.Home}
			if tc.delegated {
				args = append(args, "delegate", "--", self)
			}
			args = append(args, "run", tc.host, "--")
			cmd := exec.Command(self, append(args, tc.native...)...)
			cmd.Dir = project
			out, err := cmd.CombinedOutput()
			if err != nil {
				t.Fatalf("run: %s (%v)", out, err)
			}
			want := tc.want
			if want == nil {
				want = tc.native
			}
			if tc.host == "claude" {
				want = append([]string{"--plugin-dir", mod}, want...)
			}
			got := strings.Split(strings.TrimSuffix(string(out), "\n"), "\n")
			if !slices.Equal(got, want) {
				t.Fatalf("host argv %q, want %q", got, want)
			}
			t.Logf("host argv %q", got)
		})
	}
}
