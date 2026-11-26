// Package store manages an independent, local Git repository of Markdown memories.
package store

import (
	"bytes"
	"fmt"
	"io"
	"strings"
	"unicode/utf8"

	"ein.local/sniffer/internal/model"
	"go.yaml.in/yaml/v3"
	"golang.org/x/text/unicode/norm"
)

const maxMemoryBytes = 98304

// Parse accepts the documented restricted YAML schema, not arbitrary YAML.
func Parse(data []byte) (model.Memory, error) {
	var m model.Memory
	if len(data) > maxMemoryBytes || !utf8.Valid(data) {
		return m, fmt.Errorf("memory is too large or not UTF-8")
	}
	data = bytes.ReplaceAll(data, []byte("\r\n"), []byte("\n"))
	if !bytes.HasPrefix(data, []byte("---\n")) {
		return m, fmt.Errorf("memory must start with YAML frontmatter")
	}
	end := bytes.Index(data[4:], []byte("\n---\n"))
	if end < 0 || end > 16384 {
		return m, fmt.Errorf("missing frontmatter terminator or oversized header")
	}
	header := data[4 : 4+end]
	body := data[4+end+5:]
	var node yaml.Node
	dec := yaml.NewDecoder(bytes.NewReader(header))
	if err := dec.Decode(&node); err != nil {
		return m, fmt.Errorf("frontmatter: %w", err)
	}
	if len(node.Content) != 1 || node.Content[0].Kind != yaml.MappingNode {
		return m, fmt.Errorf("frontmatter must be a mapping")
	}
	if err := checkYAML(node.Content[0]); err != nil {
		return m, err
	}
	if err := checkFields(node.Content[0]); err != nil {
		return m, err
	}
	dec = yaml.NewDecoder(bytes.NewReader(header))
	dec.KnownFields(true)
	if err := dec.Decode(&m); err != nil {
		return m, fmt.Errorf("frontmatter: %w", err)
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		return m, fmt.Errorf("multiple YAML documents are forbidden")
	}
	m.Body = norm.NFC.String(strings.TrimSpace(string(body)))
	m.Description = norm.NFC.String(m.Description)
	m.Key = norm.NFC.String(m.Key)
	if err := model.ValidateMemory(m); err != nil {
		return m, err
	}
	m.ContentHash = model.HashMemory(m)
	return m, nil
}

func checkYAML(n *yaml.Node) error {
	if n.Anchor != "" || n.Kind == yaml.AliasNode {
		return fmt.Errorf("YAML anchors and aliases are forbidden")
	}
	switch n.Tag {
	case "!!map", "!!seq", "!!str", "!!int":
	default:
		return fmt.Errorf("unsupported YAML tag %q", n.Tag)
	}
	if n.Kind == yaml.MappingNode {
		seen := map[string]bool{}
		for i := 0; i < len(n.Content); i += 2 {
			k := n.Content[i]
			if k.Kind != yaml.ScalarNode || k.Tag != "!!str" || seen[k.Value] {
				return fmt.Errorf("invalid or duplicate YAML key %q", k.Value)
			}
			seen[k.Value] = true
		}
	}
	for _, c := range n.Content {
		if err := checkYAML(c); err != nil {
			return err
		}
	}
	return nil
}

func checkFields(n *yaml.Node) error {
	for i := 0; i < len(n.Content); i += 2 {
		k, v := n.Content[i].Value, n.Content[i+1]
		switch k {
		case "schema_version":
			if v.Kind != yaml.ScalarNode || v.Tag != "!!int" || v.Value != "1" {
				return fmt.Errorf("schema_version must be the integer 1")
			}
		case "id", "scope_id", "description", "key", "updated_at":
			if v.Kind != yaml.ScalarNode || v.Tag != "!!str" {
				return fmt.Errorf("%s must be a YAML string", k)
			}
		case "aliases", "tags":
			if v.Kind != yaml.SequenceNode {
				return fmt.Errorf("%s must be a string sequence", k)
			}
			for _, item := range v.Content {
				if item.Kind != yaml.ScalarNode || item.Tag != "!!str" {
					return fmt.Errorf("%s must contain only strings", k)
				}
			}
		case "derived_from":
			if v.Kind != yaml.MappingNode || len(v.Content) != 4 {
				return fmt.Errorf("derived_from requires id and revision")
			}
			for j := 0; j < len(v.Content); j += 2 {
				if (v.Content[j].Value != "id" && v.Content[j].Value != "revision") || v.Content[j+1].Tag != "!!str" || v.Content[j+1].Kind != yaml.ScalarNode {
					return fmt.Errorf("invalid derived_from field")
				}
			}
		default:
			return fmt.Errorf("unknown frontmatter field %q", k)
		}
	}
	return nil
}

func Render(m model.Memory) ([]byte, error) {
	m.Description = norm.NFC.String(m.Description)
	m.Key = norm.NFC.String(m.Key)
	m.Body = norm.NFC.String(strings.TrimSpace(strings.ReplaceAll(m.Body, "\r\n", "\n")))
	if err := model.ValidateMemory(m); err != nil {
		return nil, err
	}
	header, err := yaml.Marshal(m)
	if err != nil {
		return nil, err
	}
	result := append([]byte("---\n"), header...)
	result = append(result, []byte("---\n"+m.Body+"\n")...)
	return result, nil
}
