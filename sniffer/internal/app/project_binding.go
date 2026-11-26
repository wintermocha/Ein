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

type projectBinding struct {
	id         string
	workspace  string
	processDir string
}

// Explicit standalone selection only needs an ID. Slack and native sessions
// also keep their workspace so a later config edit cannot silently switch scopes.
func (a app) bindProject(explicit, workspace string, privateRuntime bool) (projectBinding, error) {
	b := projectBinding{id: strings.TrimPrefix(explicit, "project:"), workspace: workspace}
	if explicit != "" && !config.ValidID(b.id) {
		return b, errors.New("invalid explicit project ID")
	}
	expected := os.Getenv(expectedProjectEnv)
	if expected != "" {
		if !config.ValidID(expected) || (b.id != "" && b.id != expected) {
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
	if b.workspace == "" && (explicit == "" || (privateRuntime && expected != "")) {
		b.workspace = cwd
	}
	c, err := config.Load(a.paths)
	if err == nil {
		b.id, err = b.resolve(c)
	}
	return b, err
}

func (b projectBinding) resolve(c config.Config) (string, error) {
	id := b.id
	for _, path := range []string{b.processDir, b.workspace} {
		if path == "" {
			continue
		}
		actual, err := c.Resolve(path, "")
		if err != nil {
			return "", err
		}
		if id != "" && id != actual {
			return "", errors.New("workspace project changed")
		}
		id = actual
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
	if c.EinProject(b.id) && os.Getenv("EIN_SNIFFER_ROLE") != "memory-agent" {
		return a.st().EinProjectSnapshot(ctx, b.id)
	}
	return a.st().Snapshot(ctx)
}
