package app

import (
	"context"
	"errors"
	"os"
	"slices"
	"strings"

	"ein.local/sniffer/internal/model"
)

func globalOperator(project string) error {
	if project != "" || os.Getenv(expectedProjectEnv) != "" || os.Getenv(delegationEnv) != "" || os.Getenv("EIN_SNIFFER_ROLE") != "" || os.Getenv("EIN_SNIFFER_RUN_ID") != "" {
		return errors.New("--global requires a standalone operator without --project")
	}
	return nil
}

func (a app) listGlobal(scope string) error {
	if scope != "" && scope != "global" {
		return errors.New("--global can list only the global scope")
	}
	memories := []model.Memory{}
	var commit string
	if _, err := os.Stat(a.paths.Store); err == nil {
		snap, err := a.st().Snapshot(context.Background())
		if err != nil {
			return err
		}
		commit = snap.Commit
		for _, m := range snap.Memories {
			if m.ScopeID == "global" {
				memories = append(memories, m)
			}
		}
		slices.SortFunc(memories, func(a, b model.Memory) int { return strings.Compare(a.ID, b.ID) })
	} else if !os.IsNotExist(err) {
		return err
	}
	return a.json(map[string]any{"snapshot": commit, "memories": memories})
}
