// Package model defines Sniffer's independently designed on-disk and wire types.
package model

type Provenance struct {
	ID       string `json:"id" yaml:"id"`
	Revision string `json:"revision" yaml:"revision"`
}
type Memory struct {
	SchemaVersion int         `json:"schema_version" yaml:"schema_version"`
	ID            string      `json:"id" yaml:"id"`
	ScopeID       string      `json:"scope_id" yaml:"scope_id"`
	Description   string      `json:"description" yaml:"description"`
	Key           string      `json:"key,omitempty" yaml:"key,omitempty"`
	Aliases       []string    `json:"aliases,omitempty" yaml:"aliases,omitempty"`
	Tags          []string    `json:"tags,omitempty" yaml:"tags,omitempty"`
	UpdatedAt     string      `json:"updated_at,omitempty" yaml:"updated_at,omitempty"`
	DerivedFrom   *Provenance `json:"derived_from,omitempty" yaml:"derived_from,omitempty"`
	Body          string      `json:"body" yaml:"-"`
	Path          string      `json:"path,omitempty" yaml:"-"`
	Revision      string      `json:"revision,omitempty" yaml:"-"`
	ContentHash   string      `json:"content_hash,omitempty" yaml:"-"`
}
type Scope struct {
	ID     string `json:"id"`
	Kind   string `json:"kind"`
	Parent string `json:"parent,omitempty"`
}
type Registry struct {
	SchemaVersion int     `json:"schema_version"`
	Scopes        []Scope `json:"scopes"`
}
type Snapshot struct {
	FolderScope string     `json:"-"`
	Commit      string     `json:"commit"`
	Registry    Registry   `json:"registry"`
	Glossary    [][]string `json:"glossary"`
	Memories    []Memory   `json:"memories"`
}
