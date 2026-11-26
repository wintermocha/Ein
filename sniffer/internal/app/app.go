package app

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"ein.local/sniffer/internal/config"
	"ein.local/sniffer/internal/host"
	"ein.local/sniffer/internal/model"
	"ein.local/sniffer/internal/search"
	"ein.local/sniffer/internal/store"
	"ein.local/sniffer/internal/worker"
)

const Version = "0.4.0"

type app struct {
	paths    config.Paths
	in       io.Reader
	out, err io.Writer
}

func Run(args []string, in io.Reader, out, errout io.Writer) error {
	f := flag.NewFlagSet("sniffer", flag.ContinueOnError)
	f.SetOutput(errout)
	home := f.String("home", "", "Sniffer home (default ~/.ein)")
	if err := f.Parse(args); err != nil {
		return err
	}
	args = f.Args()
	p, err := config.Locate(*home)
	if err != nil {
		return err
	}
	a := app{p, in, out, errout}
	if len(args) == 0 {
		return a.help()
	}
	if os.Getenv("EIN_SNIFFER_ROLE") == "memory-agent" {
		switch args[0] {
		case "hook":
			_, err = io.WriteString(out, "{}\n")
			return err
		case "version", "help", "agent-guard", "mcp":
		default:
			return errors.New("read-only memory-agent role cannot invoke this Sniffer command")
		}
	}
	switch args[0] {
	case "help", "-h", "--help":
		return a.help()
	case "version":
		return a.json(map[string]string{"version": Version})
	case "memory":
		return a.memory(args[1:])
	case "project":
		return a.project(args[1:])
	case "install-hooks":
		if len(args) != 1 {
			return errors.New("usage: sniffer install-hooks")
		}
		return a.installHooks()
	case "group":
		return a.group(args[1:])
	case "run":
		return a.launch(args[1:])
	case "worker":
		return a.serve(args[1:])
	case "hook":
		return a.hook(args[1:])
	case "doctor":
		return a.doctor(args[1:])
	case "mcp":
		return a.mcp(args[1:])
	case "bridge":
		return a.bridge(args[1:])
	case "agent-guard":
		return a.agentGuard(args[1:])
	default:
		return fmt.Errorf("unknown command %q; see sniffer help", args[0])
	}
}
func (a app) help() error {
	_, err := fmt.Fprint(a.out, `Ein / Sniffer 0.4.0 — shared Go memory engine, product-native recall agents

Usage: sniffer [--home DIRECTORY] COMMAND

  memory init
  group add --id work --parent global
  project add --id app --path /absolute/project --parent group:work
  project list
  memory search --query "검색어" [--project app] [--limit 20]
  memory list [--scope global] [--project app]
  memory read --id MEMORY_ID [--format json|markdown] [--project app]
  memory save --input memory.md --if-revision new|BLOB --request-id ID [--project app]
  memory promote --id ID --to group:work --if-revision BLOB --request-id ID --dry-run|--apply
  memory recover --request-id ID
  memory recall --id ID [--force]     (inside a sniffer run session)
  doctor --host claude|codex|agy [--executable PATH]
  install-hooks                     (merge Codex and agy user hooks for native recall)
  run claude|codex|agy [-- NATIVE_ARGUMENTS]
  hook claude|codex|agy [--event NAME] (adapter only)
  bridge begin|tool|complete|ack|cancel|reset|write (Claude mod JSON bridge)
  mcp --role reader|writer --project app (main-session explicit tools)

Default memory Git repository: ~/.ein/memory/store/
Search/read are local and read-only. Save/promote are separate explicit writes.
See sniffer/README.md for installation and sniffer/docs/INTEGRATIONS.md for native clients.
`)
	return err
}
func (a app) flags(name string) *flag.FlagSet {
	f := flag.NewFlagSet(name, flag.ContinueOnError)
	f.SetOutput(a.err)
	return f
}
func (a app) json(v any) error {
	enc := json.NewEncoder(a.out)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}
func (a app) st() *store.Store { return store.New(a.paths.Store, a.paths.State) }
func parse(f *flag.FlagSet, args []string) error {
	if err := f.Parse(args); err != nil {
		return err
	}
	if len(f.Args()) != 0 {
		return fmt.Errorf("unexpected arguments: %q", f.Args())
	}
	return nil
}
func required(pairs ...string) error {
	for i := 0; i < len(pairs); i += 2 {
		if pairs[i+1] == "" {
			return fmt.Errorf("%s is required", pairs[i])
		}
	}
	return nil
}
func requestID(id string) string {
	if id != "" {
		return id
	}
	return worker.RandomID()
}
func (a app) memory(args []string) error {
	if len(args) == 0 {
		return errors.New("memory subcommand is required")
	}
	ctx := context.Background()
	s := a.st()
	switch args[0] {
	case "init":
		f := a.flags("memory init")
		if err := parse(f, args[1:]); err != nil {
			return err
		}
		if err := s.Init(ctx); err != nil {
			return err
		}
		if err := config.Update(a.paths, func(*config.Config) error { return nil }); err != nil {
			return err
		}
		return a.json(map[string]string{"store": a.paths.Store, "status": "initialized"})
	case "search", "list", "read":
		f := a.flags("memory " + args[0])
		project := f.String("project", "", "registered project ID")
		query := f.String("query", "", "search query")
		limit := f.Int("limit", 20, "maximum hits")
		scope := f.String("scope", "", "scope filter")
		id := f.String("id", "", "memory ID")
		format := f.String("format", "json", "json or markdown")
		if err := parse(f, args[1:]); err != nil {
			return err
		}
		binding, err := a.bindProject(*project, "", false)
		if err != nil {
			return err
		}
		pid := binding.id
		snap, err := a.projectSnapshot(ctx, binding)
		if err != nil {
			return err
		}
		switch args[0] {
		case "search":
			if err = required("--query", *query); err != nil {
				return err
			}
			hits, err := search.Find(snap, pid, *query, *limit)
			if err != nil {
				return err
			}
			return a.json(map[string]any{"snapshot": snap.Commit, "project_id": pid, "hits": hits})
		case "list":
			items, err := search.List(snap, pid, *scope)
			if err != nil {
				return err
			}
			return a.json(map[string]any{"snapshot": snap.Commit, "project_id": pid, "memories": items})
		case "read":
			if err = required("--id", *id); err != nil {
				return err
			}
			m, err := search.Read(snap, pid, *id)
			if err != nil {
				return err
			}
			if *format == "markdown" {
				b, err := store.Render(m)
				if err != nil {
					return err
				}
				_, err = a.out.Write(b)
				return err
			}
			if *format != "json" {
				return errors.New("--format must be json or markdown")
			}
			return a.json(m)
		}
	case "save":
		f := a.flags("memory save")
		project := f.String("project", "", "registered project ID")
		input := f.String("input", "", "Markdown file or - for stdin")
		revision := f.String("if-revision", "", "new or exact blob revision")
		req := f.String("request-id", "", "idempotency ID")
		if err := parse(f, args[1:]); err != nil {
			return err
		}
		if err := required("--input", *input, "--if-revision", *revision, "--request-id", *req); err != nil {
			return err
		}
		binding, err := a.bindProject(*project, "", false)
		if err != nil {
			return err
		}
		b, err := a.readInput(*input, 128*1024)
		if err != nil {
			return err
		}
		m, err := store.Parse(b)
		if err != nil {
			return err
		}
		pid := binding.id
		snap, err := a.projectSnapshot(ctx, binding)
		if err != nil {
			return err
		}
		if err = allowedScope(snap, pid, m.ScopeID); err != nil {
			return err
		}
		result, err := s.Save(ctx, m, *revision, *req)
		if err != nil {
			return err
		}
		return a.json(result)
	case "promote":
		f := a.flags("memory promote")
		project := f.String("project", "", "registered project ID")
		id := f.String("id", "", "memory ID")
		target := f.String("to", "", "ancestor scope")
		revision := f.String("if-revision", "", "exact blob revision")
		req := f.String("request-id", "", "idempotency ID")
		preview := f.Bool("dry-run", false, "preview only")
		apply := f.Bool("apply", false, "commit changes")
		partialFile := f.String("partial", "", "partial promotion JSON")
		if err := parse(f, args[1:]); err != nil {
			return err
		}
		if err := required("--id", *id, "--to", *target, "--if-revision", *revision, "--request-id", *req); err != nil {
			return err
		}
		if *preview == *apply {
			return errors.New("choose exactly one of --dry-run or --apply")
		}
		binding, err := a.bindProject(*project, "", false)
		if err != nil {
			return err
		}
		var part *store.Partial
		if *partialFile != "" {
			part = &store.Partial{}
			b, err := a.readInput(*partialFile, 128*1024)
			if err != nil {
				return err
			}
			if err = decodeStrict(b, part); err != nil {
				return err
			}
		}
		pid := binding.id
		snap, err := a.projectSnapshot(ctx, binding)
		if err != nil {
			return err
		}
		if _, err = search.Read(snap, pid, *id); err != nil {
			return err
		}
		if err = allowedScope(snap, pid, *target); err != nil {
			return err
		}
		result, err := s.Promote(ctx, *id, *target, *revision, *req, part, *preview)
		if err != nil {
			return err
		}
		return a.json(result)
	case "recover":
		f := a.flags("memory recover")
		req := f.String("request-id", "", "transaction ID")
		if err := parse(f, args[1:]); err != nil {
			return err
		}
		if err := required("--request-id", *req); err != nil {
			return err
		}
		result, err := s.Recover(ctx, *req)
		if err != nil {
			return err
		}
		return a.json(result)
	case "recall":
		return a.recall(args[1:])
	}
	return fmt.Errorf("unknown memory command %q", args[0])
}
func allowedScope(s model.Snapshot, pid, scope string) error {
	anc, err := model.Ancestors(s.Registry, "project:"+pid)
	if err != nil {
		return err
	}
	for _, x := range anc {
		if x == scope {
			return nil
		}
	}
	return errors.New("target scope is outside the selected project's ancestry")
}
func (a app) readInput(path string, max int64) ([]byte, error) {
	var r io.Reader = a.in
	var f *os.File
	if path != "-" {
		var err error
		f, err = os.Open(path)
		if err != nil {
			return nil, err
		}
		defer f.Close()
		r = f
	}
	b, err := io.ReadAll(io.LimitReader(r, max+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > max {
		return nil, errors.New("input exceeds size limit")
	}
	return b, nil
}
func decodeStrict(b []byte, v any) error {
	d := json.NewDecoder(strings.NewReader(string(b)))
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		return err
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		return errors.New("trailing JSON data")
	}
	return nil
}

func (a app) group(args []string) error {
	if len(args) == 0 || args[0] != "add" {
		return errors.New("usage: group add --id ID --parent SCOPE")
	}
	f := a.flags("group add")
	id := f.String("id", "", "group slug")
	parent := f.String("parent", "global", "parent scope")
	req := f.String("request-id", "", "optional idempotency ID")
	if err := parse(f, args[1:]); err != nil {
		return err
	}
	bare := strings.TrimPrefix(*id, "group:")
	if !config.ValidID(bare) {
		return errors.New("invalid group ID")
	}
	res, err := a.st().AddScope(context.Background(), model.Scope{ID: "group:" + bare, Kind: "group", Parent: *parent}, requestID(*req))
	if err != nil {
		return err
	}
	return a.json(res)
}
func (a app) project(args []string) error {
	if len(args) == 0 {
		return errors.New("project subcommand required")
	}
	if args[0] == "list" {
		f := a.flags("project list")
		if err := parse(f, args[1:]); err != nil {
			return err
		}
		c, err := config.Load(a.paths)
		if err != nil {
			return err
		}
		return a.json(c.Projects)
	}
	if args[0] != "add" {
		return errors.New("usage: project add|list")
	}
	f := a.flags("project add")
	id := f.String("id", "", "project slug")
	path := f.String("path", "", "existing project directory")
	parent := f.String("parent", "global", "group or global scope")
	req := f.String("request-id", "", "optional idempotency ID")
	if err := parse(f, args[1:]); err != nil {
		return err
	}
	bare := strings.TrimPrefix(*id, "project:")
	if !config.ValidID(bare) {
		return errors.New("invalid project ID")
	}
	if err := required("--path", *path); err != nil {
		return err
	}
	root, err := config.CanonicalDir(*path)
	if err != nil {
		return err
	}
	if config.Within(a.paths.Home, root) || config.Within(root, a.paths.Home) {
		return errors.New("project root must not overlap Sniffer's own home directory")
	}
	change := func(c *config.Config) error {
		for i, p := range c.Projects {
			for _, r := range p.Roots {
				if r == root {
					if p.ID == bare {
						return nil
					}
					return fmt.Errorf("root already belongs to %s", p.ID)
				}
			}
			if p.ID == bare {
				c.Projects[i].Roots = append(c.Projects[i].Roots, root)
				return nil
			}
		}
		c.Projects = append(c.Projects, config.Project{ID: bare, Roots: []string{root}})
		return nil
	}
	c, err := config.Load(a.paths)
	if err != nil {
		return err
	}
	if err = change(&c); err != nil {
		return err
	}
	if err = config.Validate(c); err != nil {
		return err
	}
	snap, err := a.st().Snapshot(context.Background())
	if err != nil {
		return err
	}
	exists := false
	for _, scope := range snap.Registry.Scopes {
		if scope.ID == "project:"+bare {
			if scope.Parent != *parent {
				return errors.New("registered project has a different parent; hierarchy changes are explicit store operations")
			}
			exists = true
		}
	}
	if !exists {
		if _, err = a.st().AddScope(context.Background(), model.Scope{ID: "project:" + bare, Kind: "project", Parent: *parent}, requestID(*req)); err != nil {
			return err
		}
	}
	if err = config.Update(a.paths, change); err != nil {
		return err
	}
	return a.json(map[string]string{"project_id": bare, "root": root, "parent": *parent})
}

func (a app) hook(args []string) error {
	// Launcher-only activation also applies when the hook is installed globally.
	if os.Getenv("EIN_SNIFFER_RUN_ID") == "" || os.Getenv("EIN_SNIFFER_ROLE") == "memory-agent" {
		_, err := io.WriteString(a.out, "{}\n")
		return err
	}
	if len(args) == 0 {
		return errors.New("hook host required")
	}
	h, err := host.Canonical(args[0])
	if err != nil {
		return err
	}
	f := a.flags("hook")
	name := f.String("event", "", "known event name")
	if err = parse(f, args[1:]); err != nil {
		return err
	}
	// Hooks fail open for the main task: diagnostics never echo prompts or memory.
	fail := func(reason string) error {
		fmt.Fprintln(a.err, "sniffer hook:", reason)
		_, e := io.WriteString(a.out, "{}\n")
		return e
	}
	raw, err := io.ReadAll(io.LimitReader(a.in, host.MaxEventBytes+1))
	if err != nil {
		return fail("cannot read host event")
	}
	if *name != "" {
		raw, err = host.WithEventName(raw, *name)
		if err != nil {
			return fail("invalid host event")
		}
	}
	event, err := host.Decode(h, raw)
	if err != nil {
		return fail("unsupported or invalid host event")
	}
	if event.EventID == "" {
		event.EventID = worker.RandomID()
	}
	client, err := worker.ClientFromEnv()
	if err != nil {
		return fail("worker unavailable")
	}
	var response worker.Response
	if err = client.Post(context.Background(), "/v1/event", event, &response); err != nil {
		return fail("recall unavailable")
	}
	b, err := host.Encode(h, event.Name, response.Context)
	if err != nil {
		return fail("invalid adapter output")
	}
	_, writeErr := a.out.Write(b)
	if response.DeliveryID != "" {
		outcome := "emitted"
		if writeErr != nil {
			outcome = "uncertain"
		}
		var ignored any
		_ = client.Post(context.Background(), "/v1/ack", worker.Ack{ConversationID: response.ConversationID, Epoch: response.Epoch, DeliveryID: response.DeliveryID, Outcome: outcome}, &ignored)
	}
	return writeErr
}
func (a app) recall(args []string) error {
	f := a.flags("memory recall")
	id := f.String("id", "", "memory ID")
	force := f.Bool("force", false, "explicitly repeat a previously delivered memory")
	conversation := f.String("conversation", "", "active conversation ID (default latest)")
	if err := parse(f, args); err != nil {
		return err
	}
	if err := required("--id", *id); err != nil {
		return err
	}
	if os.Getenv(expectedProjectEnv) != "" {
		if _, err := a.bindProject("", "", false); err != nil {
			return err
		}
	}
	c, err := worker.ClientFromEnv()
	if err != nil {
		return err
	}
	var r worker.Response
	if err = c.Post(context.Background(), "/v1/recall", worker.RecallRequest{ConversationID: *conversation, IDs: []string{*id}, Force: *force, EventID: worker.RandomID()}, &r); err != nil {
		return err
	}
	writeErr := a.json(r)
	if r.DeliveryID != "" {
		outcome := "emitted"
		if writeErr != nil {
			outcome = "uncertain"
		}
		var ignored any
		_ = c.Post(context.Background(), "/v1/ack", worker.Ack{ConversationID: r.ConversationID, Epoch: r.Epoch, DeliveryID: r.DeliveryID, Outcome: outcome}, &ignored)
	}
	return writeErr
}
