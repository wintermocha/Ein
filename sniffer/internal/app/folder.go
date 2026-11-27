package app

import (
	"context"
	"errors"
	"os"
	"slices"
	"strings"

	"ein.local/sniffer/internal/config"
	"ein.local/sniffer/internal/model"
)

type folderInfo struct {
	Bound     bool     `json:"bound"`
	Root      string   `json:"root"`
	FolderID  string   `json:"folderId"`
	ProjectID string   `json:"projectId"`
	Groups    []string `json:"groups"`
	Projects  []string `json:"projects"`
}

type folderRequest struct {
	path, project, group string
	exact                bool
}

func (a app) folder(args []string) error {
	if len(args) == 0 || (args[0] != "bind" && args[0] != "inspect") {
		return errors.New("usage: folder inspect|bind --path DIRECTORY [--exact] [--project ID [--group ID]]")
	}
	flags := a.flags("folder " + args[0])
	var req folderRequest
	flags.BoolVar(&req.exact, "exact", false, "select this exact folder as the private root")
	flags.StringVar(&req.path, "path", "", "workspace directory")
	flags.StringVar(&req.project, "project", "", "logical project ID")
	flags.StringVar(&req.group, "group", "", "project's parent group")
	if err := parse(flags, args[1:]); err != nil {
		return err
	}
	if err := required("--path", req.path); err != nil {
		return err
	}
	if req.project != "" && !config.ValidID(req.project) {
		return errors.New("invalid project ID")
	}
	if req.group != "" && (!config.ValidID(req.group) || req.project == "") {
		return errors.New("--group needs a valid group ID and --project")
	}
	if args[0] == "inspect" {
		info, err := a.planFolder(req, nil)
		if err != nil {
			return err
		}
		return a.json(info)
	}
	var info folderInfo
	err := config.Update(a.paths, func(local *config.Config) error {
		result, err := a.planFolder(req, local)
		info = result
		return err
	})
	if err != nil {
		return err
	}
	return a.json(info)
}

// During binding, plan and persist the same hierarchy used by read-only preview
// while holding the machine registration lock.
func (a app) planFolder(req folderRequest, local *config.Config) (folderInfo, error) {
	var info folderInfo
	c, err := config.Load(a.paths)
	if err != nil {
		return info, err
	}
	f, err := c.Folder(req.path)
	if err != nil {
		return info, err
	}
	if req.exact {
		root, err := config.CanonicalDir(req.path)
		if err != nil {
			return info, err
		}
		if f.Root != root {
			f.Root, f.Bound = root, false
		}
	}
	if config.Within(a.paths.Home, f.Root) || config.Within(f.Root, a.paths.Home) {
		return info, errors.New("folder overlaps Sniffer home")
	}
	if os.Getenv(expectedProjectEnv) != "" {
		if _, err = a.bindProject("", req.path, false); err != nil {
			return info, err
		}
		if req.project != "" && req.project != f.Project {
			return info, errors.New("cannot reassign a dispatched folder")
		}
	}
	if req.project != "" && f.Project == "" {
		for _, p := range c.Projects {
			if p.ID != req.project && slices.Contains(p.Roots, f.Root) {
				return info, errors.New("folder already registered to another project")
			}
		}
	}
	if req.project != "" && f.Project != "" && req.project != f.Project {
		return info, errors.New("folder already belongs to another project")
	}
	info = folderInfo{Bound: f.Bound, Root: f.Root, FolderID: f.ID(), ProjectID: f.Project, Groups: []string{}, Projects: []string{}}
	if req.project != "" {
		info.ProjectID = req.project
	}
	for _, p := range c.Projects {
		info.Projects = append(info.Projects, p.ID)
	}
	ctx := context.Background()
	st := a.st()
	snap := model.Snapshot{Registry: model.Registry{SchemaVersion: 1, Scopes: []model.Scope{{ID: "global", Kind: "global"}}}}
	if _, err = os.Stat(a.paths.Store); err == nil {
		snap, err = st.Snapshot(ctx)
		if err != nil {
			return info, err
		}
	} else if !os.IsNotExist(err) {
		return info, err
	}
	for _, scope := range snap.Registry.Scopes {
		id := strings.TrimPrefix(scope.ID, "project:")
		if scope.Kind == "project" && !slices.Contains(info.Projects, id) {
			info.Projects = append(info.Projects, id)
		}
	}
	slices.Sort(info.Projects)
	registry, err := info.planRegistry(snap.Registry, req.group)
	if err != nil || local == nil {
		return info, err
	}
	if snap.Commit == "" {
		if err = st.Init(ctx); err != nil {
			return info, err
		}
		snap, err = st.Snapshot(ctx)
		if err != nil {
			return info, err
		}
		registry, err = info.planRegistry(snap.Registry, req.group)
		if err != nil {
			return info, err
		}
	}
	if !slices.Equal(registry.Scopes, snap.Registry.Scopes) {
		if err = st.BindFolder(ctx, snap.Commit, registry); err != nil {
			return info, err
		}
	}
	if req.project != "" && f.Project == "" {
		i := slices.IndexFunc(local.Projects, func(p config.Project) bool { return p.ID == req.project })
		if i >= 0 {
			if !slices.Contains(local.Projects[i].Roots, f.Root) {
				local.Projects[i].Roots = append(local.Projects[i].Roots, f.Root)
			}
		} else {
			local.Projects = append(local.Projects, config.Project{ID: req.project, Roots: []string{f.Root}})
		}
	}
	registration := config.FolderRegistration{Root: f.Root, Standalone: info.ProjectID == ""}
	if idx := slices.IndexFunc(local.Folders, func(r config.FolderRegistration) bool { return r.Root == f.Root }); idx >= 0 {
		local.Folders[idx] = registration
	} else {
		local.Folders = append(local.Folders, registration)
	}
	info.Bound = true
	if info.ProjectID != "" && !slices.Contains(info.Projects, info.ProjectID) {
		info.Projects = append(info.Projects, info.ProjectID)
		slices.Sort(info.Projects)
	}
	return info, nil
}

func (i *folderInfo) planRegistry(reg model.Registry, group string) (model.Registry, error) {
	reg.Scopes = slices.Clone(reg.Scopes)
	find := func(id string) int {
		return slices.IndexFunc(reg.Scopes, func(s model.Scope) bool { return s.ID == id })
	}
	parent := "global"
	if i.ProjectID != "" {
		project := "project:" + i.ProjectID
		if find(project) < 0 {
			if group != "" {
				if slices.Contains(i.Projects, i.ProjectID) {
					return reg, errors.New("existing project does not belong to that group")
				}
				parent = "group:" + group
				if find(parent) < 0 {
					reg.Scopes = append(reg.Scopes, model.Scope{ID: parent, Kind: "group", Parent: "global"})
				}
			}
			reg.Scopes = append(reg.Scopes, model.Scope{ID: project, Kind: "project", Parent: parent})
		}
		chain, err := model.Ancestors(reg, project)
		if err != nil {
			return reg, err
		}
		i.Groups = []string{}
		for _, scope := range chain {
			if id, ok := strings.CutPrefix(scope, "group:"); ok {
				i.Groups = append(i.Groups, id)
			}
		}
		if group != "" && !slices.Contains(i.Groups, group) {
			return reg, errors.New("existing project does not belong to that group")
		}
		parent = project
	}
	scope := model.Scope{ID: "folder:" + i.FolderID, Kind: "folder", Parent: parent}
	if idx := find(scope.ID); idx >= 0 {
		reg.Scopes[idx] = scope
	} else {
		reg.Scopes = append(reg.Scopes, scope)
	}
	return reg, model.ValidateRegistry(reg)
}
