package recall

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"

	"ein.local/sniffer/internal/config"
	"ein.local/sniffer/internal/model"
	"ein.local/sniffer/internal/native"
	"ein.local/sniffer/internal/store"
)

// All observations and memories in this file are fictional. No product CLI,
// model, network service, or real user's memory directory is involved.
type recallSnapshot struct {
	mu sync.Mutex
	s  model.Snapshot
}

func cloneRecallSnapshot(s model.Snapshot) model.Snapshot {
	b, _ := json.Marshal(s)
	var out model.Snapshot
	_ = json.Unmarshal(b, &out)
	return out
}

func (b *recallSnapshot) read(ctx context.Context) (model.Snapshot, error) {
	if err := ctx.Err(); err != nil {
		return model.Snapshot{}, err
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	return cloneRecallSnapshot(b.s), nil
}

func (b *recallSnapshot) change(fn func(*model.Snapshot)) {
	b.mu.Lock()
	defer b.mu.Unlock()
	s := cloneRecallSnapshot(b.s)
	fn(&s)
	b.s = s
}

type recallFixture struct {
	s       *Service
	box     *recallSnapshot
	binding Binding
}

func recallMemory(id, scope, body string, n int) model.Memory {
	return model.Memory{SchemaVersion: 1, ID: id, ScopeID: scope,
		Description: "Fictional compatibility-marker retry guidance", Body: body,
		Revision: fmt.Sprintf("%040x", n)}
}

func newRecallFixture(t *testing.T) *recallFixture {
	t.Helper()
	root := t.TempDir()
	cwd := filepath.Join(root, "alpha")
	if err := os.Mkdir(cwd, 0700); err != nil {
		t.Fatal(err)
	}
	cwd, err := config.CanonicalDir(cwd)
	if err != nil {
		t.Fatal(err)
	}
	p, err := config.Locate(filepath.Join(root, "ein"))
	if err != nil {
		t.Fatal(err)
	}
	c := config.Defaults()
	c.Projects = []config.Project{{ID: "alpha", Roots: []string{cwd}}}
	if err := config.Update(p, func(dst *config.Config) error { *dst = c; return nil }); err != nil {
		t.Fatal(err)
	}
	box := &recallSnapshot{s: model.Snapshot{
		Commit: fmt.Sprintf("%040x", 100),
		Registry: model.Registry{SchemaVersion: 1, Scopes: []model.Scope{
			{ID: "global", Kind: "global"},
			{ID: "group:team", Kind: "group", Parent: "global"},
			{ID: "project:alpha", Kind: "project", Parent: "group:team"},
			{ID: "project:beta", Kind: "project", Parent: "global"},
		}},
		Glossary: [][]string{{"retry", "재시도"}},
		Memories: []model.Memory{
			recallMemory("m-local", "project:alpha", "Fictional local retry rule.", 1),
			recallMemory("m-team", "group:team", "Fictional team retry rule.", 2),
			recallMemory("m-global", "global", "Fictional global retry rule.", 3),
			recallMemory("m-private", "project:beta", "PRIVATE_SIBLING_SENTINEL", 4),
		},
	}}
	return &recallFixture{s: New(p, c, box.read), box: box,
		binding: Binding{Host: "claude", ConversationID: "fictional-main", Cwd: cwd}}
}

func beginRecall(t *testing.T, f *recallFixture, event string) (Binding, Response) {
	t.Helper()
	b := f.binding
	b.TurnID, b.EventID = "turn-"+event, event
	r, err := f.s.Begin(context.Background(), BeginInput{Binding: b,
		Query: "Plan the fictional onboarding", Context: "Observed a retry failure."})
	if err != nil {
		t.Fatal(err)
	}
	b.RequestID = r.RequestID
	return b, r
}

func callRecallTool(t *testing.T, s *Service, b Binding, name, args string) any {
	t.Helper()
	v, err := s.Tool(context.Background(), b, name, json.RawMessage(args))
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	return v
}

func chooseRecall(ms ...model.Memory) native.Decision {
	d := native.Decision{Decision: "inject", References: []native.Reference{}, Reason: "Fictional relevance decision"}
	for _, m := range ms {
		d.References = append(d.References, native.Reference{ID: m.ID, Revision: m.Revision})
	}
	return d
}

func completeRecall(t *testing.T, s *Service, b Binding, d native.Decision, want string) Response {
	t.Helper()
	r, err := s.Complete(context.Background(), b, d)
	if err != nil {
		t.Fatal(err)
	}
	if r.Status != want {
		t.Fatalf("completion status = %q, want %q (%+v)", r.Status, want, r)
	}
	if want != "claimed" && (r.Context != "" || r.DeliveryID != "") {
		t.Fatalf("failed completion leaked a delivery: %+v", r)
	}
	return r
}

func TestRecallIndependentSearchPagingAndGitReadOnly(t *testing.T) {
	f := newRecallFixture(t)
	st := store.New(f.s.Paths.Store, f.s.Paths.State)
	ctx := context.Background()
	if err := st.Init(ctx); err != nil {
		t.Fatal(err)
	}
	for _, scope := range []model.Scope{{ID: "project:alpha", Kind: "project", Parent: "global"}, {ID: "project:beta", Kind: "project", Parent: "global"}} {
		if _, err := st.AddScope(ctx, scope, ID()); err != nil {
			t.Fatal(err)
		}
	}
	body := strings.Repeat("가", 1100) + "PAGED_SENTINEL: retry safely."
	m := recallMemory("m-long", "project:alpha", body, 1)
	for _, v := range []model.Memory{m, recallMemory("m-private", "project:beta", "PRIVATE_SIBLING_SENTINEL", 2)} {
		if _, err := st.Save(ctx, v, "new", ID()); err != nil {
			t.Fatal(err)
		}
	}
	f.s.Snapshot = st.Snapshot
	git := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", f.s.Paths.Store}, args...)...)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
		return string(out)
	}
	before := []string{git("rev-parse", "HEAD"), git("status", "--porcelain"), git("ls-files", "--stage")}
	b, started := beginRecall(t, f, "discover")
	if strings.Contains(started.Prompt, "m-long") {
		t.Fatal("Begin supplied a preselected candidate list")
	}
	result := callRecallTool(t, f.s, b, "memory_search", `{"query":"compatibility-marker"}`).(map[string]any)
	items := result["memories"].([]map[string]any)
	if len(items) != 1 || items[0]["id"] != "m-long" || items[0]["truncated"] != true {
		t.Fatalf("independent search: %#v", result)
	}
	if strings.Contains(items[0]["body_excerpt"].(string), "PAGED_SENTINEL") {
		t.Fatal("test target should lie beyond search excerpt")
	}
	page1 := callRecallTool(t, f.s, b, "memory_read", `{"id":"m-long","offset":1000,"limit":100}`).(map[string]any)
	page2 := callRecallTool(t, f.s, b, "memory_read", `{"id":"m-long","offset":1100,"limit":100}`).(map[string]any)
	if page1["body"] != strings.Repeat("가", 100) || page1["next_offset"] != 1100 || page1["has_more"] != true {
		t.Fatalf("first rune page: %#v", page1)
	}
	if page2["body"] != "PAGED_SENTINEL: retry safely." || page2["has_more"] != false {
		t.Fatalf("page beyond excerpt: %#v", page2)
	}
	gotContext := callRecallTool(t, f.s, b, "memory_context", `{}`).(native.Request)
	if gotContext.Query != "Plan the fictional onboarding" || gotContext.Context != "Observed a retry failure." || gotContext.RequestID != b.RequestID {
		t.Fatalf("observation: %+v", gotContext)
	}
	for _, name := range []string{"memory_save", "memory_promote", "shell"} {
		if _, err := f.s.Tool(ctx, b, name, json.RawMessage(`{}`)); err == nil {
			t.Fatalf("writer tool %s was allowed", name)
		}
	}
	if _, err := f.s.Tool(ctx, b, "memory_read", json.RawMessage(`{"id":"m-private"}`)); err == nil {
		t.Fatal("sibling memory was readable")
	}
	after := []string{git("rev-parse", "HEAD"), git("status", "--porcelain"), git("ls-files", "--stage")}
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("read-only attempts changed Git: before=%q after=%q", before, after)
	}
	if entries, err := os.ReadDir(filepath.Join(f.s.Paths.State, "deliveries")); !os.IsNotExist(err) && (err != nil || len(entries) != 0) {
		t.Fatalf("reads allocated delivery claims: %v %v", entries, err)
	}
	current, err := st.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var selected model.Memory
	for _, v := range current.Memories {
		if v.ID == "m-long" {
			selected = v
		}
	}
	completeRecall(t, f.s, b, chooseRecall(selected), "claimed")
}

func TestRecallCompletionRevalidatesCurrentSnapshot(t *testing.T) {
	cases := []struct {
		name, want string
		mutate     func(*model.Snapshot)
	}{
		{"exact_revision", "stale_memory", func(s *model.Snapshot) { s.Memories[0].Revision = fmt.Sprintf("%040x", 11) }},
		{"removed", "stale_memory", func(s *model.Snapshot) { s.Memories = s.Memories[1:] }},
		{"moved_to_sibling", "stale_memory", func(s *model.Snapshot) { s.Memories[0].ScopeID = "project:beta" }},
		{"ancestry_changed", "stale_scope", func(s *model.Snapshot) { s.Registry.Scopes[2].Parent = "global" }},
		{"new_specific_key_override", "stale_memory", func(s *model.Snapshot) {
			s.Memories[1].Key = "retry-policy"
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newRecallFixture(t)
			selected := f.box.s.Memories[0]
			if tc.name == "new_specific_key_override" {
				f.box.change(func(s *model.Snapshot) { s.Memories[2].Key = "retry-policy" })
				selected = f.box.s.Memories[2]
			}
			b, _ := beginRecall(t, f, tc.name)
			callRecallTool(t, f.s, b, "memory_read", fmt.Sprintf(`{"id":%q}`, selected.ID))
			f.box.change(tc.mutate)
			completeRecall(t, f.s, b, chooseRecall(selected), tc.want)
		})
	}
	t.Run("sibling_reference_never_visible", func(t *testing.T) {
		f := newRecallFixture(t)
		b, _ := beginRecall(t, f, "private")
		completeRecall(t, f.s, b, chooseRecall(f.box.s.Memories[3]), "stale_memory")
	})
}

func TestRecallBilingualSearchAndNoSelection(t *testing.T) {
	f := newRecallFixture(t)
	b, _ := beginRecall(t, f, "bilingual")
	for _, query := range []string{"retry", "재시도"} {
		v := callRecallTool(t, f.s, b, "memory_search", fmt.Sprintf(`{"query":%q}`, query)).(map[string]any)
		items := v["memories"].([]map[string]any)
		if len(items) != 3 {
			t.Fatalf("query %q did not find all visible scopes: %#v", query, v)
		}
		for _, item := range items {
			if item["id"] == "m-private" {
				t.Fatalf("query %q disclosed a sibling memory", query)
			}
		}
	}
	completeRecall(t, f.s, b, native.Decision{Decision: "none", References: []native.Reference{}, Reason: "No memory improves this answer."}, "none_selected")
	if _, err := f.s.Tool(context.Background(), b, "memory_context", json.RawMessage(`{}`)); err == nil {
		t.Fatal("completed request retained tool access")
	}
	completeRecall(t, f.s, b, chooseRecall(f.box.s.Memories[0]), "stale")
}

func TestRecallClaimsSuppressDuplicatesAndEpochAllowsRedelivery(t *testing.T) {
	f := newRecallFixture(t)
	m := f.box.s.Memories[0]
	b, _ := beginRecall(t, f, "one")
	d := completeRecall(t, f.s, b, chooseRecall(m), "claimed")
	if d.DeliveryID == "" || !strings.Contains(d.Context, m.Body) {
		t.Fatalf("missing claimed payload: %+v", d)
	}
	b2, _ := beginRecall(t, f, "two")
	completeRecall(t, f.s, b2, chooseRecall(m), "duplicate") // Claim alone suppresses replay even before ACK.
	if err := f.s.Ack(b, d.DeliveryID, d.Epoch, "emitted"); err != nil {
		t.Fatal(err)
	}
	b3, _ := beginRecall(t, f, "three")
	completeRecall(t, f.s, b3, chooseRecall(m), "duplicate")
	reset, err := f.s.Cancel(Binding{Host: b3.Host, Cwd: b3.Cwd, ConversationID: b3.ConversationID, EventID: "compaction-1"}, true)
	if err != nil || reset.Epoch != d.Epoch+1 {
		t.Fatalf("reset: %+v %v", reset, err)
	}
	b4, _ := beginRecall(t, f, "four")
	completeRecall(t, f.s, b4, chooseRecall(m), "claimed")
	f.binding.ConversationID = "other-fictional-session"
	b5, _ := beginRecall(t, f, "five")
	completeRecall(t, f.s, b5, chooseRecall(m), "claimed")
}

func TestRecallToolBudgetsCountFailuresAndBoundBytes(t *testing.T) {
	for _, failed := range []int{0, 5, 12} {
		t.Run(fmt.Sprintf("%d_failed_calls", failed), func(t *testing.T) {
			f := newRecallFixture(t)
			b, _ := beginRecall(t, f, "budget")
			for i := 0; i < 12; i++ {
				name, args := "memory_context", `{}`
				if i < failed {
					name = "memory_save"
					if i%2 == 0 {
						name = "memory_search"
						args = `{"query":"x","unknown":true}`
					}
				}
				_, err := f.s.Tool(context.Background(), b, name, json.RawMessage(args))
				if (err != nil) != (i < failed) {
					t.Fatalf("call %d: unexpected error %v", i+1, err)
				}
			}
			if _, err := f.s.Tool(context.Background(), b, "memory_context", json.RawMessage(`{}`)); err == nil || !strings.Contains(err.Error(), "budget") {
				t.Fatalf("thirteenth call: %v", err)
			}
			fresh, _ := beginRecall(t, f, "new-budget")
			callRecallTool(t, f.s, fresh, "memory_context", `{}`)
		})
	}
	t.Run("utf8_response_byte_budget", func(t *testing.T) {
		f := newRecallFixture(t)
		f.box.change(func(s *model.Snapshot) { s.Memories[0].Body = strings.Repeat("가", 16000) })
		b, _ := beginRecall(t, f, "bytes")
		for i := 0; i < 4; i++ {
			callRecallTool(t, f.s, b, "memory_read", `{"id":"m-local","limit":16000}`)
		}
		if _, err := f.s.Tool(context.Background(), b, "memory_read", json.RawMessage(`{"id":"m-local","limit":16000}`)); err == nil || !strings.Contains(err.Error(), "byte budget") {
			t.Fatalf("expected byte exhaustion before 12 calls: %v", err)
		}
		if _, err := f.s.Tool(context.Background(), b, "memory_context", json.RawMessage(`{}`)); err == nil {
			t.Fatal("byte-exhausted request regained access")
		}
	})
}

func TestRecallDeliveryBudgetsAndDecisionValidation(t *testing.T) {
	t.Run("oversized_only", func(t *testing.T) {
		f := newRecallFixture(t)
		f.box.change(func(s *model.Snapshot) { s.Memories[0].Body = strings.Repeat("x", 20000) })
		b, _ := beginRecall(t, f, "oversize")
		completeRecall(t, f.s, b, chooseRecall(f.box.s.Memories[0]), "output_budget")
	})
	t.Run("skip_oversized_but_deliver_small", func(t *testing.T) {
		f := newRecallFixture(t)
		f.box.change(func(s *model.Snapshot) { s.Memories[0].Body = strings.Repeat("x", 20000) })
		b, _ := beginRecall(t, f, "mixed-size")
		r := completeRecall(t, f.s, b, chooseRecall(f.box.s.Memories[0], f.box.s.Memories[1]), "claimed")
		if len(r.Context) > f.s.Config.Recall.OutputBytes || !strings.Contains(r.Context, "m-team") || strings.Contains(r.Context, "m-local") {
			t.Fatalf("invalid bound result: %+v", r)
		}
	})
	t.Run("configured_output_count", func(t *testing.T) {
		f := newRecallFixture(t)
		f.s.Config.Recall.OutputCount = 1
		b, _ := beginRecall(t, f, "count")
		r := completeRecall(t, f.s, b, chooseRecall(f.box.s.Memories[0], f.box.s.Memories[1]), "claimed")
		if strings.Contains(r.Context, "m-team") || !strings.Contains(r.Context, "m-local") {
			t.Fatalf("count budget: %+v", r)
		}
	})
	t.Run("bad_decision_does_not_claim", func(t *testing.T) {
		f := newRecallFixture(t)
		b, _ := beginRecall(t, f, "invalid")
		d := chooseRecall(f.box.s.Memories[0])
		d.References[0].Revision = "fabricated-revision"
		if _, err := f.s.Complete(context.Background(), b, d); err == nil {
			t.Fatal("malformed revision accepted")
		}
		completeRecall(t, f.s, b, chooseRecall(f.box.s.Memories[0]), "claimed")
	})
}

func TestRecallStaleCancellationAndResetCannotAffectNewGeneration(t *testing.T) {
	f := newRecallFixture(t)
	old, first := beginRecall(t, f, "old")
	current, second := beginRecall(t, f, "new")
	if first.RequestID == second.RequestID {
		t.Fatal("new observation reused request generation")
	}
	for _, reset := range []bool{false, true} {
		r, err := f.s.Cancel(old, reset)
		if err != nil || r.Status != "stale" || r.Epoch != second.Epoch {
			t.Fatalf("stale cancel/reset=%v: %+v %v", reset, r, err)
		}
		callRecallTool(t, f.s, current, "memory_context", `{}`)
	}
	if _, err := f.s.Tool(context.Background(), old, "memory_context", json.RawMessage(`{}`)); err == nil {
		t.Fatal("superseded request retained tools")
	}
	completeRecall(t, f.s, old, chooseRecall(f.box.s.Memories[0]), "stale")
	// A cancellation keyed only by an old turn must also preserve the newer request.
	old.RequestID = ""
	if r, err := f.s.Cancel(old, true); err != nil || r.Status != "stale" {
		t.Fatalf("old turn reset: %+v %v", r, err)
	}
	completeRecall(t, f.s, current, chooseRecall(f.box.s.Memories[0]), "claimed")
	resetBinding := f.binding
	resetBinding.EventID = "compact-once"
	r, err := f.s.Cancel(resetBinding, true)
	if err != nil {
		t.Fatal(err)
	}
	next, started := beginRecall(t, f, "after-reset")
	duplicate, err := f.s.Cancel(resetBinding, true)
	if err != nil || duplicate.Status != "duplicate_reset" || duplicate.Epoch != r.Epoch || started.Epoch != r.Epoch {
		t.Fatalf("duplicate reset: %+v %v", duplicate, err)
	}
	callRecallTool(t, f.s, next, "memory_context", `{}`)
	completeRecall(t, f.s, next, chooseRecall(f.box.s.Memories[0]), "claimed")
}
