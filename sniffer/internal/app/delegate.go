package app

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"syscall"

	"ein.local/sniffer/internal/config"
)

const delegationEnv = "EIN_SNIFFER_DELEGATION"

type delegatedProject struct {
	ProjectID string            `json:"projectId"`
	Directory string            `json:"workingDirectory"`
	Env       map[string]string `json:"env"`
}

func (a app) delegate(args []string) error {
	var command []string
	if separator := slices.Index(args, "--"); separator >= 0 {
		command, args = args[separator+1:], args[:separator]
		if len(command) == 0 || command[0] == "" {
			return errors.New("delegate requires a command after --")
		}
	}
	f := a.flags("delegate")
	var cwd, project string
	f.Func("cwd", "child working directory", func(value string) error {
		if value == "" {
			return errors.New("directory cannot be empty")
		}
		cwd = value
		return nil
	})
	f.Func("project", "explicitly assigned project ID", func(value string) error {
		if !config.ValidID(value) {
			return errors.New("invalid project ID")
		}
		project = value
		return nil
	})
	if err := parse(f, args); err != nil {
		return err
	}
	b, err := a.resolveDelegation(project, cwd)
	if err != nil {
		return err
	}
	if command == nil {
		return a.json(b)
	}
	return b.exec(command)
}

func (a app) resolveDelegation(project, directory string) (delegatedProject, error) {
	var b delegatedProject
	c, err := config.Load(a.paths)
	if err != nil {
		return b, err
	}
	parentDir, err := config.CanonicalDir(".")
	if err != nil {
		return b, err
	}
	parent, err := (projectBinding{id: os.Getenv(expectedProjectEnv), workspace: parentDir, folder: os.Getenv(expectedFolderEnv)}).resolve(c)
	if err != nil {
		return b, fmt.Errorf("delegating parent: %w", err)
	}
	if project == "" {
		project = parent
	}
	if project != parent {
		if os.Getenv(delegationEnv) == "assigned" {
			return b, errors.New("the assigned parent cannot delegate to another project")
		}
		if directory == "" {
			i := slices.IndexFunc(c.Projects, func(p config.Project) bool { return p.ID == project })
			if i < 0 {
				return b, fmt.Errorf("unregistered project %q", project)
			}
			roots := c.Projects[i].Roots
			if len(roots) != 1 {
				return b, fmt.Errorf("project %q has multiple roots; specify --cwd", project)
			}
			directory = roots[0]
		}
	}
	if directory == "" {
		directory = parentDir
	} else if !filepath.IsAbs(directory) {
		directory = parentDir + string(os.PathSeparator) + directory
	}
	// Preserve the filesystem meaning of symlink/.. before CanonicalDir cleans the path.
	directory, err = filepath.EvalSymlinks(directory)
	if err != nil {
		return b, err
	}
	b.Directory, err = config.CanonicalDir(directory)
	if err != nil {
		return b, err
	}
	actual, err := c.Resolve(b.Directory, "")
	if err != nil {
		return b, err
	}
	if actual != project {
		return b, fmt.Errorf("child working directory belongs to project %q, expected %q", actual, project)
	}
	configPath, err := config.EinConfigPath()
	if err != nil {
		return b, err
	}
	b.ProjectID = project
	b.Env = map[string]string{"EIN_CONFIG": configPath, "EIN_HOME": a.paths.Home, expectedProjectEnv: project}
	f, err := c.Folder(b.Directory)
	if err != nil {
		return b, err
	}
	if f.Bound {
		b.Env[expectedFolderEnv] = f.Scope()
	}
	if lock := os.Getenv(expectedFolderEnv); os.Getenv(delegationEnv) == "assigned" && lock != "" && lock != b.Env[expectedFolderEnv] {
		return b, errors.New("assigned parent cannot delegate to a different folder")
	}
	if policy := os.Getenv(delegationEnv); policy != "" {
		b.Env[delegationEnv] = policy
	}
	return b, nil
}

func (b delegatedProject) exec(command []string) error {
	env := make([]string, 0, len(os.Environ()))
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if strings.HasPrefix(key, "EIN_SNIFFER_") {
			continue
		}
		switch key {
		case "PWD", "EIN_HOME", "EIN_CONFIG", "EIN_APP_TOKEN", "EIN_BOT_TOKEN", "HOGU_APP_TOKEN", "HOGU_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_BOT_TOKEN":
			continue
		}
		env = append(env, entry)
	}
	for key, value := range b.Env {
		env = append(env, key+"="+value)
	}
	env = append(env, "PWD="+b.Directory)
	if err := os.Chdir(b.Directory); err != nil {
		return err
	}
	path, err := exec.LookPath(command[0])
	if err != nil {
		return err
	}
	// Replacing the CLI preserves the foreground terminal, child exit status and signals.
	return syscall.Exec(path, command, env)
}
