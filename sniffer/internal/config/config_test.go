package config

import (
	"maps"
	"os"
	"path/filepath"
	"testing"
)

func TestEinSessionModels(t *testing.T) {
	p, err := Locate(filepath.Join(t.TempDir(), "sniffer"))
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(t.TempDir(), "ein.json")
	t.Setenv("EIN_CONFIG", file)
	want := map[string]string{"claude": "claude-opus-5-5", "codex": "gpt-6.2-astra", "agy": "gemini-4-carbon"}
	for _, settings := range []string{"", `{}`, `{"models":{}}`} {
		if settings != "" {
			if err := AtomicWrite(file, []byte(settings), 0600); err != nil {
				t.Fatal(err)
			}
		}
		c, err := Load(p)
		if err != nil || !maps.Equal(c.SessionModels, want) {
			t.Fatalf("config %q: got %v, want %v, err %v", settings, c.SessionModels, want, err)
		}
	}
	if err := AtomicWrite(file, []byte(`{"models":{"claude":"opus[1m]","omo":"provider/model@v1:fast+2"}}`), 0600); err != nil {
		t.Fatal(err)
	}
	want["claude"], want["omo"] = "opus[1m]", "provider/model@v1:fast+2"
	c, err := Load(p)
	if err != nil || !maps.Equal(c.SessionModels, want) {
		t.Fatalf("partial override: got %v, want %v, err %v", c.SessionModels, want, err)
	}
	for _, models := range []string{`null`, `[]`, `"opus"`, `{"other":"opus"}`, `{"codex":null}`, `{"agy":1}`, `{"claude":""}`, `{"codex":"--help"}`, `{"omo":"a b"}`} {
		if err := AtomicWrite(file, []byte(`{"models":`+models+`}`), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := Load(p); err == nil {
			t.Errorf("accepted models %s", models)
		}
	}
}

func TestProjectBoundariesAndAliases(t *testing.T) {
	root := t.TempDir()
	a := filepath.Join(root, "folder-1")
	b := filepath.Join(root, "folder-10")
	sub := filepath.Join(a, "sub")
	for _, p := range []string{a, b, sub} {
		if err := os.MkdirAll(p, 0700); err != nil {
			t.Fatal(err)
		}
	}
	a, _ = CanonicalDir(a)
	b, _ = CanonicalDir(b)
	sub, _ = CanonicalDir(sub)
	c := Defaults()
	c.Projects = []Project{{"a", []string{a}}, {"b", []string{b}}}
	if id, err := c.Resolve(sub, ""); err != nil || id != "a" {
		t.Fatalf("nested: %s %v", id, err)
	}
	if id, err := c.Resolve(b, ""); err != nil || id != "b" {
		t.Fatalf("prefix boundary: %s %v", id, err)
	}
	link := filepath.Join(root, "alias")
	if err := os.Symlink(a, link); err != nil {
		t.Fatal(err)
	}
	if id, err := c.Resolve(link, ""); err != nil || id != "a" {
		t.Fatalf("symlink: %s %v", id, err)
	}
	if _, err := c.ResolveWorkspaces([]string{a, b}); err == nil {
		t.Fatal("mixed roots accepted")
	}
	if _, err := c.Resolve(root, ""); err == nil {
		t.Fatal("unknown root accepted")
	}
}

func TestConfigDurableAndStrict(t *testing.T) {
	p, err := Locate(filepath.Join(t.TempDir(), "sniffer"))
	if err != nil {
		t.Fatal(err)
	}
	if err = Update(p, func(c *Config) error { c.Recall.WaitMillis = 30; return nil }); err != nil {
		t.Fatal(err)
	}
	c, err := Load(p)
	if err != nil || c.Recall.WaitMillis != 30 {
		t.Fatalf("%+v %v", c, err)
	}
	st, _ := os.Stat(p.Config)
	if st.Mode().Perm() != 0600 {
		t.Fatal("config is not private")
	}
	if err = os.WriteFile(p.Config, []byte(`{"schema_version":1,"unknown":true}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = Load(p); err == nil {
		t.Fatal("unknown fields accepted")
	}
}

func TestEinConfigOverlayBoundaries(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("EIN_CONFIG", "")
	t.Chdir(home)
	p, err := Locate(filepath.Join(home, "sniffer"))
	if err != nil {
		t.Fatal(err)
	}
	nested := filepath.Join(home, "workspace", "nested")
	if err := os.MkdirAll(nested, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(nested, filepath.Join(home, "alias")); err != nil {
		t.Fatal(err)
	}
	workspace, err := CanonicalDir(filepath.Dir(nested))
	if err != nil {
		t.Fatal(err)
	}
	if err := Update(p, func(c *Config) error {
		c.Projects = []Project{{ID: "terminal", Roots: []string{workspace}}}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(home, ".config", "ein", "config.json")
	if err := AtomicWrite(file, []byte(`{"projects":{"child":{"path":"../../alias"},"terminal":{"path":"~/workspace"}}}`), 0600); err != nil {
		t.Fatal(err)
	}
	for _, configPath := range []string{"", "~/.config/ein/config.json", ".config/ein/config.json"} {
		t.Setenv("EIN_CONFIG", configPath)
		c, err := Load(p)
		if err != nil {
			t.Fatal(err)
		}
		if root, err := c.Resolve(nested, ""); root != "child" || err != nil {
			t.Fatalf("nested symlink alias: %q %v", root, err)
		}
		if len(c.Projects) != 2 || len(c.Projects[0].Roots) != 1 {
			t.Fatalf("duplicate root: %+v", c.Projects)
		}
		if _, err := c.ResolveWorkspaces([]string{nested, workspace}); err == nil {
			t.Fatal("mixed workspace accepted")
		}
	}
	if err := AtomicWrite(file, []byte(`{"projects":{"different":{"path":"~/workspace"}}}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(p); err == nil {
		t.Fatal("same folder assigned to different projects")
	}
}
