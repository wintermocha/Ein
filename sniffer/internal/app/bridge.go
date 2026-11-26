package app

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"

	"ein.local/sniffer/internal/config"
	"ein.local/sniffer/internal/model"
	"ein.local/sniffer/internal/native"
	"ein.local/sniffer/internal/recall"
)

type bridgeInput struct {
	recall.Binding
	Query      string          `json:"query,omitempty"`
	Context    string          `json:"context,omitempty"`
	Name       string          `json:"name,omitempty"`
	Arguments  json.RawMessage `json:"arguments,omitempty"`
	Decision   native.Decision `json:"decision,omitempty"`
	DeliveryID string          `json:"delivery_id,omitempty"`
	Epoch      int             `json:"epoch,omitempty"`
	Outcome    string          `json:"outcome,omitempty"`
	Role       string          `json:"role,omitempty"`
	AgentID    string          `json:"agent_id,omitempty"`
}

func (a app) bridge(args []string) error {
	if len(args) != 1 {
		return errors.New("bridge requires begin, tool, complete, ack, cancel, reset, or write")
	}
	b, err := io.ReadAll(io.LimitReader(a.in, 128*1024+1))
	if err != nil {
		return err
	}
	if len(b) > 128*1024 {
		return errors.New("bridge request exceeds budget")
	}
	var in bridgeInput
	if err = decodeStrict(b, &in); err != nil {
		return err
	}
	if in.Cwd == "" {
		in.Cwd, err = os.Getwd()
		if err != nil {
			return err
		}
	}
	c, err := config.Load(a.paths)
	if err != nil {
		return err
	}
	binding, err := a.bindProject("", in.Cwd, false)
	if err != nil {
		return err
	}
	service := recall.New(a.paths, c, func(ctx context.Context) (model.Snapshot, error) {
		return a.projectSnapshot(ctx, binding)
	})
	service.ExpectedProject = binding.id
	ctx := context.Background()
	var value any
	switch args[0] {
	case "begin":
		value, err = service.Begin(ctx, recall.BeginInput{Binding: in.Binding, Query: in.Query, Context: in.Context})
	case "tool":
		value, err = service.Tool(ctx, in.Binding, in.Name, in.Arguments)
	case "complete":
		value, err = service.Complete(ctx, in.Binding, in.Decision)
	case "ack":
		err = service.Ack(in.Binding, in.DeliveryID, in.Epoch, in.Outcome)
		value = map[string]any{"status": "acknowledged"}
	case "cancel", "reset":
		value, err = service.Cancel(in.Binding, args[0] == "reset")
	case "write":
		if os.Getenv("EIN_SNIFFER_ROLE") == "memory-agent" || in.Role != "main" || in.AgentID != "" {
			return errors.New("only the main LLM may request memory writes")
		}
		if in.Name != "memory_save" && in.Name != "memory_promote" {
			return errors.New("unknown writer tool")
		}
		if in.Host != "claude" || in.ConversationID == "" {
			return errors.New("writer requires the current main Claude session binding")
		}
		value, err = a.mcpCall(binding, in.Name, in.Arguments)
	default:
		return errors.New("unsupported bridge operation")
	}
	if err != nil {
		return err
	}
	return a.json(value)
}

// agentGuard is used only by the isolated agy memory-agent workspace. It is an
// enforcement hook before execution, not a detector after a dangerous action.
func (a app) agentGuard(args []string) error {
	if len(args) != 1 || args[0] != "agy" {
		return errors.New("agent-guard currently supports agy")
	}
	raw, err := io.ReadAll(io.LimitReader(a.in, 1<<20+1))
	if err != nil {
		return err
	}
	deny := map[string]string{"decision": "deny", "reason": "Sniffer is read-only and can only call its three bound memory reader tools."}
	if len(raw) > 1<<20 {
		return a.json(deny)
	}
	var event struct {
		ToolCall struct {
			Name string `json:"name"`
		} `json:"toolCall"`
	}
	if json.Unmarshal(raw, &event) != nil {
		return a.json(deny)
	}
	name := strings.TrimSpace(event.ToolCall.Name)
	if os.Getenv("EIN_SNIFFER_ROLE") != "memory-agent" {
		return a.json(deny)
	}
	for _, allowed := range []string{"mcp_sniffer_memory_search", "mcp_sniffer_memory_read", "mcp_sniffer_memory_context"} {
		if name == allowed {
			return a.json(map[string]string{"decision": "auto_approve", "reason": "Read-only, project-bound Sniffer memory tool."})
		}
	}
	return a.json(deny)
}
