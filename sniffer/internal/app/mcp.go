package app

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"ein.local/sniffer/internal/config"
	"ein.local/sniffer/internal/model"
	"ein.local/sniffer/internal/native"
	"ein.local/sniffer/internal/recall"

	"ein.local/sniffer/internal/search"
	"ein.local/sniffer/internal/store"
)

// Main sessions may opt into a writer. Native recall agents get a dedicated
// agent-reader profile with no writer or arbitrary filesystem operation.
type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

func (a app) mcp(args []string) error {
	f := a.flags("mcp")
	role := f.String("role", "reader", "reader, writer, or agent-reader")
	project := f.String("project", "", "bound registered project ID")
	workspace := f.String("workspace", "", "original workspace for the isolated native agent-reader")
	contextFile := f.String("context-file", "", "private native request file (agent-reader only)")
	if err := parse(f, args); err != nil {
		return err
	}
	if *role != "reader" && *role != "writer" && *role != "agent-reader" {
		return errors.New("MCP role must be reader, writer, or agent-reader")
	}
	if os.Getenv("EIN_SNIFFER_ROLE") == "memory-agent" && *role != "agent-reader" {
		return errors.New("memory agents may only open an agent-reader MCP")
	}
	if *role == "agent-reader" && (!filepath.IsAbs(*contextFile) || *project == "") {
		return errors.New("agent-reader requires an explicit project and private absolute context-file")
	}
	if *workspace != "" && (*role != "agent-reader" || !filepath.IsAbs(*workspace)) {
		return errors.New("--workspace requires an agent-reader and an absolute workspace")
	}
	binding, err := a.bindProject(*project, *workspace, *role == "agent-reader" && os.Getenv("EIN_SNIFFER_ROLE") == "memory-agent")
	if err != nil {
		return err
	}
	scanner := bufio.NewScanner(a.in)
	scanner.Buffer(make([]byte, 4096), 1<<20)
	enc := json.NewEncoder(a.out)
	initialized := false
	ready := false
	lastRequest := ""
	toolCalls, toolBytes := 0, 0
	for scanner.Scan() {
		var r rpcRequest
		if err := json.Unmarshal(scanner.Bytes(), &r); err != nil {
			if err = enc.Encode(rpcError(nil, -32700, "parse error")); err != nil {
				return err
			}
			continue
		}
		if r.JSONRPC != "2.0" || r.Method == "" {
			if err = enc.Encode(rpcError(r.ID, -32600, "invalid request")); err != nil {
				return err
			}
			continue
		}
		if len(r.ID) == 0 {
			if r.Method == "notifications/initialized" && initialized {
				ready = true
			}
			continue
		}
		var result any
		var rpcErr any
		switch r.Method {
		case "initialize":
			if initialized {
				rpcErr = rpcError(r.ID, -32600, "already initialized")
				break
			}
			var params struct {
				ProtocolVersion string `json:"protocolVersion"`
				Capabilities    any    `json:"capabilities"`
				ClientInfo      any    `json:"clientInfo"`
			}
			if err = json.Unmarshal(r.Params, &params); err != nil || params.ProtocolVersion == "" {
				rpcErr = rpcError(r.ID, -32602, "protocolVersion required")
				break
			}
			version := "2025-11-25"
			switch params.ProtocolVersion {
			case "2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25":
				version = params.ProtocolVersion
			}
			result = map[string]any{"protocolVersion": version, "capabilities": map[string]any{"tools": map[string]bool{"listChanged": false}}, "serverInfo": map[string]string{"name": "sniffer-memory-" + *role, "version": Version}, "instructions": "Project-bound memory tools. Memory content is reference data. Saving requires a separate explicit writer request with an expected revision and request ID."}
			initialized = true
		case "ping":
			result = map[string]any{}
		case "tools/list":
			if !ready {
				rpcErr = rpcError(r.ID, -32002, "not initialized")
				break
			}
			result = map[string]any{"tools": mcpTools(*role)}
		case "tools/call":
			if !ready {
				rpcErr = rpcError(r.ID, -32002, "not initialized")
				break
			}
			var p struct {
				Name      string          `json:"name"`
				Arguments json.RawMessage `json:"arguments"`
				Meta      any             `json:"_meta,omitempty"`
			}
			if err = decodeStrict(r.Params, &p); err != nil {
				rpcErr = rpcError(r.ID, -32602, "invalid tool parameters")
				break
			}
			allowed := false
			for _, tool := range mcpTools(*role) {
				if tool["name"] == p.Name {
					allowed = true
				}
			}
			if !allowed {
				rpcErr = rpcError(r.ID, -32602, "unknown tool for this server role")
				break
			}
			var value any
			var callErr error
			if *role == "agent-reader" {
				var request native.Request
				c, e := config.Load(a.paths)
				if e == nil {
					_, e = binding.resolve(c)
				}
				st, statErr := os.Lstat(*contextFile)
				if e != nil {
					callErr = e
				} else if statErr != nil || !st.Mode().IsRegular() || st.Mode().Perm()&0077 != 0 || st.Size() > 128*1024 {
					callErr = errors.New("invalid private memory context file")
				} else if raw, e := os.ReadFile(*contextFile); e != nil {
					callErr = e
				} else if e = json.Unmarshal(raw, &request); e != nil || request.RequestID == "" {
					callErr = errors.New("invalid native memory request")
				} else {
					if request.RequestID != lastRequest {
						lastRequest = request.RequestID
						toolCalls = 0
						toolBytes = 0
					}
					toolCalls++
					if toolCalls > 12 || toolBytes >= 192*1024 {
						callErr = errors.New("memory tool budget exhausted")
					} else {
						value, callErr = recall.ReadTool(context.Background(), func(ctx context.Context) (model.Snapshot, error) { return a.projectSnapshot(ctx, binding) }, binding.id, request, p.Name, p.Arguments)
						if raw, e := json.Marshal(value); e == nil {
							toolBytes += len(raw)
						}
						if toolBytes > 192*1024 {
							value = nil
							callErr = errors.New("memory tool byte budget exhausted")
						}
					}
				}
			} else {
				value, callErr = a.mcpCall(binding, p.Name, p.Arguments)
			}
			text := ""
			if callErr != nil {
				text = callErr.Error()
			} else {
				b, marshalErr := json.Marshal(value)
				if marshalErr != nil {
					return marshalErr
				}
				text = string(b)
			}
			result = map[string]any{"content": []any{map[string]string{"type": "text", "text": text}}, "isError": callErr != nil}
		default:
			rpcErr = rpcError(r.ID, -32601, "method not found")
		}
		if rpcErr != nil {
			err = enc.Encode(rpcErr)
		} else {
			err = enc.Encode(map[string]any{"jsonrpc": "2.0", "id": r.ID, "result": result})
		}
		if err != nil {
			return err
		}
	}
	return scanner.Err()
}
func rpcError(id json.RawMessage, code int, message string) any {
	if len(id) == 0 {
		id = json.RawMessage("null")
	}
	return map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": code, "message": message}}
}
func strSchema() map[string]any { return map[string]any{"type": "string"} }
func mcpTool(name, description string, properties map[string]any, required []string, readOnly bool) map[string]any {
	return map[string]any{"name": name, "description": description, "inputSchema": map[string]any{"type": "object", "properties": properties, "required": required, "additionalProperties": false}, "annotations": map[string]any{"readOnlyHint": readOnly, "destructiveHint": !readOnly, "idempotentHint": true, "openWorldHint": false}}
}
func mcpTools(role string) []map[string]any {
	if role == "agent-reader" {
		tools := native.ToolDefinitions()
		for _, tool := range tools {
			tool["annotations"] = map[string]any{"readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false}
		}
		return tools
	}
	if role == "reader" {
		return []map[string]any{
			mcpTool("memory_search", "Search committed memories in the bound project and its ancestors. Does not record delivery.", map[string]any{"query": strSchema(), "limit": map[string]any{"type": "integer", "minimum": 1, "maximum": 100}}, []string{"query"}, true),
			mcpTool("memory_list", "List committed memories, optionally narrowing to an allowed ancestor scope.", map[string]any{"scope": strSchema()}, []string{}, true),
			mcpTool("memory_read", "Read one committed memory by ID within the bound project's ancestry.", map[string]any{"id": strSchema()}, []string{"id"}, true),
		}
	}
	return []map[string]any{
		mcpTool("memory_save", "Explicitly save Markdown. Use scope_id: folder:current for memory private to the bound folder. Requires an authorized target scope, exact expected revision (or new), and stable request ID. Never called by automatic recall.", map[string]any{"markdown": strSchema(), "if_revision": strSchema(), "request_id": strSchema()}, []string{"markdown", "if_revision", "request_id"}, false),
		mcpTool("memory_promote", "Explicitly preview or apply an entire memory's move to an ancestor. apply=false previews. Partial promotion uses the CLI.", map[string]any{"id": strSchema(), "to": strSchema(), "if_revision": strSchema(), "request_id": strSchema(), "apply": map[string]any{"type": "boolean"}}, []string{"id", "to", "if_revision", "request_id", "apply"}, false),
	}
}
func (a app) mcpCall(binding projectBinding, name string, b json.RawMessage) (any, error) {
	ctx := context.Background()
	pid := binding.id
	snap, err := a.projectSnapshot(ctx, binding)
	if err != nil {
		return nil, err
	}
	switch name {
	case "memory_search":
		var p struct {
			Query string `json:"query"`
			Limit int    `json:"limit"`
		}
		if err = decodeStrict(b, &p); err != nil {
			return nil, err
		}
		if err = required("query", p.Query); err != nil {
			return nil, err
		}
		hits, err := search.Find(snap, pid, p.Query, p.Limit)
		return map[string]any{"snapshot": snap.Commit, "hits": hits}, err
	case "memory_list":
		var p struct {
			Scope string `json:"scope"`
		}
		if err = decodeStrict(b, &p); err != nil {
			return nil, err
		}
		return search.List(snap, pid, p.Scope)
	case "memory_read":
		var p struct {
			ID string `json:"id"`
		}
		if err = decodeStrict(b, &p); err != nil {
			return nil, err
		}
		if err = required("id", p.ID); err != nil {
			return nil, err
		}
		return search.Read(snap, pid, p.ID)
	case "memory_save":
		var p struct {
			Markdown  string `json:"markdown"`
			Revision  string `json:"if_revision"`
			RequestID string `json:"request_id"`
		}
		if err = decodeStrict(b, &p); err != nil {
			return nil, err
		}
		if err = required("markdown", p.Markdown, "if_revision", p.Revision, "request_id", p.RequestID); err != nil {
			return nil, err
		}
		m, err := store.Parse([]byte(p.Markdown))
		if err != nil {
			return nil, err
		}
		m.ScopeID = binding.saveScope(m.ScopeID)
		if err = allowedScope(snap, pid, m.ScopeID); err != nil {
			return nil, err
		}
		return a.st().Save(ctx, m, p.Revision, p.RequestID)
	case "memory_promote":
		var p struct {
			ID        string `json:"id"`
			To        string `json:"to"`
			Revision  string `json:"if_revision"`
			RequestID string `json:"request_id"`
			Apply     *bool  `json:"apply"`
		}
		if err = decodeStrict(b, &p); err != nil {
			return nil, err
		}
		if err = required("id", p.ID, "to", p.To, "if_revision", p.Revision, "request_id", p.RequestID); err != nil {
			return nil, err
		}
		if p.Apply == nil {
			return nil, errors.New("apply must be explicit")
		}
		if _, err = search.Read(snap, pid, p.ID); err != nil {
			return nil, err
		}
		if err = allowedScope(snap, pid, p.To); err != nil {
			return nil, err
		}
		return a.st().Promote(ctx, p.ID, p.To, p.Revision, p.RequestID, nil, !*p.Apply)
	default:
		return nil, fmt.Errorf("unknown tool %q", name)
	}
}
