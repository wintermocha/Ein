package store

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

	"ein.local/sniffer/internal/model"
)

const markerName = ".ein-store.json"
const markerBody = "{\"format\":\"sniffer-memory\",\"schema_version\":1}\n"

type Store struct {
	root  string
	state string
	// fault is an internal test seam for deterministic crash-boundary tests.
	fault func(string) error
}

type Result struct {
	Commit               string   `json:"commit,omitempty"`
	Revision             string   `json:"revision,omitempty"`
	MemoryID             string   `json:"memory_id,omitempty"`
	ChangedPaths         []string `json:"changed_paths,omitempty"`
	Preview              bool     `json:"preview,omitempty"`
	TargetScope          string   `json:"target_scope,omitempty"`
	NewlyVisibleProjects []string `json:"newly_visible_projects,omitempty"`
}

type Partial struct {
	New           model.Memory `json:"new"`
	RemainingBody string       `json:"remaining_body"`
}

func New(root, state string) *Store {
	if root != "" {
		if p, err := filepath.Abs(root); err == nil {
			root = p
		}
	}
	if state != "" {
		if p, err := filepath.Abs(state); err == nil {
			state = p
		}
	}
	return &Store{root: root, state: state}
}

func (s *Store) paths() error {
	if s.root == "" || s.state == "" {
		return fmt.Errorf("store and state paths are required")
	}
	if !filepath.IsAbs(s.root) || !filepath.IsAbs(s.state) {
		return fmt.Errorf("invalid store or state absolute path")
	}
	rootReal, err := canonicalFuturePath(s.root)
	if err != nil {
		return err
	}
	stateReal, err := canonicalFuturePath(s.state)
	if err != nil {
		return err
	}
	rel, err := filepath.Rel(rootReal, stateReal)
	if err != nil || rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator))) {
		return fmt.Errorf("state must be outside the memory Git repository")
	}
	for _, p := range []string{s.root, s.state} {
		info, err := os.Lstat(p)
		if err == nil && (!info.IsDir() || info.Mode()&os.ModeSymlink != 0) {
			return fmt.Errorf("path must be a real directory: %s", p)
		}
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

// Resolve existing ancestors while allowing not-yet-created leaf directories.
// This also catches a state path that enters the store through an ancestor link.
func canonicalFuturePath(name string) (string, error) {
	var suffix []string
	for {
		if _, err := os.Lstat(name); err == nil {
			base, err := filepath.EvalSymlinks(name)
			if err != nil {
				return "", err
			}
			for i := len(suffix) - 1; i >= 0; i-- {
				base = filepath.Join(base, suffix[i])
			}
			return base, nil
		} else if !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
		parent := filepath.Dir(name)
		if parent == name {
			return "", fmt.Errorf("cannot resolve store path")
		}
		suffix = append(suffix, filepath.Base(name))
		name = parent
	}
}

func (s *Store) lock(ctx context.Context) (func(), error) {
	if err := s.paths(); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(s.state, 0700); err != nil {
		return nil, err
	}
	name := filepath.Join(s.state, "store.lock")
	if info, err := os.Lstat(name); err == nil && !info.Mode().IsRegular() {
		return nil, fmt.Errorf("unsafe writer lock")
	}
	f, err := os.OpenFile(name, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	for {
		err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			return func() { _ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN); _ = f.Close() }, nil
		}
		if err != syscall.EWOULDBLOCK && err != syscall.EAGAIN {
			_ = f.Close()
			return nil, err
		}
		select {
		case <-ctx.Done():
			_ = f.Close()
			return nil, ctx.Err()
		case <-time.After(10 * time.Millisecond):
		}
	}
}

func gitEnv(extra []string) []string {
	env := []string{}
	for _, e := range os.Environ() {
		if !strings.HasPrefix(e, "GIT_") {
			env = append(env, e)
		}
	}
	env = append(env, "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null", "GIT_TERMINAL_PROMPT=0", "GIT_OPTIONAL_LOCKS=0")
	return append(env, extra...)
}

func (s *Store) git(ctx context.Context, input []byte, extra []string, args ...string) ([]byte, error) {
	base := []string{"-c", "user.name=Sniffer", "-c", "user.email=sniffer@localhost", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.quotePath=false", "-c", "core.autocrlf=false", "-c", "core.attributesFile=/dev/null", "-c", "core.excludesFile=/dev/null", "-C", s.root}
	cmd := exec.CommandContext(ctx, "git", append(base, args...)...)
	cmd.Env = gitEnv(extra)
	cmd.Stdin = bytes.NewReader(input)
	var out, stderr limitedBuffer
	out.limit, stderr.limit = 16<<20, 65536
	cmd.Stdout, cmd.Stderr = &out, &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("git %s: %w: %s", args[0], err, strings.TrimSpace(stderr.String()))
	}
	return out.Bytes(), nil
}

type limitedBuffer struct {
	bytes.Buffer
	limit int
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if len(p) > b.limit-b.Len() {
		return 0, fmt.Errorf("Git output exceeds size limit")
	}
	return b.Buffer.Write(p)
}

func (s *Store) Init(ctx context.Context) error {
	unlock, err := s.lock(ctx)
	if err != nil {
		return err
	}
	defer unlock()
	if err := os.MkdirAll(s.root, 0700); err != nil {
		return err
	}
	entries, err := os.ReadDir(s.root)
	if err != nil {
		return err
	}
	if len(entries) != 0 {
		_, err := s.Snapshot(ctx)
		if err != nil {
			return fmt.Errorf("refusing to initialize a nonempty or unrelated directory: %w", err)
		}
		return nil
	}
	if _, err := s.git(ctx, nil, nil, "rev-parse", "--show-toplevel"); err == nil {
		return fmt.Errorf("refusing to initialize inside an existing Git repository")
	}
	if _, err := s.git(ctx, nil, nil, "init", "--initial-branch=main"); err != nil {
		return err
	}
	registry, _ := json.MarshalIndent(model.Registry{SchemaVersion: 1, Scopes: []model.Scope{{ID: "global", Kind: "global"}}}, "", "  ")
	glossary, _ := json.MarshalIndent([][]string{{"기억", "memory"}, {"설정", "configuration", "config"}, {"인증", "authentication", "auth"}, {"재시도", "retry"}, {"멱등성", "idempotency"}, {"결제", "payment", "payments"}, {"테스트", "test", "testing"}, {"배포", "deploy", "deployment"}, {"오류", "error"}, {"언어", "language"}}, "", "  ")
	for name, data := range map[string][]byte{markerName: []byte(markerBody), "scopes.json": append(registry, '\n'), "glossary.json": append(glossary, '\n')} {
		if err := atomicWrite(filepath.Join(s.root, name), data, 0600); err != nil {
			return err
		}
	}
	if _, err := s.git(ctx, nil, nil, "add", "--", markerName, "scopes.json", "glossary.json"); err != nil {
		return err
	}
	_, err = s.git(ctx, nil, nil, "commit", "--no-gpg-sign", "-m", "Initialize independent Sniffer memory store")
	return err
}

func (s *Store) ensureRepo(ctx context.Context) error {
	if err := s.paths(); err != nil {
		return err
	}
	info, err := os.Lstat(filepath.Join(s.root, ".git"))
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("store must have its own real .git directory")
	}
	top, err := s.git(ctx, nil, nil, "rev-parse", "--show-toplevel")
	if err != nil {
		return err
	}
	realRoot, err := filepath.EvalSymlinks(s.root)
	if err != nil {
		return err
	}
	realTop, err := filepath.EvalSymlinks(strings.TrimSpace(string(top)))
	if err != nil || realTop != realRoot {
		return fmt.Errorf("store is not an independent Git repository")
	}
	return nil
}

func (s *Store) Snapshot(ctx context.Context) (model.Snapshot, error) {
	var snap model.Snapshot
	if err := s.ensureRepo(ctx); err != nil {
		return snap, err
	}
	head, err := s.git(ctx, nil, nil, "rev-parse", "--verify", "HEAD")
	if err != nil {
		return snap, err
	}
	snap.Commit = strings.TrimSpace(string(head))
	listing, err := s.git(ctx, nil, nil, "ls-tree", "-r", "-z", snap.Commit)
	if err != nil {
		return snap, err
	}
	entries := bytes.Split(bytes.TrimSuffix(listing, []byte{0}), []byte{0})
	if len(entries) > 10003 {
		return snap, fmt.Errorf("store has too many tracked files")
	}
	metadata := map[string][]byte{}
	ids := map[string]bool{}
	total := 0
	for _, entry := range entries {
		fields, name, ok := strings.Cut(string(entry), "\t")
		parts := strings.Fields(fields)
		if !ok || len(parts) != 3 || parts[0] != "100644" || parts[1] != "blob" {
			return snap, fmt.Errorf("unsupported Git tree entry (symlinks, gitlinks, executable files are forbidden)")
		}
		if !safeRelative(name) {
			return snap, fmt.Errorf("unsafe tracked path %q", name)
		}
		data, err := s.git(ctx, nil, nil, "cat-file", "blob", parts[2])
		if err != nil {
			return snap, err
		}
		total += len(data)
		if len(data) > 1<<20 || total > 64<<20 {
			return snap, fmt.Errorf("snapshot exceeds size limit")
		}
		switch name {
		case markerName, "scopes.json", "glossary.json":
			metadata[name] = data
		default:
			m, err := Parse(data)
			if err != nil {
				return snap, fmt.Errorf("%s: %w", name, err)
			}
			expected, err := model.ScopePath(m.ScopeID, m.ID)
			if err != nil || expected != name {
				return snap, fmt.Errorf("memory scope/ID does not match path %q", name)
			}
			if ids[m.ID] {
				return snap, fmt.Errorf("duplicate memory ID %q", m.ID)
			}
			ids[m.ID] = true
			m.Path, m.Revision = name, parts[2]
			snap.Memories = append(snap.Memories, m)
		}
	}
	if string(metadata[markerName]) != markerBody {
		return snap, fmt.Errorf("not a Sniffer memory store (missing committed marker)")
	}
	if err := strictJSON(metadata["scopes.json"], &snap.Registry); err != nil {
		return snap, fmt.Errorf("scopes.json: %w", err)
	}
	if err := model.ValidateRegistry(snap.Registry); err != nil {
		return snap, err
	}
	if err := strictJSON(metadata["glossary.json"], &snap.Glossary); err != nil {
		return snap, fmt.Errorf("glossary.json: %w", err)
	}
	if len(snap.Glossary) > 2048 {
		return snap, fmt.Errorf("glossary too large")
	}
	for _, group := range snap.Glossary {
		if len(group) < 2 || len(group) > 16 {
			return snap, fmt.Errorf("each glossary group requires 2 to 16 terms")
		}
		for _, term := range group {
			if strings.TrimSpace(term) == "" || len(term) > 256 || strings.ContainsRune(term, '\x00') {
				return snap, fmt.Errorf("invalid glossary term")
			}
		}
	}
	scopes := map[string]bool{}
	for _, scope := range snap.Registry.Scopes {
		scopes[scope.ID] = true
	}
	for _, m := range snap.Memories {
		if !scopes[m.ScopeID] {
			return snap, fmt.Errorf("memory %q has unregistered scope", m.ID)
		}
		if m.DerivedFrom != nil {
			if !ids[m.DerivedFrom.ID] {
				return snap, fmt.Errorf("memory %q refers to unknown provenance ID", m.ID)
			}
			if err := s.validateProvenance(ctx, m); err != nil {
				return snap, err
			}
		}
	}
	sort.Slice(snap.Memories, func(i, j int) bool { return snap.Memories[i].ID < snap.Memories[j].ID })
	return snap, nil
}

func (s *Store) validateProvenance(ctx context.Context, m model.Memory) error {
	if m.DerivedFrom == nil {
		return nil
	}
	if err := model.ValidateMemory(m); err != nil {
		return err
	}
	b, err := s.git(ctx, nil, nil, "cat-file", "blob", m.DerivedFrom.Revision)
	if err != nil {
		return fmt.Errorf("invalid provenance revision for %s: %w", m.ID, err)
	}
	original, err := Parse(b)
	if err != nil || original.ID != m.DerivedFrom.ID {
		return fmt.Errorf("provenance blob does not contain the declared memory ID")
	}
	return nil
}

func strictJSON(data []byte, out any) error {
	if len(data) == 0 {
		return fmt.Errorf("missing JSON document")
	}
	if !utf8.Valid(data) {
		return fmt.Errorf("JSON must be UTF-8")
	}
	// Token scanning rejects duplicate keys before decoding into typed structs.
	check := json.NewDecoder(bytes.NewReader(data))
	if err := checkJSONValue(check); err != nil {
		return err
	}
	if _, err := check.Token(); err != io.EOF {
		return fmt.Errorf("trailing JSON data")
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	return dec.Decode(out)
}

func checkJSONValue(dec *json.Decoder) error {
	t, err := dec.Token()
	if err != nil {
		return err
	}
	d, ok := t.(json.Delim)
	if !ok {
		return nil
	}
	switch d {
	case '{':
		seen := map[string]bool{}
		for dec.More() {
			k, err := dec.Token()
			if err != nil {
				return err
			}
			key, ok := k.(string)
			if !ok || seen[key] {
				return fmt.Errorf("duplicate or invalid JSON key")
			}
			seen[key] = true
			if err := checkJSONValue(dec); err != nil {
				return err
			}
		}
	case '[':
		for dec.More() {
			if err := checkJSONValue(dec); err != nil {
				return err
			}
		}
	default:
		return fmt.Errorf("invalid JSON delimiter")
	}
	_, err = dec.Token()
	return err
}

func safeRelative(name string) bool {
	return name != "" && name != "." && name != ".." && path.Clean(name) == name && !strings.HasPrefix(name, "/") && !strings.HasPrefix(name, "../") && !strings.ContainsAny(name, "\\\x00\r\n")
}

func safeChild(root, name string) (string, error) {
	if !safeRelative(name) {
		return "", fmt.Errorf("unsafe path %q", name)
	}
	current := root
	parts := strings.Split(name, "/")
	for i, part := range parts {
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return "", err
		}
		if info.Mode()&os.ModeSymlink != 0 || (i < len(parts)-1 && !info.IsDir()) || (i == len(parts)-1 && !info.Mode().IsRegular()) {
			return "", fmt.Errorf("unsafe filesystem path %q", name)
		}
	}
	return filepath.Join(root, filepath.FromSlash(name)), nil
}

func atomicWrite(name string, data []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(name), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(name), ".ein-write-*")
	if err != nil {
		return err
	}
	temp := f.Name()
	defer os.Remove(temp)
	if err := f.Chmod(mode); err != nil {
		_ = f.Close()
		return err
	}
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(temp, name); err != nil {
		return err
	}
	dir, err := os.Open(filepath.Dir(name))
	if err == nil {
		err = dir.Sync()
		_ = dir.Close()
	}
	return err
}
