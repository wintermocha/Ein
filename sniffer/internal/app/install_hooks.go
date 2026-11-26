package app

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"

	"ein.local/sniffer/internal/config"
)

type hookEdit struct {
	path          string
	before, after []byte
}

func hookJSON(data []byte) (map[string]any, error) {
	if !json.Valid(data) {
		return nil, errors.New("invalid hooks JSON")
	}
	var obj map[string]any
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	if err := dec.Decode(&obj); err != nil || obj == nil {
		return nil, errors.New("expected a hooks JSON object")
	}
	return obj, nil
}

func prepareHooks(profile, template, binary, host string) (hookEdit, error) {
	edit := hookEdit{path: profile}
	opts := map[string]any{}
	st, err := os.Lstat(profile)
	if err == nil {
		if !st.Mode().IsRegular() {
			return edit, errors.New("hook profile must be a regular file")
		}
		edit.before, err = os.ReadFile(profile)
		if err != nil {
			return edit, err
		}
		opts, err = hookJSON(edit.before)
		if err != nil {
			return edit, err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return edit, err
	}
	raw, err := os.ReadFile(template)
	if err != nil {
		return edit, err
	}
	// Substitute one shell-quoted executable inside the JSON command strings.
	command, err := json.Marshal("'" + strings.ReplaceAll(binary, "'", "'\"'\"'") + "'")
	if err != nil {
		return edit, err
	}
	marker, err := json.Marshal("\"/ABSOLUTE/PATH/sniffer\"")
	if err != nil {
		return edit, err
	}
	placeholder := marker[1 : len(marker)-1]
	if !bytes.Contains(raw, placeholder) {
		return edit, errors.New("hook template has no executable placeholder")
	}
	raw = bytes.ReplaceAll(raw, placeholder, command[1:len(command)-1])
	entries, err := hookJSON(raw)
	if err != nil {
		return edit, err
	}
	switch host {
	case "codex":
		hooks, ok := opts["hooks"].(map[string]any)
		if !ok {
			if _, exists := opts["hooks"]; exists {
				return edit, errors.New("Codex hooks must be an object")
			}
			hooks = map[string]any{}
			opts["hooks"] = hooks
		}
		additions, ok := entries["hooks"].(map[string]any)
		if !ok {
			return edit, errors.New("invalid Codex template")
		}
		for event, value := range additions {
			group, ok := value.([]any)
			if !ok {
				return edit, fmt.Errorf("invalid template event %s", event)
			}
			current, ok := hooks[event].([]any)
			if _, exists := hooks[event]; exists && !ok {
				return edit, fmt.Errorf("invalid existing hook event %s", event)
			}
			for _, item := range group {
				found := false
				for _, original := range current {
					if reflect.DeepEqual(original, item) {
						found = true
						break
					}
				}
				if !found {
					current = append(current, item)
				}
			}
			hooks[event] = current
		}
	case "agy":
		group, ok := entries["sniffer-memory"].(map[string]any)
		if !ok {
			return edit, errors.New("invalid agy template")
		}
		if original, exists := opts["sniffer-memory"]; exists && !reflect.DeepEqual(original, group) {
			return edit, errors.New("existing sniffer-memory hook differs; see the integration guide")
		}
		opts["sniffer-memory"] = group
	default:
		return edit, fmt.Errorf("unknown hook host %q", host)
	}
	after, err := json.MarshalIndent(opts, "", "  ")
	if err != nil {
		return edit, err
	}
	if edit.before != nil {
		original, err := hookJSON(edit.before)
		if err != nil {
			return edit, err
		}
		if reflect.DeepEqual(opts, original) {
			return edit, nil
		}
	}
	edit.after = append(after, '\n')
	return edit, nil
}

func (a app) installHooks() error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	codex := os.Getenv("CODEX_HOME")
	if codex == "" {
		codex = filepath.Join(home, ".codex")
	}
	bin := filepath.Join(a.paths.Home, "bin", "sniffer")
	targets := []struct{ host, adapter, path string }{
		{"codex", "codex", filepath.Join(codex, "hooks.json")},
		{"agy", "antigravity", filepath.Join(home, ".gemini", "config", "hooks.json")},
	}
	// Validate both profiles before changing either. Interrupted installs can be repeated.
	edits := make([]hookEdit, 0, len(targets))
	for _, target := range targets {
		template := filepath.Join(a.paths.Adapters, target.adapter, "hooks.example.json")
		edit, err := prepareHooks(target.path, template, bin, target.host)
		if err != nil {
			return fmt.Errorf("prepare %s hooks (%s): %w", target.host, target.path, err)
		}
		edits = append(edits, edit)
	}
	for _, edit := range edits {
		if edit.after == nil {
			continue
		}
		current, err := os.ReadFile(edit.path)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if !bytes.Equal(current, edit.before) {
			return fmt.Errorf("hook profile changed during installation: %s", edit.path)
		}
		if err := config.AtomicWrite(edit.path, edit.after, 0600); err != nil {
			return err
		}
	}
	return a.json(map[string]string{"codex": targets[0].path, "agy": targets[1].path})
}
