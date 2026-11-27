package config

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
)

type FolderRegistration struct {
	Root       string `json:"root"`
	Standalone bool   `json:"standalone,omitempty"`
}

// Folder identifies the nearest registered root; an unregistered directory
// has a prospective identity that inspect can report without writing files.
type Folder struct {
	Root    string
	Project string
	Bound   bool
}

func (f Folder) ID() string {
	sum := sha256.Sum256([]byte(f.Root))
	return hex.EncodeToString(sum[:16])
}

func (f Folder) Scope() string { return "folder:" + f.ID() }

func (f Folder) BindingID() (string, error) {
	if f.Project != "" {
		return f.Project, nil
	}
	if f.Bound {
		return f.Scope(), nil
	}
	return "", fmt.Errorf("unregistered working directory %q; use folder bind or project add", f.Root)
}

func (c Config) Folder(path string) (Folder, error) {
	path, err := CanonicalDir(path)
	if err != nil {
		return Folder{}, err
	}
	var f Folder
	for _, p := range c.Projects {
		for _, root := range p.Roots {
			if len(root) > len(f.Root) && Within(root, path) {
				f.Root, f.Project = root, p.ID
			}
		}
	}
	var closest FolderRegistration
	for _, folder := range c.Folders {
		if len(folder.Root) > len(closest.Root) && Within(folder.Root, path) {
			closest = folder
		}
	}
	if closest.Root != "" && len(closest.Root) >= len(f.Root) {
		f.Root, f.Bound = closest.Root, true
		if closest.Standalone {
			f.Project = ""
		}
	}
	if f.Root == "" {
		f.Root = path
	}
	return f, nil
}
