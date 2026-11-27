package store

import (
	"context"
	"encoding/json"
	"errors"

	"ein.local/sniffer/internal/model"
)

// BindFolder saves the reviewed scope tree in one transaction. The local
// config lock serializes folder bindings; a concurrent manual registry edit
// invalidates the plan so it can never overwrite another user's hierarchy.
func (s *Store) BindFolder(ctx context.Context, before string, registry model.Registry) error {
	if err := model.ValidateRegistry(registry); err != nil {
		return err
	}
	data, err := json.MarshalIndent(registry, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	id := "bind-" + before + "-" + contentDigest(data)[:24]
	_, err = s.mutate(ctx, id, registry, func(snap model.Snapshot) (plan, error) {
		if snap.Commit != before {
			return plan{}, errors.New("memory store changed during binding; retry")
		}
		return plan{changes: map[string][]byte{"scopes.json": data}}, nil
	})
	return err
}
