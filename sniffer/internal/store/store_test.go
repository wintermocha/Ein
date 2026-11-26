package store

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"

	"ein.local/sniffer/internal/model"
)

func fixtureMemory(id, scope string) model.Memory {
	return model.Memory{SchemaVersion: 1, ID: id, ScopeID: scope, Description: "가상의 결제 재시도 설정", Key: "payments.retry", Aliases: []string{"idempotency", "멱등성"}, Body: "같은 결제 요청은 같은 멱등 키로 재시도한다.\n로컬 지연은 150 ms다."}
}
func newStore(t *testing.T) *Store {
	t.Helper()
	d := t.TempDir()
	s := New(filepath.Join(d, "store"), filepath.Join(d, "state"))
	if err := s.Init(context.Background()); err != nil {
		t.Fatal(err)
	}
	return s
}
func addScope(t *testing.T, s *Store, id, parent string) {
	t.Helper()
	kind := strings.SplitN(id, ":", 2)[0]
	if _, err := s.AddScope(context.Background(), model.Scope{ID: id, Kind: kind, Parent: parent}, "scope-"+strings.ReplaceAll(id, ":", "-")); err != nil {
		t.Fatal(err)
	}
}
func save(t *testing.T, s *Store, m model.Memory, expected, req string) Result {
	t.Helper()
	r, err := s.Save(context.Background(), m, expected, req)
	if err != nil {
		t.Fatal(err)
	}
	return r
}
func snapshot(t *testing.T, s *Store) model.Snapshot {
	t.Helper()
	snap, err := s.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return snap
}
func gitTest(t *testing.T, s *Store, args ...string) string {
	t.Helper()
	out, err := s.git(context.Background(), nil, nil, args...)
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(out))
}

func TestStrictFrontmatterRoundTrip(t *testing.T) {
	m := fixtureMemory("m-sample", "global")
	m.UpdatedAt = "2026-11-25T00:00:00Z"
	b, err := Render(m)
	if err != nil {
		t.Fatal(err)
	}
	got, err := Parse(b)
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != m.ID || got.Body != m.Body || got.ContentHash != model.HashMemory(m) {
		t.Fatalf("bad round trip: %+v", got)
	}
	base := "---\nschema_version: 1\nid: m-example\nscope_id: global\ndescription: hello\n---\nbody\n"
	for _, tc := range []struct{ name, document string }{
		{"missing-description", strings.Replace(base, "description: hello\n", "", 1)},
		{"empty-description", strings.Replace(base, "description: hello", "description: ' '", 1)},
		{"duplicate", strings.Replace(base, "description: hello", "description: hello\ndescription: duplicate", 1)},
		{"unknown", strings.Replace(base, "description: hello", "description: hello\npath: /tmp/a", 1)},
		{"wrong-type", strings.Replace(base, "description: hello", "description: 123", 1)},
		{"anchor", strings.Replace(base, "description: hello", "description: &value hello", 1)},
		{"alias", strings.Replace(base, "description: hello", "description: *value", 1)},
		{"object-tag", strings.Replace(base, "description: hello", "description: !custom hello", 1)},
		{"sequence-type", strings.Replace(base, "description: hello", "description: hello\ntags: [12]", 1)},
		{"unsafe-id", strings.Replace(base, "id: m-example", "id: ../../escape", 1)},
		{"oversize", base + strings.Repeat("x", 100000)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := Parse([]byte(tc.document)); err == nil {
				t.Fatal("accepted invalid frontmatter")
			}
		})
	}
	if _, err := Parse([]byte(strings.ReplaceAll(base, "\n", "\r\n"))); err != nil {
		t.Fatalf("CRLF: %v", err)
	}
}

func TestInitProtectsOtherDirectories(t *testing.T) {
	d := t.TempDir()
	root := filepath.Join(d, "app")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	name := filepath.Join(root, "app.txt")
	if err := os.WriteFile(name, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	s := New(root, filepath.Join(d, "state"))
	if err := s.Init(context.Background()); err == nil {
		t.Fatal("initialized unrelated nonempty directory")
	}
	if b, _ := os.ReadFile(name); string(b) != "keep" {
		t.Fatal("existing file modified")
	}
	if err := New(root, filepath.Join(root, "state")).Init(context.Background()); err == nil {
		t.Fatal("accepted state inside store")
	}
	s = newStore(t)
	before := snapshot(t, s).Commit
	if err := s.Init(context.Background()); err != nil {
		t.Fatal(err)
	}
	if snapshot(t, s).Commit != before {
		t.Fatal("Init is not idempotent")
	}
	if got := gitTest(t, s, "remote"); got != "" {
		t.Fatalf("unexpected remote: %s", got)
	}
}

func TestSaveCASReadCommittedAndIdempotency(t *testing.T) {
	s := newStore(t)
	m := fixtureMemory("m-payment", "global")
	r := save(t, s, m, "new", "request-one")
	retry := save(t, s, m, "new", "request-one")
	if !reflect.DeepEqual(r, retry) {
		t.Fatal("idempotent result changed")
	}
	changed := m
	changed.Body = "a changed body"
	if _, err := s.Save(context.Background(), changed, "new", "request-one"); err == nil {
		t.Fatal("same request ID accepted different payload")
	}
	if _, err := s.Save(context.Background(), changed, "new", "request-two"); err == nil {
		t.Fatal("duplicate creation accepted")
	}
	if _, err := s.Save(context.Background(), changed, "wrong-revision", "request-two"); err == nil {
		t.Fatal("stale revision accepted")
	}
	before := snapshot(t, s)
	path := filepath.Join(s.root, "global", "m-payment.md")
	if err := os.WriteFile(path, []byte("uncommitted private changes"), 0600); err != nil {
		t.Fatal(err)
	}
	read := snapshot(t, s)
	if read.Commit != before.Commit || read.Memories[0].Body != m.Body {
		t.Fatal("reader exposed uncommitted changes")
	}
	if _, err := s.Save(context.Background(), changed, r.Revision, "request-two"); err == nil || !strings.Contains(err.Error(), "dirty") {
		t.Fatalf("dirty write: %v", err)
	}
	b, _ := Render(m)
	if err := os.WriteFile(path, b, 0600); err != nil {
		t.Fatal(err)
	}
	r2 := save(t, s, changed, r.Revision, "request-two")
	if r2.Revision == r.Revision {
		t.Fatal("changed body kept blob revision")
	}
	if got := gitTest(t, s, "status", "--porcelain"); got != "" {
		t.Fatalf("dirty after successful save: %s", got)
	}
	// If a completed journal is lost, immutable commit trailers still deduplicate.
	journalPath, err := s.journalPath("request-two")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(journalPath); err != nil {
		t.Fatal(err)
	}
	if replay := save(t, s, changed, r.Revision, "request-two"); !reflect.DeepEqual(replay, r2) {
		t.Fatal("commit trailer recovery failed")
	}
}

func TestConcurrentWritersAndRevisionConflict(t *testing.T) {
	s := newStore(t)
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for _, id := range []string{"m-first", "m-second"} {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			_, err := s.Save(context.Background(), fixtureMemory(id, "global"), "new", id)
			errs <- err
		}(id)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if len(snapshot(t, s).Memories) != 2 {
		t.Fatal("concurrent save lost a memory")
	}
	snap := snapshot(t, s)
	old := snap.Memories[0]
	errs = make(chan error, 2)
	for i, id := range []string{"update-one", "update-two"} {
		wg.Add(1)
		go func(i int, id string) {
			defer wg.Done()
			m := old
			m.Body = id
			_, err := s.Save(context.Background(), m, old.Revision, id)
			errs <- err
		}(i, id)
	}
	wg.Wait()
	close(errs)
	conflicts := 0
	for err := range errs {
		if err != nil {
			if !strings.Contains(err.Error(), "revision conflict") {
				t.Fatal(err)
			}
			conflicts++
		}
	}
	if conflicts != 1 {
		t.Fatalf("want exactly one CAS conflict; got %d", conflicts)
	}
}

func TestWholeAndPartialPromotion(t *testing.T) {
	s := newStore(t)
	addScope(t, s, "group:payments", "global")
	addScope(t, s, "project:alpha", "group:payments")
	addScope(t, s, "project:beta", "global")
	addScope(t, s, "project:gamma", "group:payments")
	m := fixtureMemory("m-retry", "project:alpha")
	r := save(t, s, m, "new", "save-retry")
	hash := snapshot(t, s).Memories[0].ContentHash
	if _, err := s.Promote(context.Background(), m.ID, "project:beta", r.Revision, "bad-promotion", nil, false); err == nil {
		t.Fatal("accepted sibling promotion")
	}
	preview, err := s.Promote(context.Background(), m.ID, "group:payments", r.Revision, "preview", nil, true)
	if err != nil {
		t.Fatal(err)
	}
	if !preview.Preview || snapshot(t, s).Commit != r.Commit {
		t.Fatal("preview mutated store")
	}
	if preview.TargetScope != "group:payments" || !reflect.DeepEqual(preview.NewlyVisibleProjects, []string{"project:gamma"}) {
		t.Fatalf("incorrect promotion visibility preview: %+v", preview)
	}
	result, err := s.Promote(context.Background(), m.ID, "group:payments", r.Revision, "promote-retry", nil, false)
	if err != nil {
		t.Fatal(err)
	}
	snap := snapshot(t, s)
	moved := snap.Memories[0]
	if moved.ID != m.ID || moved.ScopeID != "group:payments" || moved.ContentHash != hash || result.Revision == r.Revision {
		t.Fatalf("bad whole promotion: %+v", moved)
	}
	if _, err := os.Stat(filepath.Join(s.root, "projects", "alpha", "m-retry.md")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("whole promotion left old file")
	}
	m = fixtureMemory("m-local", "project:alpha")
	r = save(t, s, m, "new", "save-local")
	shared := fixtureMemory("m-shared", "group:payments")
	shared.Body = "같은 결제 요청은 같은 멱등 키로 재시도한다."
	p := &Partial{New: shared, RemainingBody: "로컬 지연은 150 ms다."}
	result, err = s.Promote(context.Background(), m.ID, "group:payments", r.Revision, "partial-local", p, false)
	if err != nil {
		t.Fatal(err)
	}
	snap = snapshot(t, s)
	original, _ := findMemory(snap, m.ID)
	promoted, _ := findMemory(snap, shared.ID)
	if promoted.DerivedFrom == nil || promoted.DerivedFrom.ID != m.ID || promoted.DerivedFrom.Revision != r.Revision {
		t.Fatal("lost provenance")
	}
	if strings.Contains(original.Body, "같은 결제 요청") || !strings.Contains(original.Body, "m-shared") || !strings.Contains(original.Body, "150 ms") {
		t.Fatalf("bad remaining body %q", original.Body)
	}
	if got := gitTest(t, s, "diff-tree", "--no-commit-id", "--name-only", "-r", result.Commit); len(strings.Split(got, "\n")) != 2 {
		t.Fatalf("partial promotion not one two-file commit: %s", got)
	}
}

func TestRecoveryAtCommitBoundaries(t *testing.T) {
	for _, point := range []string{"after-files", "before-ref", "after-ref", "after-index", "after-index-published"} {
		t.Run(point, func(t *testing.T) {
			s := newStore(t)
			before := snapshot(t, s).Commit
			m := fixtureMemory("m-recover", "global")
			s.fault = func(p string) error {
				if p == point {
					return errors.New("simulated interruption")
				}
				return nil
			}
			if _, err := s.Save(context.Background(), m, "new", "recover-me"); err == nil {
				t.Fatal("fault did not interrupt")
			}
			s.fault = nil
			snap := snapshot(t, s)
			if point != "after-ref" && point != "after-index" && point != "after-index-published" && (snap.Commit != before || len(snap.Memories) != 0) {
				t.Fatal("uncommitted partial content became visible")
			}
			if _, err := s.Recover(context.Background(), "recover-me"); err != nil {
				t.Fatal(err)
			}
			if status := gitTest(t, s, "status", "--porcelain"); status != "" {
				t.Fatalf("dirty after recovery: %s", status)
			}
			r := save(t, s, m, "new", "recover-me")
			if len(snapshot(t, s).Memories) != 1 {
				t.Fatal("recovered retry duplicated or lost memory")
			}
			if (point == "after-ref" || point == "after-index" || point == "after-index-published") && r.Commit != snap.Commit {
				t.Fatal("committed recovery created another commit")
			}
		})
	}
}

func TestRecoveryDoesNotOverwriteUnknownEdits(t *testing.T) {
	s := newStore(t)
	s.fault = func(p string) error {
		if p == "after-files" {
			return errors.New("interrupted")
		}
		return nil
	}
	if _, err := s.Save(context.Background(), fixtureMemory("m-test", "global"), "new", "pending"); err == nil {
		t.Fatal("fault missing")
	}
	s.fault = nil
	name := filepath.Join(s.root, "global", "m-test.md")
	if err := os.WriteFile(name, []byte("user edit after interruption"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Recover(context.Background(), "pending"); err == nil {
		t.Fatal("recovery accepted unknown edit")
	}
	if b, _ := os.ReadFile(name); string(b) != "user edit after interruption" {
		t.Fatal("recovery destroyed user edit")
	}
}

func TestRejectCommittedSymlinkAndPathMismatch(t *testing.T) {
	s := newStore(t)
	if err := os.Symlink("/tmp/unknown", filepath.Join(s.root, "evil")); err != nil {
		t.Fatal(err)
	}
	gitTest(t, s, "add", "--", "evil")
	gitTest(t, s, "commit", "-m", "external symlink")
	if _, err := s.Snapshot(context.Background()); err == nil {
		t.Fatal("snapshot accepted committed symlink")
	}
	s = newStore(t)
	m := fixtureMemory("m-id", "global")
	b, _ := Render(m)
	if err := os.MkdirAll(filepath.Join(s.root, "global"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.root, "global", "wrong-id.md"), b, 0600); err != nil {
		t.Fatal(err)
	}
	gitTest(t, s, "add", "--", "global/wrong-id.md")
	gitTest(t, s, "commit", "-m", "external mismatch")
	if _, err := s.Snapshot(context.Background()); err == nil {
		t.Fatal("snapshot accepted mismatched path")
	}
}

func TestWriterRefusesSymlinkParentAndForeignIndexLock(t *testing.T) {
	s := newStore(t)
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(s.root, "global")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Save(context.Background(), fixtureMemory("m-test", "global"), "new", "symlink-write"); err == nil {
		t.Fatal("writer followed symlink")
	}
	if entries, err := os.ReadDir(outside); err != nil || len(entries) != 0 {
		t.Fatal("writer touched symlink destination")
	}
	s = newStore(t)
	foreign := []byte("external Git lock")
	if err := os.WriteFile(s.indexLockPath(), foreign, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Save(context.Background(), fixtureMemory("m-test", "global"), "new", "locked"); err == nil {
		t.Fatal("writer ignored foreign lock")
	}
	if _, err := s.Recover(context.Background(), "locked"); err == nil {
		t.Fatal("recovery removed foreign lock")
	}
	if b, _ := os.ReadFile(s.indexLockPath()); !reflect.DeepEqual(b, foreign) {
		t.Fatal("foreign lock modified")
	}
}

func TestRetryFinalizesCommittedTransaction(t *testing.T) {
	s := newStore(t)
	m := fixtureMemory("m-retry-finalize", "global")
	s.fault = func(p string) error {
		if p == "after-ref" {
			return errors.New("response interrupted")
		}
		return nil
	}
	if _, err := s.Save(context.Background(), m, "new", "lost-response"); err == nil {
		t.Fatal("fault missing")
	}
	s.fault = nil
	committed := snapshot(t, s).Commit
	r := save(t, s, m, "new", "lost-response")
	if r.Commit != committed || gitTest(t, s, "status", "--porcelain") != "" {
		t.Fatal("retry did not finish committed transaction cleanly")
	}
}

func TestRecoveryRemovesOnlyRecordedMatchingTemporaryFiles(t *testing.T) {
	s := newStore(t)
	s.fault = func(p string) error {
		if p == "after-files" {
			return errors.New("interrupted")
		}
		return nil
	}
	if _, err := s.Save(context.Background(), fixtureMemory("m-temporary", "global"), "new", "temp-recovery"); err == nil {
		t.Fatal("fault missing")
	}
	s.fault = nil
	j, err := s.readJournal("temp-recovery")
	if err != nil {
		t.Fatal(err)
	}
	temp := filepath.Join(s.root, filepath.FromSlash(j.Changes[0].Temp))
	if err := os.WriteFile(temp, j.Changes[0].After, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Recover(context.Background(), "temp-recovery"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(temp); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("recorded temporary file was not removed")
	}
	if gitTest(t, s, "status", "--porcelain") != "" {
		t.Fatal("temporary file recovery left dirty store")
	}
}

func TestRejectStateInsideStoreThroughAlias(t *testing.T) {
	d := t.TempDir()
	root := filepath.Join(d, "store")
	if err := os.MkdirAll(filepath.Join(root, "container"), 0700); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(d, "alias")
	if err := os.Symlink(filepath.Join(root, "container"), alias); err != nil {
		t.Fatal(err)
	}
	s := New(root, filepath.Join(alias, "state"))
	if err := s.paths(); err == nil {
		t.Fatal("accepted state under store through symlink ancestor")
	}
}

func TestPackagedFictionalExamples(t *testing.T) {
	base := filepath.Join("..", "..", "examples")
	registryBytes, err := os.ReadFile(filepath.Join(base, "scopes.json"))
	if err != nil {
		t.Fatal(err)
	}
	var registry model.Registry
	if err := strictJSON(registryBytes, &registry); err != nil {
		t.Fatal(err)
	}
	if err := model.ValidateRegistry(registry); err != nil {
		t.Fatal(err)
	}
	count := 0
	err = filepath.WalkDir(filepath.Join(base, "memories"), func(name string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		b, err := os.ReadFile(name)
		if err != nil {
			return err
		}
		m, err := Parse(b)
		if err != nil {
			return err
		}
		if !strings.Contains(m.Body, "가상 데이터") && !strings.Contains(m.Body, "가상 데이터이며") {
			t.Errorf("sample %s lacks fictional label", m.ID)
		}
		rel, err := filepath.Rel(filepath.Join(base, "memories"), name)
		if err != nil {
			return err
		}
		expected, err := model.ScopePath(m.ScopeID, m.ID)
		if err != nil {
			return err
		}
		if filepath.ToSlash(rel) != expected {
			t.Errorf("example scope/path mismatch: %s", name)
		}
		if _, err := model.Ancestors(registry, m.ScopeID); err != nil {
			return err
		}
		count++
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if count != 6 {
		t.Fatalf("want six fictional samples, got %d", count)
	}
}

func TestProvenanceRequiresMatchingStoredBlob(t *testing.T) {
	s := newStore(t)
	original := fixtureMemory("m-original", "global")
	r := save(t, s, original, "new", "save-original")
	derived := fixtureMemory("m-derived", "global")
	derived.DerivedFrom = &model.Provenance{ID: "m-original", Revision: strings.Repeat("a", 40)}
	if _, err := s.Save(context.Background(), derived, "new", "invalid-provenance"); err == nil {
		t.Fatal("accepted nonexistent provenance blob")
	}
	derived.DerivedFrom.Revision = r.Revision
	save(t, s, derived, "new", "valid-provenance")
	if len(snapshot(t, s).Memories) != 2 {
		t.Fatal("valid historical provenance rejected")
	}
}

func TestLostCompletionReceiptAfterLaterCommit(t *testing.T) {
	s := newStore(t)
	m := fixtureMemory("m-lost-receipt", "global")
	s.fault = func(p string) error {
		if p == "after-index-published" {
			return errors.New("completion receipt interrupted")
		}
		return nil
	}
	if _, err := s.Save(context.Background(), m, "new", "lost-receipt"); err == nil {
		t.Fatal("fault missing")
	}
	s.fault = nil
	firstCommit := snapshot(t, s).Commit
	save(t, s, fixtureMemory("m-later", "global"), "new", "later-write")
	laterCommit := snapshot(t, s).Commit
	r := save(t, s, m, "new", "lost-receipt")
	if r.Commit != firstCommit || snapshot(t, s).Commit != laterCommit {
		t.Fatal("retry did not preserve immutable prior result")
	}
	if len(snapshot(t, s).Memories) != 2 {
		t.Fatal("receipt recovery changed committed memories")
	}
}
