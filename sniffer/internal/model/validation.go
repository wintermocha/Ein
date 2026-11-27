package model

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

var slugPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)
var revisionPattern = regexp.MustCompile(`^(?:[0-9a-f]{40}|[0-9a-f]{64})$`)

// ScopePath produces the only permitted relative filename for a memory.
func ScopePath(scope, id string) (string, error) {
	if !slugPattern.MatchString(id) {
		return "", fmt.Errorf("invalid memory ID %q", id)
	}
	if scope == "global" {
		return "global/" + id + ".md", nil
	}
	prefix, slug, ok := strings.Cut(scope, ":")
	if !ok || !slugPattern.MatchString(slug) {
		return "", fmt.Errorf("invalid scope ID %q", scope)
	}
	switch prefix {
	case "folder":
		return "folders/" + slug + "/" + id + ".md", nil
	case "group":
		return "groups/" + slug + "/" + id + ".md", nil
	case "project":
		return "projects/" + slug + "/" + id + ".md", nil
	default:
		return "", fmt.Errorf("invalid scope ID %q", scope)
	}
}

// ValidateRegistry validates the explicit single-parent scope tree.
func ValidateRegistry(r Registry) error {
	if r.SchemaVersion != 1 || len(r.Scopes) == 0 || len(r.Scopes) > 10000 {
		return fmt.Errorf("invalid registry schema or scope count")
	}
	byID := make(map[string]Scope, len(r.Scopes))
	for _, s := range r.Scopes {
		if _, err := ScopePath(s.ID, "m-validation"); err != nil {
			return err
		}
		if _, exists := byID[s.ID]; exists {
			return fmt.Errorf("duplicate scope %q", s.ID)
		}
		kind := strings.SplitN(s.ID, ":", 2)[0]
		if s.Kind != kind {
			return fmt.Errorf("scope %q kind does not match ID", s.ID)
		}
		if s.ID == "global" && s.Parent != "" {
			return fmt.Errorf("global scope must have no parent")
		}
		if s.ID != "global" && s.Parent == "" {
			return fmt.Errorf("scope %q requires a parent", s.ID)
		}
		byID[s.ID] = s
	}
	if _, ok := byID["global"]; !ok {
		return fmt.Errorf("registry requires global scope")
	}
	for _, s := range r.Scopes {
		seen := map[string]bool{}
		for s.ID != "global" {
			if seen[s.ID] {
				return fmt.Errorf("scope cycle at %q", s.ID)
			}
			seen[s.ID] = true
			p, exists := byID[s.Parent]
			if !exists {
				return fmt.Errorf("scope %q has missing parent %q", s.ID, s.Parent)
			}
			if p.Kind == "folder" || (p.Kind == "project" && s.Kind != "folder") {
				return fmt.Errorf("scope %q cannot be a parent here", p.ID)
			}
			s = p
		}
	}
	return nil
}

func Ancestors(r Registry, scope string) ([]string, error) {
	if err := ValidateRegistry(r); err != nil {
		return nil, err
	}
	byID := make(map[string]Scope, len(r.Scopes))
	for _, s := range r.Scopes {
		byID[s.ID] = s
	}
	if _, ok := byID[scope]; !ok {
		return nil, fmt.Errorf("unregistered scope %q", scope)
	}
	var result []string
	for scope != "" {
		result = append(result, scope)
		scope = byID[scope].Parent
	}
	return result, nil
}

func ValidateMemory(m Memory) error {
	if m.SchemaVersion != 1 {
		return fmt.Errorf("schema_version must be 1")
	}
	if _, err := ScopePath(m.ScopeID, m.ID); err != nil {
		return err
	}
	if err := validText("description", m.Description, 2048, true); err != nil {
		return err
	}
	if err := validText("body", m.Body, 65536, true); err != nil {
		return err
	}
	if err := validText("key", m.Key, 256, false); err != nil {
		return err
	}
	for name, values := range map[string][]string{"aliases": m.Aliases, "tags": m.Tags} {
		if len(values) > 32 {
			return fmt.Errorf("too many %s", name)
		}
		for _, v := range values {
			if err := validText(name, v, 256, true); err != nil {
				return err
			}
		}
	}
	if m.UpdatedAt != "" {
		if _, err := time.Parse(time.RFC3339, m.UpdatedAt); err != nil {
			return fmt.Errorf("invalid updated_at: %w", err)
		}
	}
	if m.DerivedFrom != nil {
		if !slugPattern.MatchString(m.DerivedFrom.ID) || m.DerivedFrom.ID == m.ID || !revisionPattern.MatchString(m.DerivedFrom.Revision) {
			return fmt.Errorf("invalid derived_from provenance")
		}
	}
	return nil
}

func validText(name, text string, max int, required bool) error {
	if !utf8.ValidString(text) || len(text) > max || (required && strings.TrimSpace(text) == "") {
		return fmt.Errorf("invalid %s: empty, invalid UTF-8, or too large", name)
	}
	for _, c := range text {
		if c == 0 || (c < 32 && c != '\n' && c != '\r' && c != '\t') {
			return fmt.Errorf("invalid control character in %s", name)
		}
	}
	return nil
}

// HashMemory deliberately excludes IDs, scope, provenance, aliases, timestamps,
// paths and Git revisions: changing placement does not repeat the same content.
func HashMemory(m Memory) string {
	normalize := func(s string) string { return norm.NFC.String(strings.TrimSpace(strings.ReplaceAll(s, "\r\n", "\n"))) }
	b, _ := json.Marshal(struct{ Description, Body, Key string }{normalize(m.Description), normalize(m.Body), normalize(m.Key)})
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

// AccessChain accepts a private folder only when its immediate parent agrees
// with the live workspace binding. Project-only readers never traverse children.
func (s Snapshot) AccessChain(project string) ([]string, error) {
	if s.FolderScope == "" {
		id := strings.TrimPrefix(project, "project:")
		if !slugPattern.MatchString(id) {
			return nil, fmt.Errorf("invalid project scope")
		}
		return Ancestors(s.Registry, "project:"+id)
	}
	chain, err := Ancestors(s.Registry, s.FolderScope)
	if err != nil {
		return nil, err
	}
	parent := "project:" + project
	if project == s.FolderScope {
		parent = "global"
	}
	if len(chain) < 2 || chain[1] != parent {
		return nil, fmt.Errorf("workspace folder hierarchy changed; bind the folder again")
	}
	return chain, nil
}
