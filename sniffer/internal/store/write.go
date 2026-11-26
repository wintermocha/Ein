package store

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"ein.local/sniffer/internal/model"
)

var requestPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

type fileChange struct {
	Path   string `json:"path"`
	Before []byte `json:"before"`
	After  []byte `json:"after"`
	Temp   string `json:"temp,omitempty"`
}
type journal struct {
	StoreRoot           string       `json:"store_root"`
	RequestID           string       `json:"request_id"`
	InputHash           string       `json:"input_hash"`
	BeforeCommit        string       `json:"before_commit"`
	AfterCommit         string       `json:"after_commit,omitempty"`
	Ref                 string       `json:"ref"`
	Changes             []fileChange `json:"changes"`
	IndexHash           string       `json:"index_hash,omitempty"`
	PreviousIndexHashes []string     `json:"previous_index_hashes,omitempty"`
	Status              string       `json:"status"`
	Result              Result       `json:"result"`
}
type plan struct {
	changes              map[string][]byte
	memoryID             string
	resultPath           string
	targetScope          string
	newlyVisibleProjects []string
}

func contentDigest(data []byte) string { h := sha256.Sum256(data); return hex.EncodeToString(h[:]) }
func cleanRuntime(m model.Memory) model.Memory {
	m.Path, m.Revision, m.ContentHash = "", "", ""
	return m
}

func (s *Store) Save(ctx context.Context, mem model.Memory, expectedRevision, requestID string) (Result, error) {
	mem = cleanRuntime(mem)
	input := struct {
		Operation string
		Memory    model.Memory
		Expected  string
	}{"save", mem, expectedRevision}
	return s.mutate(ctx, requestID, input, func(snap model.Snapshot) (plan, error) {
		p := plan{changes: map[string][]byte{}, memoryID: mem.ID}
		if _, err := model.Ancestors(snap.Registry, mem.ScopeID); err != nil {
			return p, err
		}
		old, exists := findMemory(snap, mem.ID)
		if err := checkRevision(old, exists, expectedRevision); err != nil {
			return p, err
		}
		if exists && old.ScopeID != mem.ScopeID {
			return p, fmt.Errorf("scope changes require memory promote")
		}
		if mem.DerivedFrom != nil {
			if _, exists := findMemory(snap, mem.DerivedFrom.ID); !exists {
				return p, fmt.Errorf("derived_from refers to an unknown memory ID")
			}
			if err := s.validateProvenance(ctx, mem); err != nil {
				return p, err
			}
		}
		data, err := Render(mem)
		if err != nil {
			return p, err
		}
		p.resultPath, err = model.ScopePath(mem.ScopeID, mem.ID)
		if err != nil {
			return p, err
		}
		p.changes[p.resultPath] = data
		return p, nil
	})
}

func (s *Store) AddScope(ctx context.Context, scope model.Scope, requestID string) (Result, error) {
	input := struct {
		Operation string
		Scope     model.Scope
	}{"add-scope", scope}
	return s.mutate(ctx, requestID, input, func(snap model.Snapshot) (plan, error) {
		p := plan{changes: map[string][]byte{}}
		snap.Registry.Scopes = append(snap.Registry.Scopes, scope)
		if err := model.ValidateRegistry(snap.Registry); err != nil {
			return p, err
		}
		data, err := json.MarshalIndent(snap.Registry, "", "  ")
		if err != nil {
			return p, err
		}
		p.changes["scopes.json"] = append(data, '\n')
		return p, nil
	})
}

func (s *Store) Promote(ctx context.Context, id, target, expectedRevision, requestID string, partial *Partial, dryRun bool) (Result, error) {
	if partial != nil {
		copy := *partial
		copy.New = cleanRuntime(copy.New)
		partial = &copy
	}
	build := func(snap model.Snapshot) (plan, error) {
		p := plan{changes: map[string][]byte{}, memoryID: id}
		old, exists := findMemory(snap, id)
		if !exists {
			return p, fmt.Errorf("memory %q does not exist", id)
		}
		if err := checkRevision(old, true, expectedRevision); err != nil {
			return p, err
		}
		ancestors, err := model.Ancestors(snap.Registry, old.ScopeID)
		if err != nil {
			return p, err
		}
		allowed := false
		for _, scope := range ancestors[1:] {
			if scope == target {
				allowed = true
			}
		}
		if !allowed {
			return p, fmt.Errorf("promotion target must be a strict ancestor of %s", old.ScopeID)
		}
		p.targetScope = target
		parents := map[string]string{}
		for _, scope := range snap.Registry.Scopes {
			parents[scope.ID] = scope.Parent
		}
		for _, candidate := range snap.Registry.Scopes {
			if candidate.Kind != "project" {
				continue
			}
			before, after := false, false
			for scope := candidate.ID; scope != ""; scope = parents[scope] {
				if scope == old.ScopeID {
					before = true
				}
				if scope == target {
					after = true
				}
			}
			if after && !before {
				p.newlyVisibleProjects = append(p.newlyVisibleProjects, candidate.ID)
			}
		}
		sort.Strings(p.newlyVisibleProjects)
		if partial == nil {
			m := old
			m.ScopeID = target
			data, err := Render(m)
			if err != nil {
				return p, err
			}
			p.resultPath, err = model.ScopePath(target, id)
			if err != nil {
				return p, err
			}
			p.changes[old.Path], p.changes[p.resultPath] = nil, data
		} else {
			shared := partial.New
			if shared.ID == id || shared.ScopeID != target {
				return p, fmt.Errorf("partial promotion requires a new ID and the target scope")
			}
			if _, exists := findMemory(snap, shared.ID); exists {
				return p, fmt.Errorf("new shared memory ID already exists")
			}
			if strings.TrimSpace(partial.RemainingBody) == "" || strings.TrimSpace(partial.RemainingBody) == strings.TrimSpace(old.Body) {
				return p, fmt.Errorf("partial promotion requires an explicitly edited remaining body")
			}
			if strings.Contains(strings.TrimSpace(partial.RemainingBody), strings.TrimSpace(shared.Body)) {
				return p, fmt.Errorf("remaining body still contains the entire shared body")
			}
			shared.DerivedFrom = &model.Provenance{ID: old.ID, Revision: old.Revision}
			sharedData, err := Render(shared)
			if err != nil {
				return p, err
			}
			old.Body = strings.TrimSpace(partial.RemainingBody) + "\n\n공유 기억 참조: `" + shared.ID + "` (" + target + ")."
			remainingData, err := Render(old)
			if err != nil {
				return p, err
			}
			p.memoryID = shared.ID
			p.resultPath, err = model.ScopePath(target, shared.ID)
			if err != nil {
				return p, err
			}
			p.changes[p.resultPath], p.changes[old.Path] = sharedData, remainingData
		}
		return p, nil
	}
	if dryRun {
		snap, err := s.Snapshot(ctx)
		if err != nil {
			return Result{}, err
		}
		p, err := build(snap)
		if err != nil {
			return Result{}, err
		}
		return Result{Commit: snap.Commit, MemoryID: p.memoryID, ChangedPaths: sortedPaths(p.changes), Preview: true, TargetScope: p.targetScope, NewlyVisibleProjects: p.newlyVisibleProjects}, nil
	}
	input := struct {
		Operation, ID, Target, Expected string
		Partial                         *Partial
	}{"promote", id, target, expectedRevision, partial}
	return s.mutate(ctx, requestID, input, build)
}

func findMemory(snap model.Snapshot, id string) (model.Memory, bool) {
	for _, m := range snap.Memories {
		if m.ID == id {
			return m, true
		}
	}
	return model.Memory{}, false
}
func checkRevision(old model.Memory, exists bool, expected string) error {
	if expected == "new" {
		if exists {
			return fmt.Errorf("revision conflict: memory already exists")
		}
		return nil
	}
	if !exists || expected == "" || old.Revision != expected {
		return fmt.Errorf("revision conflict: expected blob revision does not match")
	}
	return nil
}
func sortedPaths(changes map[string][]byte) []string {
	out := make([]string, 0, len(changes))
	for name := range changes {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

func (s *Store) journalPath(requestID string) (string, error) {
	return safeChild(s.state, "transactions/"+contentDigest([]byte(requestID))+".json")
}
func (s *Store) writeJournal(j journal) error {
	name, err := s.journalPath(j.RequestID)
	if err != nil {
		return err
	}
	b, err := json.MarshalIndent(j, "", "  ")
	if err != nil {
		return err
	}
	return atomicWrite(name, append(b, '\n'), 0600)
}
func (s *Store) readJournal(requestID string) (*journal, error) {
	name, err := s.journalPath(requestID)
	if err != nil {
		return nil, err
	}
	b, err := os.ReadFile(name)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if len(b) > 4<<20 {
		return nil, fmt.Errorf("oversized transaction journal")
	}
	var j journal
	if err := strictJSON(b, &j); err != nil {
		return nil, err
	}
	if j.RequestID != requestID {
		return nil, fmt.Errorf("journal request ID mismatch")
	}
	root, err := canonicalFuturePath(s.root)
	if err != nil {
		return nil, err
	}
	if j.StoreRoot != root {
		return nil, fmt.Errorf("transaction journal belongs to a different store")
	}
	for _, ch := range j.Changes {
		if !safeRelative(ch.Path) || strings.HasPrefix(ch.Path, ".git/") || ch.Path == ".git" {
			return nil, fmt.Errorf("unsafe journal path")
		}
		if ch.Temp != "" && (!safeRelative(ch.Temp) || filepath.Dir(ch.Temp) != filepath.Dir(ch.Path) || !strings.HasPrefix(filepath.Base(ch.Temp), ".ein-tmp-")) {
			return nil, fmt.Errorf("unsafe journal temporary path")
		}
	}
	return &j, nil
}

func (s *Store) clean(ctx context.Context) error {
	status, err := s.git(ctx, nil, nil, "status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching")
	if err != nil {
		return err
	}
	if len(status) != 0 {
		return fmt.Errorf("store working tree is dirty; refusing to include external edits:\n%s", status)
	}
	return nil
}

func (s *Store) mutate(ctx context.Context, requestID string, input any, build func(model.Snapshot) (plan, error)) (result Result, err error) {
	if !requestPattern.MatchString(requestID) {
		return result, fmt.Errorf("request ID must be 1 to 128 safe ASCII characters")
	}
	encoded, err := json.Marshal(input)
	if err != nil {
		return result, err
	}
	inputHash := contentDigest(encoded)
	unlock, err := s.lock(ctx)
	if err != nil {
		return result, err
	}
	defer unlock()
	snap, err := s.Snapshot(ctx)
	if err != nil {
		return result, err
	}
	old, err := s.readJournal(requestID)
	if err != nil {
		return result, err
	}
	if old != nil {
		if old.InputHash != inputHash {
			return result, fmt.Errorf("request ID already used with a different input")
		}
		if old.Status == "complete" {
			return old.Result, nil
		}
		if old.Status == "ready" && old.AfterCommit != "" && snap.Commit != old.BeforeCommit {
			return s.recoverLocked(ctx, requestID)
		}
		if old.Status != "rolled-back" {
			return result, fmt.Errorf("unfinished transaction %s; run memory recover with this request ID", requestID)
		}
	} else if found, err := s.committedRequest(ctx, requestID, inputHash); err != nil || found != nil {
		if err != nil {
			return result, err
		}
		return *found, nil
	}
	if err := s.clean(ctx); err != nil {
		return result, err
	}
	p, err := build(snap)
	if err != nil {
		return result, err
	}
	refBytes, err := s.git(ctx, nil, nil, "symbolic-ref", "-q", "HEAD")
	if err != nil {
		return result, fmt.Errorf("writes require a named Git branch: %w", err)
	}
	storeRoot, err := canonicalFuturePath(s.root)
	if err != nil {
		return result, err
	}
	j := journal{StoreRoot: storeRoot, RequestID: requestID, InputHash: inputHash, BeforeCommit: snap.Commit, Ref: strings.TrimSpace(string(refBytes)), Status: "prepared", Result: Result{MemoryID: p.memoryID, ChangedPaths: sortedPaths(p.changes), TargetScope: p.targetScope, NewlyVisibleProjects: p.newlyVisibleProjects}}
	for _, name := range j.Result.ChangedPaths {
		full, err := safeChild(s.root, name)
		if err != nil {
			return result, err
		}
		before, err := os.ReadFile(full)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return result, err
		}
		if errors.Is(err, os.ErrNotExist) {
			before = nil
		}
		temp := filepath.ToSlash(filepath.Join(filepath.Dir(name), ".ein-tmp-"+contentDigest([]byte(requestID))[:16]+"-"+filepath.Base(name)))
		j.Changes = append(j.Changes, fileChange{Path: name, Before: before, After: p.changes[name], Temp: temp})
	}
	if err := s.writeJournal(j); err != nil {
		return result, err
	}
	defer func() {
		if err != nil {
			err = fmt.Errorf("transaction %s needs recovery: %w", requestID, err)
		}
	}()
	if err := s.acquireIndex(j); err != nil {
		return result, err
	}
	for _, ch := range j.Changes {
		if err := s.applyPlannedFile(ch); err != nil {
			return result, err
		}
	}
	if err := s.fail("after-files"); err != nil {
		return result, err
	}
	index, err := s.privateIndex(ctx, j.BeforeCommit, j.Changes)
	if err != nil {
		return result, err
	}
	defer os.Remove(index)
	indexBytes, err := os.ReadFile(index)
	if err != nil {
		return result, err
	}
	tree, err := s.git(ctx, nil, []string{"GIT_INDEX_FILE=" + index}, "write-tree")
	if err != nil {
		return result, err
	}
	if p.resultPath != "" {
		blob, err := s.git(ctx, p.changes[p.resultPath], nil, "hash-object", "--no-filters", "--stdin")
		if err != nil {
			return result, err
		}
		j.Result.Revision = strings.TrimSpace(string(blob))
	}
	resultJSON, _ := json.Marshal(j.Result)
	message := "Sniffer memory transaction\n\nSniffer-Request-ID: " + requestID + "\nSniffer-Input-Hash: " + inputHash + "\nSniffer-Result: " + base64.RawStdEncoding.EncodeToString(resultJSON) + "\n"
	commit, err := s.git(ctx, []byte(message), nil, "commit-tree", strings.TrimSpace(string(tree)), "-p", snap.Commit)
	if err != nil {
		return result, err
	}
	j.AfterCommit = strings.TrimSpace(string(commit))
	j.Result.Commit = j.AfterCommit
	j.IndexHash = contentDigest(indexBytes)
	j.Status = "ready"
	if err := s.writeJournal(j); err != nil {
		return result, err
	}
	if err := s.fail("before-ref"); err != nil {
		return result, err
	}
	if _, err := s.git(ctx, nil, nil, "update-ref", j.Ref, j.AfterCommit, j.BeforeCommit); err != nil {
		return result, err
	}
	if err := s.fail("after-ref"); err != nil {
		return result, err
	}
	if err := s.publishIndex(j, indexBytes); err != nil {
		return result, err
	}
	if err := s.fail("after-index-published"); err != nil {
		return result, err
	}
	j.Status = "complete"
	if err := s.writeJournal(j); err != nil {
		return result, err
	}
	return j.Result, nil
}

func (s *Store) fail(point string) error {
	if s.fault != nil {
		return s.fault(point)
	}
	return nil
}
func indexToken(j journal) []byte {
	return []byte("Sniffer-owned-index-lock:" + contentDigest([]byte(j.RequestID)) + "\n")
}
func (s *Store) indexLockPath() string { return filepath.Join(s.root, ".git", "index.lock") }
func (s *Store) acquireIndex(j journal) error {
	f, err := os.OpenFile(s.indexLockPath(), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return fmt.Errorf("Git index is locked: %w", err)
	}
	if _, err := f.Write(indexToken(j)); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return err
	}
	return f.Close()
}
func (s *Store) ownIndexLock(j journal) (bool, error) {
	name, err := safeChild(s.root, ".git/index.lock")
	if err != nil {
		return false, err
	}
	b, err := os.ReadFile(name)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if bytes.Equal(b, indexToken(j)) || (j.IndexHash != "" && contentDigest(b) == j.IndexHash) {
		return true, nil
	}
	for _, known := range j.PreviousIndexHashes {
		if known != "" && contentDigest(b) == known {
			return true, nil
		}
	}
	return false, fmt.Errorf("index.lock does not belong to this transaction")
}
func (s *Store) publishIndex(j journal, index []byte) error {
	owned, err := s.ownIndexLock(j)
	if err != nil {
		return err
	}
	if !owned {
		return fmt.Errorf("transaction index lock is missing")
	}
	if err := atomicWrite(s.indexLockPath(), index, 0600); err != nil {
		return err
	}
	if err := s.fail("after-index"); err != nil {
		return err
	}
	return os.Rename(s.indexLockPath(), filepath.Join(s.root, ".git", "index"))
}
func (s *Store) privateIndex(ctx context.Context, commit string, changes []fileChange) (string, error) {
	f, err := os.CreateTemp(s.state, "index-*")
	if err != nil {
		return "", err
	}
	name := f.Name()
	_ = f.Close()
	_ = os.Remove(name)
	ok := false
	defer func() {
		if !ok {
			_ = os.Remove(name)
		}
	}()
	env := []string{"GIT_INDEX_FILE=" + name}
	if _, err := s.git(ctx, nil, env, "read-tree", commit); err != nil {
		return "", err
	}
	for _, ch := range changes {
		if ch.After == nil {
			if _, err := s.git(ctx, nil, env, "update-index", "--force-remove", "--", ch.Path); err != nil {
				return "", err
			}
			continue
		}
		blob, err := s.git(ctx, ch.After, nil, "hash-object", "--no-filters", "-w", "--stdin")
		if err != nil {
			return "", err
		}
		if _, err := s.git(ctx, nil, env, "update-index", "--add", "--cacheinfo", "100644,"+strings.TrimSpace(string(blob))+","+ch.Path); err != nil {
			return "", err
		}
	}
	ok = true
	return name, nil
}
func (s *Store) applyFile(name string, data []byte) error {
	full, err := safeChild(s.root, name)
	if err != nil {
		return err
	}
	if data == nil {
		err := os.Remove(full)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	return atomicWrite(full, data, 0600)
}

// The temporary name is recorded before use so a crash after fsync but before
// rename leaves a file whose ownership and exact bytes recovery can verify.
func (s *Store) applyPlannedFile(ch fileChange) error {
	if ch.After == nil {
		return s.applyFile(ch.Path, nil)
	}
	full, err := safeChild(s.root, ch.Path)
	if err != nil {
		return err
	}
	temp, err := safeChild(s.root, ch.Temp)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(full), 0700); err != nil {
		return err
	}
	f, err := os.OpenFile(temp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer os.Remove(temp)
	if _, err := f.Write(ch.After); err != nil {
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
	if err := os.Rename(temp, full); err != nil {
		return err
	}
	d, err := os.Open(filepath.Dir(full))
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

func (s *Store) committedRequest(ctx context.Context, requestID, inputHash string) (*Result, error) {
	commits, err := s.git(ctx, nil, nil, "log", "--all", "--format=%H", "--fixed-strings", "--grep=Sniffer-Request-ID: "+requestID)
	if err != nil {
		return nil, err
	}
	for _, commit := range strings.Fields(string(commits)) {
		message, err := s.git(ctx, nil, nil, "show", "-s", "--format=%B", commit)
		if err != nil {
			return nil, err
		}
		fields := map[string]string{}
		for _, line := range strings.Split(string(message), "\n") {
			k, v, ok := strings.Cut(line, ": ")
			if ok {
				fields[k] = v
			}
		}
		if fields["Sniffer-Request-ID"] != requestID {
			continue
		}
		if fields["Sniffer-Input-Hash"] != inputHash {
			return nil, fmt.Errorf("request ID already committed with a different input")
		}
		b, err := base64.RawStdEncoding.DecodeString(fields["Sniffer-Result"])
		if err != nil {
			return nil, fmt.Errorf("invalid transaction commit trailer")
		}
		var result Result
		if err := strictJSON(b, &result); err != nil {
			return nil, err
		}
		result.Commit = commit
		return &result, nil
	}
	return nil, nil
}

// Recover only repairs the recorded files when their bytes and HEAD are known.
// Ambiguous user edits or unrelated Git changes are left intact and reported.
func (s *Store) Recover(ctx context.Context, requestID string) (Result, error) {
	if !requestPattern.MatchString(requestID) {
		return Result{}, fmt.Errorf("invalid request ID")
	}
	unlock, err := s.lock(ctx)
	if err != nil {
		return Result{}, err
	}
	defer unlock()
	return s.recoverLocked(ctx, requestID)
}

func (s *Store) recoverLocked(ctx context.Context, requestID string) (Result, error) {
	if err := s.ensureRepo(ctx); err != nil {
		return Result{}, err
	}
	j, err := s.readJournal(requestID)
	if err != nil {
		return Result{}, err
	}
	if j == nil {
		return Result{}, fmt.Errorf("no transaction journal for request %q", requestID)
	}
	if j.Status == "complete" {
		return j.Result, nil
	}
	if j.Status == "rolled-back" {
		return Result{Commit: j.BeforeCommit}, nil
	}
	head, err := s.git(ctx, nil, nil, "rev-parse", "HEAD")
	if err != nil {
		return Result{}, err
	}
	current := strings.TrimSpace(string(head))
	owned, err := s.ownIndexLock(*j)
	if err != nil {
		return Result{}, err
	}
	committed := current == j.AfterCommit && j.AfterCommit != ""
	if current != j.BeforeCommit && !committed {
		// A fully published commit can be followed by another writer before its
		// final journal update. Recognizing that immutable ancestor needs no file
		// rollback: only finish the receipt, with a clean index and no lock.
		if j.AfterCommit != "" && !owned {
			if _, ancestorErr := s.git(ctx, nil, nil, "merge-base", "--is-ancestor", j.AfterCommit, current); ancestorErr == nil {
				if cleanErr := s.clean(ctx); cleanErr == nil {
					j.Status = "complete"
					if err := s.writeJournal(*j); err != nil {
						return Result{}, err
					}
					return j.Result, nil
				}
			}
		}
		return Result{}, fmt.Errorf("HEAD changed outside this transaction; refusing automatic recovery")
	}
	for _, ch := range j.Changes {
		name, err := safeChild(s.root, ch.Path)
		if err != nil {
			return Result{}, err
		}
		b, err := os.ReadFile(name)
		if errors.Is(err, os.ErrNotExist) {
			b = nil
		} else if err != nil {
			return Result{}, err
		}
		if committed {
			if !sameFile(b, ch.After) {
				return Result{}, fmt.Errorf("recovery refuses unknown edit to %s", ch.Path)
			}
		} else if !sameFile(b, ch.Before) && !sameFile(b, ch.After) {
			return Result{}, fmt.Errorf("recovery refuses unknown edit to %s", ch.Path)
		}
		if ch.Temp != "" {
			temp, err := safeChild(s.root, ch.Temp)
			if err != nil {
				return Result{}, err
			}
			tempBytes, err := os.ReadFile(temp)
			if err != nil && !errors.Is(err, os.ErrNotExist) {
				return Result{}, err
			}
			if err == nil && !sameFile(tempBytes, ch.After) {
				return Result{}, fmt.Errorf("recovery refuses unknown temporary file %s", ch.Temp)
			}
		}
	}
	for _, ch := range j.Changes {
		if ch.Temp != "" {
			full, err := safeChild(s.root, ch.Temp)
			if err != nil {
				return Result{}, err
			}
			if err := os.Remove(full); err != nil && !errors.Is(err, os.ErrNotExist) {
				return Result{}, err
			}
		}
	}
	if !committed {
		for _, ch := range j.Changes {
			if err := s.applyFile(ch.Path, ch.Before); err != nil {
				return Result{}, err
			}
		}
		if owned {
			if err := os.Remove(s.indexLockPath()); err != nil {
				return Result{}, err
			}
		}
		j.Status = "rolled-back"
		if err := s.writeJournal(*j); err != nil {
			return Result{}, err
		}
		return Result{Commit: j.BeforeCommit, ChangedPaths: j.Result.ChangedPaths}, nil
	}
	if owned {
		index, err := s.privateIndex(ctx, j.AfterCommit, nil)
		if err != nil {
			return Result{}, err
		}
		defer os.Remove(index)
		b, err := os.ReadFile(index)
		if err != nil {
			return Result{}, err
		}
		newHash := contentDigest(b)
		if j.IndexHash != "" && j.IndexHash != newHash {
			j.PreviousIndexHashes = append(j.PreviousIndexHashes, j.IndexHash)
		}
		j.IndexHash = newHash
		if err := s.writeJournal(*j); err != nil {
			return Result{}, err
		}
		if err := s.publishIndex(*j, b); err != nil {
			return Result{}, err
		}
	} else if err := s.clean(ctx); err != nil {
		return Result{}, fmt.Errorf("index lock was lost and worktree is not clean: %w", err)
	}
	j.Status = "complete"
	if err := s.writeJournal(*j); err != nil {
		return Result{}, err
	}
	return j.Result, nil
}
func sameFile(a, b []byte) bool { return (a == nil) == (b == nil) && bytes.Equal(a, b) }

// EinProjectSnapshot materializes only the selected project. The existing
// registry owns its ancestry, including groups configured before Slack.
func (s *Store) EinProjectSnapshot(ctx context.Context, id string) (model.Snapshot, error) {
	snap, err := s.Snapshot(ctx)
	if err != nil {
		if err = s.Init(ctx); err != nil {
			return snap, err
		}
		snap, err = s.Snapshot(ctx)
		if err != nil {
			return snap, err
		}
	}
	scope := model.Scope{ID: "project:" + id, Kind: "project", Parent: "global"}
	if _, err := model.Ancestors(snap.Registry, scope.ID); err == nil {
		return snap, nil
	}
	// AddScope serializes Git writers and replays a concurrent first use.
	_, addErr := s.AddScope(ctx, scope, "ein-project-"+id+"-"+snap.Commit)
	snap, err = s.Snapshot(ctx)
	if err != nil {
		return snap, err
	}
	// A concurrent manual registration can legitimately select a group parent.
	if _, err = model.Ancestors(snap.Registry, scope.ID); err == nil {
		return snap, nil
	}
	if addErr != nil {
		return snap, addErr
	}
	return snap, err
}
