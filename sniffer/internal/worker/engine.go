// Package worker adapts persistent native conversations for Codex and agy.
// Claude uses its native mod and the standalone bridge, without a Go worker.
package worker

import (
	"context"
	"crypto/sha256"
	"ein.local/sniffer/internal/config"
	"ein.local/sniffer/internal/host"
	"ein.local/sniffer/internal/model"
	"ein.local/sniffer/internal/native"
	"ein.local/sniffer/internal/recall"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

type SnapshotFunc func(context.Context) (model.Snapshot, error)
type SessionFactory func(string) (native.Session, error)
type Response = recall.Response
type Ack struct {
	ConversationID string `json:"conversation_id"`
	Epoch          int    `json:"epoch"`
	DeliveryID     string `json:"delivery_id"`
	Outcome        string `json:"outcome"`
}
type RecallRequest struct {
	ConversationID string   `json:"conversation_id"`
	IDs            []string `json:"ids"`
	Force          bool     `json:"force"`
	EventID        string   `json:"event_id"`
}
type job struct {
	done     chan struct{}
	cancel   context.CancelFunc
	binding  recall.Binding
	decision native.Decision
	err      error
	session  native.Session
}
type conversation struct {
	query, history, pending, lastEvent, signature string
	binding                                       recall.Binding
	session                                       native.Session
	job                                           *job
	suspended                                     bool
}
type Engine struct {
	Host, Project, Owner string
	Paths                config.Paths
	Limits               config.Recall
	Core                 *recall.Service
	Factory              SessionFactory
	ctx                  context.Context
	cancel               context.CancelFunc
	mu                   sync.Mutex
	wg                   sync.WaitGroup
	sessions             map[string]*conversation
	latest               string
}

func New(ctx context.Context, p config.Paths, c config.Config, h, project, owner string, snapshot SnapshotFunc, factory SessionFactory) *Engine {
	ctx, cancel := context.WithCancel(ctx)
	core := recall.New(p, c, snapshot)
	core.ExpectedProject = project
	return &Engine{Host: h, Project: project, Owner: owner, Paths: p, Limits: c.Recall, Core: core, Factory: factory, ctx: ctx, cancel: cancel, sessions: map[string]*conversation{}}
}
func RandomID() string { return recall.ID() }
func (e *Engine) Close() {
	e.cancel()
	e.mu.Lock()
	for _, s := range e.sessions {
		if s.job != nil {
			s.job.cancel()
		}
	}
	e.mu.Unlock()
	done := make(chan struct{})
	go func() { e.wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(4 * time.Second):
	}
	e.mu.Lock()
	states := make([]*conversation, 0, len(e.sessions))
	for _, s := range e.sessions {
		states = append(states, s)
	}
	e.mu.Unlock()
	for _, s := range states {
		e.mu.Lock()
		session, binding := s.session, s.binding
		e.mu.Unlock()
		if session != nil {
			_ = session.Close()
		}
		_, _ = e.Core.Cancel(binding, false)
	}
}

// Detach a busy transport before accepting another prompt. Native APIs are
// sequential; a cancelled Run must never race a new Run on the same thread.
func stopJob(s *conversation) {
	if s.job == nil {
		return
	}
	select {
	case <-s.job.done:
	default:
		s.job.cancel()
		s.session = nil
	}
	s.job = nil
}
func (e *Engine) validateEvent(v host.Event) error {
	if v.Host != e.Host || v.ConversationID == "" || len(v.Query) > 8192 || len(v.Context) > 32*1024 {
		return errors.New("invalid event binding or budget")
	}
	c, err := config.Load(e.Paths)
	if err != nil {
		return err
	}
	id, err := c.ResolveWorkspaces(v.WorkspacePaths)
	if err != nil {
		return err
	}
	if e.Core.ExpectedFolder != "" {
		f, err := c.Folder(v.WorkspacePaths[0])
		if err != nil {
			return err
		}
		if !f.Bound || f.Scope() != e.Core.ExpectedFolder {
			return errors.New("workspace folder changed")
		}
	}
	if id != e.Project {
		return errors.New("workspace project changed")
	}
	if v.ProjectID != "" && strings.TrimPrefix(v.ProjectID, "project:") != e.Project {
		return errors.New("wrong project binding")
	}
	return nil
}
func canInject(h, event string) bool {
	if h == "codex" {
		return event == "SessionStart" || event == "UserPromptSubmit" || event == "PreToolUse" || event == "PostToolUse"
	}
	return h == "agy" && event == "PreInvocation"
}
func clipTail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	s = s[len(s)-n:]
	for !utf8.ValidString(s) && len(s) > 0 {
		s = s[1:]
	}
	return "[older observations omitted]\n" + s
}
func (e *Engine) Handle(ctx context.Context, v host.Event) (Response, error) {
	if err := e.validateEvent(v); err != nil {
		return Response{}, err
	}
	if v.EventID == "" {
		v.EventID = RandomID()
	}
	e.mu.Lock()
	if e.ctx.Err() != nil {
		e.mu.Unlock()
		return Response{}, e.ctx.Err()
	}
	s := e.sessions[v.ConversationID]
	if s == nil {
		s = &conversation{binding: recall.Binding{Host: e.Host, ConversationID: v.ConversationID, Cwd: v.WorkspacePaths[0]}}
		e.sessions[v.ConversationID] = s
	}
	e.latest = v.ConversationID
	isPrompt := v.Name == "UserPromptSubmit" || v.Name == "prompt.submit"
	if e.Host == "agy" && v.Name == "PreInvocation" && v.Query != "" && (v.Query != s.query || s.suspended) {
		isPrompt = true
	}
	if v.EventID == s.lastEvent {
		isPrompt = false
	}
	if !isPrompt && v.TurnID != "" && s.binding.TurnID != "" && e.Host != "agy" && v.TurnID != s.binding.TurnID {
		e.mu.Unlock()
		return Response{Status: "stale_turn"}, nil
	}
	if v.Cancel || v.EpochReset {
		binding := s.binding
		binding.EventID = v.EventID
		result, err := e.Core.Cancel(binding, v.EpochReset)
		if err != nil || result.Status == "duplicate_reset" || result.Status == "stale" {
			e.mu.Unlock()
			return result, err
		}
		stopJob(s)
		s.signature = ""
		s.pending = ""
		s.suspended = v.Cancel && !v.EpochReset
		if v.EpochReset {
			s.pending = "The main session was compacted. Recheck the latest observation before selecting any memory.\n"
		}
		e.mu.Unlock()
		return result, nil
	}
	if isPrompt {
		stopJob(s)
		s.query = v.Query
		s.binding.TurnID = v.TurnID
		s.signature = ""
		s.suspended = false
	}
	if s.suspended {
		e.mu.Unlock()
		return Response{Status: "cancelled"}, nil
	}
	if s.query == "" && v.Query != "" {
		s.query = v.Query
	}
	if v.EventID != s.lastEvent {
		s.lastEvent = v.EventID
		text := ""
		if isPrompt {
			text = "USER: " + v.Query + "\n"
		}
		if v.Context != "" {
			text += v.Name + ": " + v.Context + "\n"
		}
		if text != "" {
			s.history = clipTail(s.history+text, 24*1024)
			s.pending = clipTail(s.pending+text, 24*1024)
		}
	}
	if !canInject(e.Host, v.Name) {
		e.mu.Unlock()
		return Response{Status: "observed"}, nil
	}
	if e.Factory == nil {
		e.mu.Unlock()
		return Response{Status: "agent_unavailable"}, nil
	}
	if s.query == "" {
		e.mu.Unlock()
		return Response{Status: "no_query"}, nil
	}
	current := s.job
	if current == nil {
		sha := sha256.Sum256([]byte(s.query + "\x00" + s.history))
		signature := hex.EncodeToString(sha[:])
		if signature == s.signature {
			e.mu.Unlock()
			return Response{Status: "already_considered"}, nil
		}
		// A restarted native transport is explicitly seeded from bounded main history.
		observation := s.pending
		if s.session == nil {
			var err error
			s.session, err = e.Factory(v.ConversationID)
			if err != nil {
				e.mu.Unlock()
				return Response{Status: "agent_unavailable"}, err
			}
			observation = "This is a new Sniffer conversation. Bounded main-session history follows.\n" + s.history
		}
		binding := s.binding
		binding.EventID = v.EventID
		begin, err := e.Core.Begin(ctx, recall.BeginInput{Binding: binding, Query: s.query, Context: observation})
		if err != nil {
			e.mu.Unlock()
			return Response{}, err
		}
		binding.RequestID = begin.RequestID
		s.binding = binding
		var request native.Request
		if err = json.Unmarshal([]byte(begin.Prompt), &request); err != nil {
			e.mu.Unlock()
			return Response{}, err
		}
		jobCtx, cancel := context.WithTimeout(e.ctx, time.Duration(e.Limits.TimeoutSeconds)*time.Second)
		current = &job{done: make(chan struct{}), cancel: cancel, binding: binding, session: s.session}
		s.job = current
		s.signature = signature
		s.pending = ""
		e.wg.Add(1)
		go func(j *job, state *conversation) {
			defer e.wg.Done()
			defer close(j.done)
			defer j.cancel()
			j.decision, j.err = j.session.Run(jobCtx, request, func(ctx context.Context, name string, args json.RawMessage) (any, error) {
				return e.Core.Tool(ctx, j.binding, name, args)
			})
			if j.err == nil && jobCtx.Err() != nil {
				j.err = jobCtx.Err()
			}
			if j.err != nil {
				_ = j.session.Close()
				e.mu.Lock()
				if state.session == j.session {
					state.session = nil
				}
				e.mu.Unlock()
			}
		}(current, s)
	}
	e.mu.Unlock()
	timer := time.NewTimer(time.Duration(e.Limits.WaitMillis) * time.Millisecond)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return Response{}, ctx.Err()
	case <-e.ctx.Done():
		return Response{}, e.ctx.Err()
	case <-timer.C:
		return Response{Status: "pending", ConversationID: v.ConversationID}, nil
	case <-current.done:
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if s.job != current {
		return Response{Status: "stale"}, nil
	}
	s.job = nil
	if current.err != nil {
		return Response{Status: "agent_failed"}, nil
	}
	return e.Core.Complete(ctx, current.binding, current.decision)
}
func (e *Engine) Acknowledge(a Ack) error {
	e.mu.Lock()
	s := e.sessions[a.ConversationID]
	var b recall.Binding
	if s != nil {
		b = s.binding
	}
	e.mu.Unlock()
	if s == nil {
		return errors.New("unknown conversation")
	}
	return e.Core.Ack(b, a.DeliveryID, a.Epoch, a.Outcome)
}
func (e *Engine) Recall(ctx context.Context, r RecallRequest) (Response, error) {
	e.mu.Lock()
	if r.ConversationID == "" {
		r.ConversationID = e.latest
	}
	s := e.sessions[r.ConversationID]
	var b recall.Binding
	if s != nil {
		b = s.binding
	}
	e.mu.Unlock()
	if s == nil {
		return Response{}, errors.New("no active observed conversation")
	}
	b.EventID = r.EventID
	return e.Core.Manual(ctx, b, r.IDs, r.Force)
}
func Format(memories []model.Memory) string { return recall.Format(memories) }
