package model

import (
	"reflect"
	"testing"
)

func registry() Registry {
	return Registry{SchemaVersion: 1, Scopes: []Scope{{ID: "global", Kind: "global"}, {ID: "group:work", Kind: "group", Parent: "global"}, {ID: "group:payments", Kind: "group", Parent: "group:work"}, {ID: "project:alpha", Kind: "project", Parent: "group:payments"}}}
}
func TestScopeTreeAndPaths(t *testing.T) {
	r := registry()
	got, err := Ancestors(r, "project:alpha")
	if err != nil || !reflect.DeepEqual(got, []string{"project:alpha", "group:payments", "group:work", "global"}) {
		t.Fatalf("ancestors = %v, %v", got, err)
	}
	for _, tc := range []struct{ scope, id, want string }{{"global", "m-note", "global/m-note.md"}, {"group:work", "m-note", "groups/work/m-note.md"}, {"project:alpha", "m-note", "projects/alpha/m-note.md"}} {
		p, err := ScopePath(tc.scope, tc.id)
		if err != nil || p != tc.want {
			t.Fatalf("ScopePath = %q, %v", p, err)
		}
	}
	for _, bad := range []string{"../secret", "A", "a/b", "a\\b", ".git", "a\n"} {
		if _, err := ScopePath("global", bad); err == nil {
			t.Errorf("accepted unsafe ID %q", bad)
		}
	}
	if _, err := Ancestors(r, "project:unknown"); err == nil {
		t.Fatal("accepted unknown scope")
	}
}
func TestRejectInvalidRegistries(t *testing.T) {
	for _, tc := range []struct {
		name  string
		alter func(*Registry)
	}{
		{"duplicate", func(r *Registry) { r.Scopes = append(r.Scopes, r.Scopes[0]) }},
		{"missing-parent", func(r *Registry) { r.Scopes[1].Parent = "group:missing" }},
		{"cycle", func(r *Registry) { r.Scopes[1].Parent = "group:payments" }},
		{"project-parent", func(r *Registry) { r.Scopes[1].Parent = "project:alpha" }},
		{"kind", func(r *Registry) { r.Scopes[1].Kind = "project" }},
		{"global-parent", func(r *Registry) { r.Scopes[0].Parent = "group:work" }},
		{"missing-global", func(r *Registry) { r.Scopes = r.Scopes[1:] }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := registry()
			tc.alter(&r)
			if err := ValidateRegistry(r); err == nil {
				t.Fatal("accepted invalid registry")
			}
		})
	}
}
func TestContentHashUsesMeaningAndNFC(t *testing.T) {
	m := Memory{SchemaVersion: 1, ID: "m-note", ScopeID: "project:alpha", Description: "설정", Body: "한글\r\nconfig", Key: "key"}
	h := HashMemory(m)
	m.ScopeID = "global"
	m.Path = "global/m-note.md"
	m.UpdatedAt = "2026-11-25T00:00:00Z"
	m.Aliases = []string{"configuration"}
	m.Revision = "new-revision"
	if HashMemory(m) != h {
		t.Fatal("non-delivered metadata changed content hash")
	}
	m.Body = "한글\nconfig"
	if HashMemory(m) != h {
		t.Fatal("NFC/line-ending equivalent content hashes differ")
	}
	m.Body += " changed"
	if HashMemory(m) == h {
		t.Fatal("body edit did not change hash")
	}
}
