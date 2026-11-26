package recall

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"

	"ein.local/sniffer/internal/model"
	"ein.local/sniffer/internal/native"
	"ein.local/sniffer/internal/search"
)

func decode(raw json.RawMessage, v any) error {
	if len(raw) == 0 {
		raw = json.RawMessage(`{}`)
	}
	if len(raw) > 16384 {
		return errors.New("tool arguments exceed budget")
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if e := d.Decode(v); e != nil {
		return e
	}
	var x any
	if d.Decode(&x) != io.EOF {
		return errors.New("trailing tool arguments")
	}
	return nil
}

// ReadTool is reusable through native tool callbacks and a dedicated reader MCP.
// Each request resolves the current committed snapshot; no previous candidate
// list limits which relevant memory the agent can discover.
func ReadTool(ctx context.Context, snapshot func(context.Context) (model.Snapshot, error), project string, request native.Request, name string, args json.RawMessage) (any, error) {
	switch name {
	case "memory_context":
		if err := decode(args, &struct{}{}); err != nil {
			return nil, err
		}
		return request, nil
	case "memory_search":
		var p struct {
			Query string `json:"query"`
			Limit int    `json:"limit"`
		}
		if err := decode(args, &p); err != nil {
			return nil, err
		}
		if p.Query == "" || len(p.Query) > 4096 {
			return nil, errors.New("search query required, at most 4 KiB")
		}
		if p.Limit == 0 {
			p.Limit = 8
		}
		if p.Limit < 1 || p.Limit > 20 {
			return nil, errors.New("search limit must be 1..20")
		}
		snap, err := snapshot(ctx)
		if err != nil {
			return nil, err
		}
		hits, err := search.Find(snap, project, p.Query, p.Limit)
		if err != nil {
			return nil, err
		}
		items := []map[string]any{}
		for _, h := range hits {
			runes := []rune(h.Memory.Body)
			end := len(runes)
			if end > 1000 {
				end = 1000
			}
			items = append(items, map[string]any{"id": h.Memory.ID, "revision": h.Memory.Revision, "scope": h.Memory.ScopeID, "description": h.Memory.Description, "body_excerpt": string(runes[:end]), "body_chars": len(runes), "truncated": end < len(runes)})
		}
		return map[string]any{"snapshot": snap.Commit, "memories": items, "hint": "Use memory_read for a relevant body or another page; change query to search again."}, nil
	case "memory_read":
		var p struct {
			ID     string `json:"id"`
			Offset int    `json:"offset"`
			Limit  int    `json:"limit"`
		}
		if err := decode(args, &p); err != nil {
			return nil, err
		}
		if p.ID == "" || p.Offset < 0 {
			return nil, errors.New("memory id and nonnegative offset required")
		}
		if p.Limit == 0 {
			p.Limit = 6000
		}
		if p.Limit < 1 || p.Limit > 16000 {
			return nil, errors.New("read limit must be 1..16000 characters")
		}
		snap, err := snapshot(ctx)
		if err != nil {
			return nil, err
		}
		m, err := search.Read(snap, project, p.ID)
		if err != nil {
			return nil, err
		}
		runes := []rune(m.Body)
		if p.Offset > len(runes) {
			return nil, errors.New("offset exceeds body length")
		}
		end := p.Offset + p.Limit
		if end > len(runes) {
			end = len(runes)
		}
		return map[string]any{"id": m.ID, "revision": m.Revision, "scope": m.ScopeID, "description": m.Description, "body": string(runes[p.Offset:end]), "offset": p.Offset, "next_offset": end, "total_chars": len(runes), "has_more": end < len(runes)}, nil
	default:
		return nil, errors.New("Sniffer memory agent is read-only; tool is not allowed")
	}
}
