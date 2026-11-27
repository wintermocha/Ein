// Package config manages machine-local configuration outside the memory Git tree.
package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
)

type Paths struct{ Home, Config, Store, State, Run, Adapters string }
type Project struct {
	ID    string   `json:"id"`
	Roots []string `json:"roots"`
}
type HostAgent struct {
	Executable string `json:"executable,omitempty"`
	Agent      string `json:"agent,omitempty"`
}
type Recall struct {
	OutputCount    int `json:"output_count"`
	OutputBytes    int `json:"output_bytes"`
	WaitMillis     int `json:"wait_millis"`
	TimeoutSeconds int `json:"timeout_seconds"`
}
type Config struct {
	einProjects   map[string]bool
	SessionModels map[string]string    `json:"-"`
	SchemaVersion int                  `json:"schema_version"`
	Folders       []FolderRegistration `json:"folders,omitempty"`
	Projects      []Project            `json:"projects"`
	Agents        map[string]HostAgent `json:"agents"`
	Recall        Recall               `json:"recall"`
}

func Defaults() Config {
	return Config{SchemaVersion: 1, Projects: []Project{}, Agents: map[string]HostAgent{
		"claude": {Executable: "claude"}, "codex": {Executable: "codex"}, "agy": {Executable: "agy", Agent: "sniffer-memory-agent"},
	}, Recall: Recall{3, 12 * 1024, 1000, 60}}
}

func Locate(override string) (Paths, error) {
	base := override
	if base == "" {
		base = os.Getenv("EIN_HOME")
	}
	if base == "" {
		h, err := os.UserHomeDir()
		if err != nil {
			return Paths{}, err
		}
		base = filepath.Join(h, ".ein")
	}
	if strings.HasPrefix(base, "~/") {
		h, err := os.UserHomeDir()
		if err != nil {
			return Paths{}, err
		}
		base = filepath.Join(h, base[2:])
	}
	abs, err := filepath.Abs(base)
	if err != nil {
		return Paths{}, err
	}
	abs = filepath.Clean(abs)
	if abs == string(filepath.Separator) {
		return Paths{}, errors.New("Sniffer home cannot be the filesystem root")
	}
	// Resolve the nearest existing ancestor, including symlinked home directories.
	base = abs
	var suffix []string
	for {
		_, e := os.Lstat(base)
		if e == nil {
			break
		}
		if !os.IsNotExist(e) {
			return Paths{}, e
		}
		suffix = append(suffix, filepath.Base(base))
		parent := filepath.Dir(base)
		if parent == base {
			return Paths{}, errors.New("cannot resolve Sniffer home")
		}
		base = parent
	}
	base, err = filepath.EvalSymlinks(base)
	if err != nil {
		return Paths{}, err
	}
	for i := len(suffix) - 1; i >= 0; i-- {
		base = filepath.Join(base, suffix[i])
	}
	return Paths{Home: base, Config: filepath.Join(base, "config.json"), Store: filepath.Join(base, "memory", "store"), State: filepath.Join(base, "memory", "state"), Run: filepath.Join(base, "run"), Adapters: filepath.Join(base, "adapters")}, nil
}

func loadLocal(p Paths) (Config, error) {
	c := Defaults()
	b, err := os.ReadFile(p.Config)
	if os.IsNotExist(err) {
		return c, nil
	}
	if err != nil {
		return c, err
	}
	if len(b) > 1<<20 {
		return c, errors.New("configuration is too large")
	}
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	if err = d.Decode(&c); err != nil {
		return c, fmt.Errorf("config: %w", err)
	}
	var tail any
	if d.Decode(&tail) != io.EOF {
		return c, errors.New("config has trailing data")
	}
	return c, Validate(c)
}

var slug = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)

func ValidID(id string) bool { return slug.MatchString(id) }
func Validate(c Config) error {
	if c.SchemaVersion != 1 {
		return errors.New("unsupported config schema")
	}
	for _, h := range []string{"claude", "codex", "agy"} {
		if _, ok := c.Agents[h]; !ok {
			return fmt.Errorf("missing native agent configuration for %s", h)
		}
	}
	ids := map[string]bool{}
	roots := map[string]string{}
	for _, p := range c.Projects {
		if !ValidID(p.ID) || ids[p.ID] || len(p.Roots) == 0 {
			return fmt.Errorf("invalid or duplicate project %q", p.ID)
		}
		ids[p.ID] = true
		for _, root := range p.Roots {
			if !filepath.IsAbs(root) || filepath.Clean(root) != root {
				return fmt.Errorf("project root must be canonical absolute path: %q", root)
			}
			if prior, ok := roots[root]; ok {
				return fmt.Errorf("root %q is mapped more than once (%s, %s)", root, prior, p.ID)
			}
			roots[root] = p.ID
		}
	}
	folderRoots := map[string]bool{}
	for _, folder := range c.Folders {
		root := folder.Root
		if folderRoots[root] {
			return errors.New("duplicate folder root")
		}
		folderRoots[root] = true
		if !filepath.IsAbs(root) || filepath.Clean(root) != root {
			return errors.New("invalid folder root")
		}
	}
	r := c.Recall
	if r.OutputCount < 1 || r.OutputCount > 3 || r.OutputBytes < 256 || r.OutputBytes > 32*1024 || r.WaitMillis < 0 || r.WaitMillis > 5000 || r.TimeoutSeconds < 1 || r.TimeoutSeconds > 120 {
		return errors.New("recall limits are outside supported bounds")
	}
	for h, j := range c.Agents {
		if h != "claude" && h != "codex" && h != "agy" {
			return fmt.Errorf("unknown native agent host %q", h)
		}
		if j.Executable == "" || strings.ContainsAny(j.Executable, "\x00\r\n") {
			return fmt.Errorf("invalid %s executable", h)
		}
	}
	return nil
}

func CanonicalDir(path string) (string, error) {
	a, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	a, err = filepath.EvalSymlinks(a)
	if err != nil {
		return "", err
	}
	st, err := os.Stat(a)
	if err != nil {
		return "", err
	}
	if !st.IsDir() {
		return "", errors.New("project path is not a directory")
	}
	return filepath.Clean(a), nil
}
func Within(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

// Resolve selects the longest matching path component prefix, never a raw string
// prefix. An explicit ID is an operator-selected scope for standalone commands.
func (c Config) Resolve(path, explicit string) (string, error) {
	if explicit != "" {
		explicit = strings.TrimPrefix(explicit, "project:")
		for _, p := range c.Projects {
			if p.ID == explicit {
				return explicit, nil
			}
		}
		return "", fmt.Errorf("unregistered project %q", explicit)
	}
	folder, err := c.Folder(path)
	if err != nil {
		return "", err
	}
	return folder.BindingID()
}

// ResolveWorkspaces refuses a mixed or unknown workspace rather than merging scopes.
func (c Config) ResolveWorkspaces(paths []string) (string, error) {
	if len(paths) == 0 {
		return "", errors.New("host event has no workspace path")
	}
	id, root := "", ""
	for _, path := range paths {
		f, err := c.Folder(path)
		if err != nil {
			return "", err
		}
		currentRoot := ""
		if f.Bound {
			currentRoot = f.Root
		}
		if id != "" && root != currentRoot {
			return "", errors.New("workspace spans different folders")
		}
		root = currentRoot
		p, err := f.BindingID()
		if err != nil {
			return "", err
		}
		if id != "" && id != p {
			return "", errors.New("workspace spans different Sniffer projects")
		}
		id = p
	}
	return id, nil
}

func Update(p Paths, change func(*Config) error) error {
	if err := os.MkdirAll(p.Home, 0700); err != nil {
		return err
	}
	f, err := os.OpenFile(filepath.Join(p.Home, "config.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	if err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		return err
	}
	defer syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	c, err := loadLocal(p)
	if err != nil {
		return err
	}
	if err = change(&c); err != nil {
		return err
	}
	if err = Validate(c); err != nil {
		return err
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return AtomicWrite(p.Config, append(b, '\n'), 0600)
}

func AtomicWrite(path string, b []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".ein-write-")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if err = f.Chmod(mode); err == nil {
		_, err = f.Write(b)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err = os.Rename(tmp, path); err != nil {
		return err
	}
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
