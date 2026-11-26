package ledger

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"ein.local/sniffer/internal/model"
)

func sampleSession() Session {
	return Session{Host: "codex", ConversationID: "conversation-fixture", ProjectID: "folder-1", Epoch: 0}
}
func sampleMemory() model.Memory {
	return model.Memory{SchemaVersion: 1, ID: "m-sample", ScopeID: "project:folder-1", Description: "가상의 재시도 규칙", Key: "payments.retry", Body: "Fictional body: keep the same idempotency key.", Path: "projects/folder-1/m-sample.md", Revision: "blob-before", UpdatedAt: "2026-11-25T00:00:00Z"}
}
func privateDir(t *testing.T) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "ledger")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	return dir
}
func mustClaim(t *testing.T, l *Ledger, s Session, owner, event string, memories []model.Memory, force bool) Delivery {
	t.Helper()
	d, err := l.Claim(s, owner, event, memories, force)
	if err != nil {
		t.Fatal(err)
	}
	return d
}
func mustState(t *testing.T, l *Ledger, s Session) state {
	t.Helper()
	key, err := baseKey(s)
	if err != nil {
		t.Fatal(err)
	}
	st, err := l.read(key)
	if err != nil {
		t.Fatal(err)
	}
	return st
}

func TestReadOnlyOperationsDoNotCreateOrChangeState(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "ledger")
	l := New(dir)
	s := sampleSession()
	m := sampleMemory()
	if epoch, err := l.Epoch(s); err != nil || epoch != 0 {
		t.Fatalf("initial epoch %v, %v", epoch, err)
	}
	if got, err := l.FilterUnseen(s, []model.Memory{m}); err != nil || len(got) != 1 {
		t.Fatalf("fresh filter %v, %v", got, err)
	}
	if _, err := os.Stat(dir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("read-only call created state: %v", err)
	}
	d := mustClaim(t, l, s, "run-one", "event-1", []model.Memory{m}, false)
	if err := l.Emitted(s, d.ID, "run-one"); err != nil {
		t.Fatal(err)
	}
	key, _ := baseKey(s)
	statePath := filepath.Join(dir, key+".json")
	before, err := os.ReadFile(statePath)
	if err != nil {
		t.Fatal(err)
	}
	beforeInfo, err := os.Stat(statePath)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5; i++ {
		if got, err := l.FilterUnseen(s, []model.Memory{m}); err != nil || len(got) != 0 {
			t.Fatalf("seen filter = %v, %v", got, err)
		}
		if _, err := l.Epoch(s); err != nil {
			t.Fatal(err)
		}
	}
	after, _ := os.ReadFile(statePath)
	afterInfo, _ := os.Stat(statePath)
	if string(before) != string(after) || !beforeInfo.ModTime().Equal(afterInfo.ModTime()) {
		t.Fatal("read-only filter changed delivery state")
	}
}

func TestClaimsRemainSuppressedAcrossRestartsAndCommitChanges(t *testing.T) {
	dir := privateDir(t)
	s := sampleSession()
	m := sampleMemory()
	l := New(dir)
	d := mustClaim(t, l, s, "run-a", "event-a", []model.Memory{m}, false)
	if len(d.Memories) != 1 || d.State != "claimed" || d.ID == "" {
		t.Fatalf("bad first claim %+v", d)
	}
	if err := l.Emitted(s, d.ID, "run-a"); err != nil {
		t.Fatal(err)
	}
	l = New(dir)
	for _, tc := range []struct {
		name   string
		change func(*model.Memory)
	}{
		{"unchanged", func(m *model.Memory) {}},
		{"unrelated-commit", func(m *model.Memory) { m.Revision = "blob-same-or-refreshed" }},
		{"whole-promotion", func(m *model.Memory) { m.ScopeID = "global"; m.Path = "global/m-sample.md" }},
		{"timestamp-only", func(m *model.Memory) { m.UpdatedAt = "2027-01-01T00:00:00Z" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			changed := m
			tc.change(&changed)
			got := mustClaim(t, l, s, "run-b", "event-"+tc.name, []model.Memory{changed}, false)
			if len(got.Memories) != 0 {
				t.Fatalf("metadata change redelivered %+v", got)
			}
			if unseen, err := l.FilterUnseen(s, []model.Memory{changed}); err != nil || len(unseen) != 0 {
				t.Fatalf("metadata caused model candidates: %+v, %v", unseen, err)
			}
		})
	}
	changed := m
	changed.Body = "Changed fictional rule: allocate a new key only for a distinct payment."
	changed.ContentHash = m.ContentHash // A stale input hint must not conceal a new body.
	if got := mustClaim(t, l, s, "run-b", "event-changed", []model.Memory{changed}, false); len(got.Memories) != 1 {
		t.Fatalf("changed body was suppressed %+v", got)
	}
	changed = m
	changed.Description = "Changed description"
	if got := mustClaim(t, l, s, "run-b", "event-description", []model.Memory{changed}, false); len(got.Memories) != 1 {
		t.Fatal("changed description was suppressed")
	}
	changed = m
	changed.Key = "payments.retry.new-topic"
	if got := mustClaim(t, l, s, "run-b", "event-key", []model.Memory{changed}, false); len(got.Memories) != 1 {
		t.Fatal("changed semantic key was suppressed")
	}
}

func TestEventIdempotenceAndExplicitForce(t *testing.T) {
	l := New(privateDir(t))
	s := sampleSession()
	m := sampleMemory()
	first := mustClaim(t, l, s, "owner-a", "same-event", []model.Memory{m, m}, false)
	if len(first.Memories) != 1 {
		t.Fatal("input duplicates were not collapsed")
	}
	for _, force := range []bool{false, true} {
		retry := mustClaim(t, l, s, "owner-b", "same-event", []model.Memory{m}, force)
		if len(retry.Memories) != 0 || retry.ID != first.ID {
			t.Fatalf("event retry produced payload: %+v", retry)
		}
	}
	forced := mustClaim(t, l, s, "owner-b", "explicit-recall", []model.Memory{m}, true)
	if len(forced.Memories) != 1 || forced.ID == first.ID {
		t.Fatalf("explicit force did not create new delivery: %+v", forced)
	}
	if retry := mustClaim(t, l, s, "owner-b", "explicit-recall", []model.Memory{m}, true); len(retry.Memories) != 0 {
		t.Fatal("forced event retry redelivered")
	}
	if got := mustClaim(t, l, s, "owner-b", "normal-after-force", []model.Memory{m}, false); len(got.Memories) != 0 {
		t.Fatal("normal event bypassed forced claim")
	}
	// Even an event which initially selected nothing cannot later produce a
	// different payload when retried after memory changes.
	m.Body = "Another version"
	if got := mustClaim(t, l, s, "owner-b", "normal-after-force", []model.Memory{m}, false); len(got.Memories) != 0 {
		t.Fatal("empty event was not idempotent")
	}
}

func TestOwnerFailureIsUncertainAndNeverAutomaticallyRetried(t *testing.T) {
	dir := privateDir(t)
	l := New(dir)
	s := sampleSession()
	m := sampleMemory()
	pending := mustClaim(t, l, s, "crashed-owner", "pending", []model.Memory{m}, false)
	other := m
	other.ID = "m-other"
	otherDelivery := mustClaim(t, l, s, "other-owner", "other-event", []model.Memory{other}, false)
	if err := l.Emitted(s, pending.ID, "other-owner"); err == nil {
		t.Fatal("wrong owner acknowledged a delivery")
	}
	if err := New(dir).RecoverOwner("crashed-owner"); err != nil {
		t.Fatal(err)
	}
	st := mustState(t, l, s)
	if st.Deliveries[pending.ID].State != "uncertain" || st.Deliveries[otherDelivery.ID].State != "claimed" {
		t.Fatalf("recovery affected wrong claims: %+v", st.Deliveries)
	}
	if unseen, err := l.FilterUnseen(s, []model.Memory{m, other}); err != nil || len(unseen) != 0 {
		t.Fatalf("uncertain/claimed not suppressed: %+v, %v", unseen, err)
	}
	if got := mustClaim(t, l, s, "new-owner", "next-event", []model.Memory{m}, false); len(got.Memories) != 0 {
		t.Fatal("recovery automatically replayed uncertain delivery")
	}
	if err := l.Emitted(s, pending.ID, "crashed-owner"); err != nil {
		t.Fatal("late owner acknowledgement should be accepted:", err)
	}
	if err := l.Uncertain(s, pending.ID, "crashed-owner"); err != nil {
		t.Fatal(err)
	}
	if got := mustState(t, l, s).Deliveries[pending.ID].State; got != "emitted" {
		t.Fatalf("known emitted state regressed: %s", got)
	}
	if got := mustClaim(t, l, s, "new-owner", "manual-recall", []model.Memory{m}, true); len(got.Memories) != 1 {
		t.Fatal("explicit recovery was blocked")
	}
}

func TestContextEpochAndSessionBoundaries(t *testing.T) {
	l := New(privateDir(t))
	s := sampleSession()
	m := sampleMemory()
	d := mustClaim(t, l, s, "owner", "event", []model.Memory{m}, false)
	for _, tc := range []struct {
		name   string
		change func(*Session)
	}{
		{"new-conversation", func(s *Session) { s.ConversationID = "conversation-new" }},
		{"other-product", func(s *Session) { s.Host = "claude" }},
		{"another-project", func(s *Session) { s.ProjectID = "folder-2" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			changed := s
			tc.change(&changed)
			if got := mustClaim(t, l, changed, "owner", "event", []model.Memory{m}, false); len(got.Memories) != 1 {
				t.Fatalf("different session was suppressed: %+v", got)
			}
		})
	}
	alias := s
	alias.ProjectID = "project:folder-1"
	if got := mustClaim(t, l, alias, "owner", "alias-event", []model.Memory{m}, false); len(got.Memories) != 0 {
		t.Fatal("project prefix created a separate delivery scope")
	}
	if epoch, err := l.AdvanceEpoch(s, "compact-event"); err != nil || epoch != 1 {
		t.Fatalf("advance %d, %v", epoch, err)
	}
	if epoch, err := l.AdvanceEpoch(s, "compact-event"); err != nil || epoch != 1 {
		t.Fatalf("duplicate compaction %d, %v", epoch, err)
	}
	if _, err := l.FilterUnseen(s, []model.Memory{m}); !errors.Is(err, ErrStaleEpoch) {
		t.Fatalf("stale filter error = %v", err)
	}
	if _, err := l.Claim(s, "owner", "stale-event", []model.Memory{m}, false); !errors.Is(err, ErrStaleEpoch) {
		t.Fatalf("stale claim error = %v", err)
	}
	if err := l.Emitted(s, d.ID, "owner"); err != nil {
		t.Fatal("old-epoch ACK should remain valid:", err)
	}
	s.Epoch = 1
	if got := mustClaim(t, l, s, "owner", "event", []model.Memory{m}, false); len(got.Memories) != 1 {
		t.Fatal("new context epoch did not restore memory eligibility")
	}
	if epoch, err := l.AdvanceEpoch(s, "clear-event"); err != nil || epoch != 2 {
		t.Fatalf("second advance %d, %v", epoch, err)
	}
	if epoch, err := l.AdvanceEpoch(s, "compact-event"); err != nil || epoch != 2 {
		t.Fatalf("old compact retry changed active epoch %d, %v", epoch, err)
	}
}

func TestConcurrentClaimsHaveSinglePayloadWinner(t *testing.T) {
	l := New(privateDir(t))
	s := sampleSession()
	m := sampleMemory()
	const count = 32
	var wg sync.WaitGroup
	results := make(chan Delivery, count)
	errorsCh := make(chan error, count)
	for i := 0; i < count; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			d, err := l.Claim(s, fmt.Sprintf("owner-%d", i), fmt.Sprintf("event-%d", i), []model.Memory{m}, false)
			results <- d
			errorsCh <- err
		}(i)
	}
	wg.Wait()
	close(results)
	close(errorsCh)
	for err := range errorsCh {
		if err != nil {
			t.Fatal(err)
		}
	}
	winners := 0
	for d := range results {
		if len(d.Memories) > 0 {
			winners++
		}
	}
	if winners != 1 {
		t.Fatalf("concurrent payload winners = %d", winners)
	}
}

// The subprocess mode exercises flock across independent processes, rather than
// only relying on goroutine scheduling or an in-memory mutex.
func TestClaimAcrossProcesses(t *testing.T) {
	if dir := os.Getenv("EIN_SNIFFER_LEDGER_TEST_DIR"); dir != "" {
		id := os.Getenv("EIN_SNIFFER_LEDGER_TEST_ID")
		d, err := New(dir).Claim(sampleSession(), "process-"+id, "event-"+id, []model.Memory{sampleMemory()}, false)
		if err != nil {
			t.Fatal(err)
		}
		if len(d.Memories) > 0 {
			fmt.Println("DELIVERY_WINNER")
		}
		return
	}
	dir := privateDir(t)
	const count = 8
	commands := make([]*exec.Cmd, count)
	for i := range commands {
		cmd := exec.Command(os.Args[0], "-test.run=^TestClaimAcrossProcesses$")
		cmd.Env = append(os.Environ(), "EIN_SNIFFER_LEDGER_TEST_DIR="+dir, fmt.Sprintf("EIN_SNIFFER_LEDGER_TEST_ID=%d", i))
		commands[i] = cmd
	}
	var wg sync.WaitGroup
	out := make(chan string, count)
	errs := make(chan error, count)
	for _, cmd := range commands {
		wg.Add(1)
		go func(cmd *exec.Cmd) { defer wg.Done(); b, err := cmd.CombinedOutput(); out <- string(b); errs <- err }(cmd)
	}
	wg.Wait()
	close(out)
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("claim helper failed: %v", err)
		}
	}
	winners := 0
	for s := range out {
		if strings.Contains(s, "DELIVERY_WINNER") {
			winners++
		}
	}
	if winners != 1 {
		t.Fatalf("cross-process winners = %d", winners)
	}
}

func TestPrivateReceiptsAndCorruptionFailClosed(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "ledger")
	l := New(dir)
	s := sampleSession()
	m := sampleMemory()
	m.Body = "PRIVATE_MEMORY_BODY_SENTINEL"
	m.Description = "PRIVATE_DESCRIPTION_SENTINEL"
	_ = mustClaim(t, l, s, "owner", "event", []model.Memory{m}, false)
	key, _ := baseKey(s)
	path := filepath.Join(dir, key+".json")
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{m.Body, m.Description, m.Path, s.ConversationID} {
		if strings.Contains(string(b), secret) {
			t.Fatalf("ledger leaked %q", secret)
		}
	}
	for _, p := range []string{path, filepath.Join(dir, key+".lock")} {
		info, err := os.Stat(p)
		if err != nil || info.Mode().Perm() != 0600 {
			t.Fatalf("file permission %s: %v, %v", p, info, err)
		}
	}
	if info, err := os.Stat(dir); err != nil || info.Mode().Perm() != 0700 {
		t.Fatalf("dir permission: %v %v", info, err)
	}
	for _, bad := range []string{`{"schema_version":1`, `{}`, string(b) + ` {}`, strings.Replace(string(b), `"claimed"`, `"unknown-state"`, 1)} {
		if err = os.WriteFile(path, []byte(bad), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err = l.FilterUnseen(s, []model.Memory{m}); !errors.Is(err, ErrCorrupt) {
			t.Fatalf("corrupt filter did not fail closed: %v", err)
		}
		if _, err = l.Claim(s, "owner", "new-event", []model.Memory{m}, false); !errors.Is(err, ErrCorrupt) {
			t.Fatalf("corrupt claim did not fail closed: %v", err)
		}
		after, _ := os.ReadFile(path)
		if string(after) != bad {
			t.Fatal("corruption was silently overwritten")
		}
	}
}

func TestSymlinkAndSharedPermissionRejection(t *testing.T) {
	s := sampleSession()
	m := sampleMemory()
	key, _ := baseKey(s)
	t.Run("state symlink", func(t *testing.T) {
		dir := privateDir(t)
		target := filepath.Join(t.TempDir(), "external.json")
		if err := os.WriteFile(target, []byte("external sentinel"), 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(target, filepath.Join(dir, key+".json")); err != nil {
			t.Fatal(err)
		}
		if _, err := New(dir).Claim(s, "owner", "event", []model.Memory{m}, false); err == nil {
			t.Fatal("followed state symlink")
		}
		b, _ := os.ReadFile(target)
		if string(b) != "external sentinel" {
			t.Fatal("external target changed")
		}
	})
	t.Run("lock symlink", func(t *testing.T) {
		dir := privateDir(t)
		target := filepath.Join(t.TempDir(), "external.lock")
		if err := os.WriteFile(target, nil, 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(target, filepath.Join(dir, key+".lock")); err != nil {
			t.Fatal(err)
		}
		if _, err := New(dir).Claim(s, "owner", "event", []model.Memory{m}, false); err == nil {
			t.Fatal("followed lock symlink")
		}
	})
	t.Run("directory symlink", func(t *testing.T) {
		link := filepath.Join(t.TempDir(), "ledger")
		if err := os.Symlink(t.TempDir(), link); err != nil {
			t.Fatal(err)
		}
		if _, err := New(link).Claim(s, "owner", "event", []model.Memory{m}, false); err == nil {
			t.Fatal("followed ledger directory symlink")
		}
	})
	t.Run("shared directory", func(t *testing.T) {
		dir := t.TempDir()
		if err := os.Chmod(dir, 0755); err != nil {
			t.Fatal(err)
		}
		if _, err := New(dir).Claim(s, "owner", "event", []model.Memory{m}, false); err == nil {
			t.Fatal("used nonprivate directory")
		}
	})
}

func TestBadInputsDoNotAllocateLedger(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "ledger")
	l := New(dir)
	s := sampleSession()
	m := sampleMemory()
	if _, err := l.Claim(Session{}, "owner", "event", []model.Memory{m}, false); err == nil {
		t.Fatal("empty session accepted")
	}
	if _, err := l.Claim(s, "", "event", []model.Memory{m}, false); err == nil {
		t.Fatal("empty owner accepted")
	}
	if _, err := l.Claim(s, "owner", "", []model.Memory{m}, false); err == nil {
		t.Fatal("empty event accepted")
	}
	changed := m
	changed.Body = "conflicting version"
	if _, err := l.Claim(s, "owner", "event", []model.Memory{m, changed}, false); err == nil {
		t.Fatal("two memory versions accepted")
	}
	if _, err := os.Stat(dir); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("invalid input allocated state")
	}
}

func TestSemanticCorruptionFailsClosed(t *testing.T) {
	l := New(privateDir(t))
	s := sampleSession()
	d := mustClaim(t, l, s, "owner", "event", []model.Memory{sampleMemory()}, false)
	st := mustState(t, l, s)
	r := st.Deliveries[d.ID]
	r.Memories[0].Hash = "not-a-content-hash"
	st.Deliveries[d.ID] = r
	b, _ := json.Marshal(st)
	key, _ := baseKey(s)
	if err := os.WriteFile(filepath.Join(l.dir, key+".json"), b, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := l.Epoch(s); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("invalid receipt accepted: %v", err)
	}
}
