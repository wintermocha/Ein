package app

import (
	"context"
	"errors"
	"os"
	"strings"

	"ein.local/sniffer/internal/config"
	"ein.local/sniffer/internal/model"
)

const expectedProjectEnv = "EIN_SNIFFER_EXPECT_PROJECT"
const expectedFolderEnv = "EIN_SNIFFER_EXPECT_FOLDER"

type projectBinding struct {
	id         string
	workspace  string
	processDir string
	folder     string
}

func validBindingID(id string) bool {
	return config.ValidID(strings.TrimPrefix(id, "folder:"))
}

func (a app) bindProject(explicit, workspace string, privateRuntime bool) (projectBinding, error) {
	b := projectBinding{id: strings.TrimPrefix(explicit, "project:"), workspace: workspace, folder: os.Getenv(expectedFolderEnv)}
	if explicit != "" && !validBindingID(b.id) {
		return b, errors.New("invalid explicit project ID")
	}
	expected := os.Getenv(expectedProjectEnv)
	if expected != "" {
		if !validBindingID(expected) || (b.id != "" && b.id != expected) {
			return b, errors.New("project differs from the dispatched project")
		}
		b.id = expected
	}
	cwd, err := os.Getwd()
	if err != nil {
		return b, err
	}
	if expected != "" && !privateRuntime {
		b.processDir = cwd
	}
	if b.workspace == "" && (explicit == "" || expected != "" || strings.HasPrefix(b.id, "folder:")) {
		b.workspace = cwd
	}
	c, err := config.Load(a.paths)
	if err != nil {
		return b, err
	}
	// An explicit logical project carries private access only if the process
	// is actually running inside a bound folder of that same project.
	if b.workspace == "" && !privateRuntime {
		caller, err := c.Folder(cwd)
		if err != nil {
			return b, err
		}
		if caller.Bound && caller.Project == b.id {
			b.workspace = cwd
		}
	}
	if workspace != "" && !privateRuntime && b.processDir == "" {
		caller, err := c.Folder(cwd)
		if err != nil {
			return b, err
		}
		target, err := c.Folder(workspace)
		if err != nil {
			return b, err
		}
		if caller.Bound || target.Bound {
			b.processDir = cwd
		}
	}
	b.id, err = b.resolve(c)
	if err == nil && b.workspace != "" {
		f, e := c.Folder(b.workspace)
		if e != nil {
			return b, e
		}
		if f.Bound {
			if privateRuntime && b.folder == "" {
				return b, errors.New("native memory reader has no assigned folder")
			}
			b.folder = f.Scope()
		}
	}
	return b, err
}

func (b projectBinding) resolve(c config.Config) (string, error) {
	id := b.id
	root := ""
	for _, path := range []string{b.processDir, b.workspace} {
		if path == "" {
			continue
		}
		f, err := c.Folder(path)
		if err != nil {
			return "", err
		}
		actual, err := f.BindingID()
		if err != nil {
			return "", err
		}
		if id != "" && id != actual {
			return "", errors.New("workspace project changed")
		}
		if (root != "" && root != f.Root) || (b.folder != "" && (!f.Bound || b.folder != f.Scope())) {
			return "", errors.New("workspace folder changed")
		}
		id, root = actual, f.Root
	}
	if root != "" {
		return id, nil
	}
	return c.Resolve("", id)
}

func (a app) projectSnapshot(ctx context.Context, b projectBinding) (model.Snapshot, error) {
	c, err := config.Load(a.paths)
	if err != nil {
		return model.Snapshot{}, err
	}
	if _, err := b.resolve(c); err != nil {
		return model.Snapshot{}, err
	}
	var snap model.Snapshot
	if c.EinProject(b.id) && os.Getenv("EIN_SNIFFER_ROLE") != "memory-agent" {
		snap, err = a.st().EinProjectSnapshot(ctx, b.id)
	} else {
		snap, err = a.st().Snapshot(ctx)
	}
	if err != nil {
		return snap, err
	}
	snap.FolderScope = b.folder
	// Refuse stale local mappings if the store and machine registration diverge.
	if b.folder != "" {
		_, err = snap.AccessChain(b.id)
	}
	return snap, err
}

func (b projectBinding) saveScope(scope string) string {
	if scope == "folder:current" && b.folder != "" {
		return b.folder
	}
	return scope
}
