package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

func expandPath(base, path string) (string, error) {
	if path == "~" || strings.HasPrefix(path, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(home, strings.TrimPrefix(strings.TrimPrefix(path, "~"), "/")), nil
	}
	if filepath.IsAbs(path) {
		return filepath.Clean(path), nil
	}
	return filepath.Abs(filepath.Join(base, path))
}

func EinConfigPath() (string, error) {
	path := os.Getenv("EIN_CONFIG")
	if path == "" {
		path = "~/.config/ein/config.json"
	}
	return expandPath("", path)
}

func (c Config) EinProject(id string) bool { return c.einProjects[id] }

// Load overlays the current Ein registrations in memory. Update reads the
// local file separately so a removed Slack mapping never becomes a local alias.
func Load(p Paths) (Config, error) {
	c, err := loadLocal(p)
	if err != nil {
		return c, err
	}
	file, err := EinConfigPath()
	if err != nil {
		return c, err
	}
	data, err := os.ReadFile(file)
	if os.IsNotExist(err) {
		return c, nil
	}
	if err != nil {
		return c, err
	}
	var ein struct {
		Projects map[string]struct{ Path string } `json:"projects"`
	}
	if err := json.Unmarshal(data, &ein); err != nil {
		return c, fmt.Errorf("invalid Ein project configuration: %w", err)
	}
	ids := make([]string, 0, len(ein.Projects))
	for id := range ein.Projects {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	c.einProjects = make(map[string]bool, len(ids))
	for _, id := range ids {
		path := ein.Projects[id].Path
		if !ValidID(id) || id[0] < 'a' || id[0] > 'z' || id == "constructor" || path == "" {
			return c, fmt.Errorf("invalid Ein project %q", id)
		}
		path, err = expandPath(filepath.Dir(file), path)
		if err != nil {
			return c, err
		}
		root, err := CanonicalDir(path)
		if os.IsNotExist(err) {
			continue // An offline checkout cannot identify the current workspace.
		}
		if err != nil {
			return c, fmt.Errorf("Ein project %q: %w", id, err)
		}
		if Within(p.Home, root) || Within(root, p.Home) {
			return c, fmt.Errorf("Ein project %q overlaps Sniffer home", id)
		}
		index := slices.IndexFunc(c.Projects, func(project Project) bool { return project.ID == id })
		if index < 0 {
			c.Projects = append(c.Projects, Project{ID: id, Roots: []string{root}})
		} else if !slices.Contains(c.Projects[index].Roots, root) {
			c.Projects[index].Roots = append(c.Projects[index].Roots, root)
		}
		c.einProjects[id] = true
	}
	return c, Validate(c)
}
