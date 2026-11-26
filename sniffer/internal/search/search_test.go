package search

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"ein.local/sniffer/internal/model"
	"golang.org/x/text/unicode/norm"
)

func fixture() model.Snapshot {
	return model.Snapshot{
		Commit: "unrelated-git-commit-a",
		Registry: model.Registry{SchemaVersion: 1, Scopes: []model.Scope{
			{ID: "global", Kind: "global"},
			{ID: "group:work", Kind: "group", Parent: "global"},
			{ID: "group:payments", Kind: "group", Parent: "group:work"},
			{ID: "project:folder-1", Kind: "project", Parent: "group:payments"},
			{ID: "project:folder-2", Kind: "project", Parent: "group:payments"},
			{ID: "project:folder-3", Kind: "project", Parent: "group:work"},
		}},
		Glossary: [][]string{{"멱등성", "멱등 키", "idempotency", "idempotency key"}, {"재시도", "retry"}, {"코드 검토", "code review"}},
		Memories: []model.Memory{
			{SchemaVersion: 1, ID: "m-global", ScopeID: "global", Description: "한국어 설명 규칙", Body: "결정은 한국어로 기록한다."},
			{SchemaVersion: 1, ID: "m-review", ScopeID: "group:work", Description: "Code review format", Body: "Record evidence and impact."},
			{SchemaVersion: 1, ID: "m-payment", ScopeID: "group:payments", Description: "Payment idempotency key", Body: "A retried payment must keep the same key."},
			{SchemaVersion: 1, ID: "m-one", ScopeID: "project:folder-1", Description: "개발 포트", Aliases: []string{"dev port"}, Body: "Use port 4101."},
			{SchemaVersion: 1, ID: "m-private-two", ScopeID: "project:folder-2", Description: "violet-kiwi confidential rule", Body: "Private sibling marker BETA_SECRET."},
			{SchemaVersion: 1, ID: "m-private-three", ScopeID: "project:folder-3", Description: "violet-kiwi confidential rule", Body: "Private sibling marker GAMMA_SECRET."},
		},
	}
}

func ids(memories []model.Memory) []string {
	out := []string{}
	for _, m := range memories {
		out = append(out, m.ID)
	}
	return out
}
func hitIDs(hits []Hit) []string {
	out := []string{}
	for _, h := range hits {
		out = append(out, h.Memory.ID)
	}
	return out
}

func TestScopeFilteringBeforeSearch(t *testing.T) {
	s := fixture()
	listed, err := List(s, "folder-1", "")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"m-one", "m-payment", "m-review", "m-global"}
	if !reflect.DeepEqual(ids(listed), want) {
		t.Fatalf("visible IDs = %v, want %v", ids(listed), want)
	}
	hits, err := Find(s, "folder-1", "violet-kiwi", 20)
	if err != nil || len(hits) != 0 {
		t.Fatalf("private sibling reached search: %+v, %v", hits, err)
	}
	if _, err := Read(s, "folder-1", "m-private-two"); err == nil {
		t.Fatal("private sibling was readable")
	}
	if _, err := List(s, "folder-1", "project:folder-2"); err == nil {
		t.Fatal("scope filter widened authorization")
	}
	if _, err := List(s, "folder-3", "group:payments"); err == nil {
		t.Fatal("unrelated group was readable")
	}
	global, err := List(s, "project:folder-1", "global")
	if err != nil || !reflect.DeepEqual(ids(global), []string{"m-global"}) {
		t.Fatalf("global filter = %v, %v", ids(global), err)
	}
}

func TestBilingualGlossaryAliasesAndUnicode(t *testing.T) {
	s := fixture()
	s.Memories = append(s.Memories, model.Memory{SchemaVersion: 1, ID: "m-ko", ScopeID: "global", Description: "재시도 정책", Body: "실패하면 재시도한다."})
	s.Memories = append(s.Memories, model.Memory{SchemaVersion: 1, ID: "m-fold", ScopeID: "global", Description: "Straße convention", Body: "A sample name."})
	cases := []struct{ query, want string }{
		{"멱등성", "m-payment"},
		{"IDEMPOTENCY KEY", "m-payment"},
		{norm.NFD.String("멱등성"), "m-payment"},
		{"retry", "m-ko"},
		{"DEV--PORT!", "m-one"},
		{"코드 검토", "m-review"},
		{"STRASSE", "m-fold"},
	}
	for _, tc := range cases {
		t.Run(tc.query, func(t *testing.T) {
			hits, err := Find(s, "folder-1", tc.query, 20)
			if err != nil {
				t.Fatal(err)
			}
			found := false
			for _, h := range hits {
				if h.Memory.ID == tc.want {
					found = true
				}
			}
			if !found {
				t.Fatalf("query %q got %v, missing %s", tc.query, hitIDs(hits), tc.want)
			}
		})
	}
	hits, err := Find(s, "folder-1", "idempotency", 20)
	if err != nil || len(hits) == 0 {
		t.Fatal("missing glossary expansion")
	}
	if !reflect.DeepEqual(hits[0].Expanded, []string{"idempotency key", "멱등 키", "멱등성"}) {
		t.Fatalf("expansion order = %v", hits[0].Expanded)
	}
}

func TestKoreanSpacingFallbackAndUnrelatedQueries(t *testing.T) {
	s := fixture()
	s.Glossary = nil
	s.Memories = []model.Memory{{SchemaVersion: 1, ID: "m-space", ScopeID: "global", Description: "결제 재시도 방식", Body: "샘플"}}
	hits, err := Find(s, "folder-1", "결제재시도", 20)
	if err != nil || len(hits) != 1 || hits[0].Score <= 0 || hits[0].Score > 1 {
		t.Fatalf("Hangul fallback = %+v, %v", hits, err)
	}
	for _, q := range []string{"", "  !!! ", "astronomy", "완전히무관한단어"} {
		hits, err = Find(s, "folder-1", q, 20)
		if err != nil || len(hits) != 0 {
			t.Fatalf("irrelevant %q produced %+v, %v", q, hits, err)
		}
	}
	if score := hangulScore("가기", "가기"); score != 0 {
		t.Fatalf("one bigram should not activate fallback, score=%v", score)
	}
}

func TestExplicitKeyOverridesAreSpecificAndRelevant(t *testing.T) {
	s := fixture()
	s.Memories = []model.Memory{
		{SchemaVersion: 1, ID: "m-g", ScopeID: "global", Description: "development server port", Key: "dev.port", Body: "Use 3000."},
		{SchemaVersion: 1, ID: "m-w", ScopeID: "group:work", Description: "work server port", Key: "dev.port", Body: "Use 4000."},
		{SchemaVersion: 1, ID: "m-p", ScopeID: "group:payments", Description: "payments server port", Key: "dev.port", Body: "Use 4100."},
		{SchemaVersion: 1, ID: "m-local", ScopeID: "project:folder-1", Description: "이 폴더의 설정값", Key: "dev.port", Body: "Use 4101."},
		{SchemaVersion: 1, ID: "m-complement", ScopeID: "global", Description: "server port health probe", Body: "Probe /health."},
	}
	hits, err := Find(s, "folder-1", "development server port", 20)
	if err != nil {
		t.Fatal(err)
	}
	got := hitIDs(hits)
	if !reflect.DeepEqual(got, []string{"m-local", "m-complement"}) {
		t.Fatalf("override IDs = %v", got)
	}
	if hits[0].Memory.Body != "Use 4101." || hits[0].ScopeDistance != 0 {
		t.Fatalf("wrong closest value %+v", hits[0])
	}
	hits, err = Find(s, "folder-2", "server port", 20)
	if err != nil || len(hits) != 2 || hits[0].Memory.ID != "m-p" {
		t.Fatalf("nearest group selection = %+v, %v", hits, err)
	}
	hits, err = Find(s, "folder-1", "astronomy", 20)
	if err != nil || len(hits) != 0 {
		t.Fatalf("scope specificity injected unrelated rule: %+v, %v", hits, err)
	}
	// The explicit list/read API preserves source visibility for review; only
	// automatic candidate selection collapses overrides.
	if m, err := Read(s, "folder-1", "m-g"); err != nil || m.ID != "m-g" {
		t.Fatalf("inherited source was hidden: %+v %v", m, err)
	}
}

func TestDeterministicTieBreakAndReadOnlySnapshot(t *testing.T) {
	s := fixture()
	s.Memories = []model.Memory{
		{ID: "m-z", ScopeID: "global", Description: "fixture topic", Body: "z"},
		{ID: "m-b", ScopeID: "project:folder-1", Description: "fixture topic", Body: "b"},
		{ID: "m-a", ScopeID: "project:folder-1", Description: "fixture topic", Body: "a"},
	}
	before, _ := json.Marshal(s)
	for n := 0; n < 10; n++ {
		hits, err := Find(s, "folder-1", "fixture topic", 2)
		if err != nil || !reflect.DeepEqual(hitIDs(hits), []string{"m-a", "m-b"}) {
			t.Fatalf("unstable order = %v, %v", hitIDs(hits), err)
		}
		if _, err = List(s, "folder-1", ""); err != nil {
			t.Fatal(err)
		}
		if _, err = Read(s, "folder-1", "m-z"); err != nil {
			t.Fatal(err)
		}
	}
	after, _ := json.Marshal(s)
	if string(before) != string(after) {
		t.Fatal("read-only retrieval mutated its snapshot")
	}
}

func TestInvalidScopesAndBoundsFailClosed(t *testing.T) {
	s := fixture()
	for _, project := range []string{"", "unknown", "global", "group:work", " project:folder-1"} {
		if _, err := Find(s, project, "fixture", 20); err == nil {
			t.Errorf("invalid project %q accepted", project)
		}
	}
	if _, err := Find(s, "unknown", "", 20); err == nil {
		t.Fatal("empty query bypassed scope validation")
	}
	for _, q := range []string{strings.Repeat("x", 8193), string([]byte{0xff})} {
		if _, err := Find(s, "folder-1", q, 20); err == nil {
			t.Fatal("invalid query accepted")
		}
	}
	if _, err := Find(s, "folder-1", "anything", 101); err == nil {
		t.Fatal("excessive limit accepted")
	}
	s.Registry.Scopes[1].Parent = "group:payments"
	if _, err := Find(s, "folder-1", "anything", 20); err == nil {
		t.Fatal("cyclic hierarchy accepted")
	}
}
