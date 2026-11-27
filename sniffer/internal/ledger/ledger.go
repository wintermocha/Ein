// Package ledger records delivery claims independently of the Git memory store.
// A successful claim grants one caller the payload; all later attempts suppress
// it even when acknowledgement is lost. This is an at-most-once handoff guard,
// not proof that a host or language model consumed the material.
package ledger

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

	"ein.local/sniffer/internal/model"
)

const maxStateBytes = 64 << 20

var (
	ErrStaleEpoch = errors.New("context epoch changed; discard the stale delivery")
	ErrCorrupt    = errors.New("delivery ledger is invalid; automatic delivery stopped")
)

// Session is stable across worker restarts. Epoch changes only after an explicit
// context reset/compaction signal; a worker's run ID belongs in Claim's owner.
type Session struct {
	FolderScope    string `json:"folder_scope,omitempty"`
	Host           string `json:"host"`
	ConversationID string `json:"conversation_id"`
	ProjectID      string `json:"project_id"`
	Epoch          int    `json:"epoch"`
}

type Delivery struct {
	ID       string         `json:"delivery_id,omitempty"`
	Memories []model.Memory `json:"memories,omitempty"`
	State    string         `json:"state"`
}

type Ledger struct{ dir string }

// New does not touch the filesystem. In particular, constructing a ledger for
// a read-only command does not create a cache, lock, or session record.
func New(dir string) *Ledger { return &Ledger{dir: filepath.Clean(dir)} }

// Receipts intentionally omit descriptions, bodies, paths and authentication
// data. Content hashes are recomputed from canonical memory content, rather than
// trusting a possibly stale caller-supplied hash.
type receipt struct {
	ID   string `json:"id"`
	Hash string `json:"content_hash"`
}
type record struct {
	ID        string    `json:"id"`
	Owner     string    `json:"owner"`
	Event     string    `json:"event"`
	Epoch     int       `json:"epoch"`
	State     string    `json:"state"`
	CreatedAt string    `json:"created_at"`
	UpdatedAt string    `json:"updated_at"`
	Memories  []receipt `json:"memories"`
}
type state struct {
	Version    int               `json:"schema_version"`
	SessionKey string            `json:"session_key"`
	Epoch      int               `json:"epoch"`
	Advances   map[string]int    `json:"advances"`
	Events     map[string]string `json:"events"`
	Deliveries map[string]record `json:"deliveries"`
}

func digest(parts ...string) string {
	h := sha256.New()
	for _, p := range parts {
		// Length-prefix each component so delimiters in IDs cannot alias a key.
		io.WriteString(h, strconv.Itoa(len(p)))
		io.WriteString(h, ":")
		io.WriteString(h, p)
	}
	return hex.EncodeToString(h.Sum(nil))
}

func validToken(s string, max int) bool {
	return s != "" && len(s) <= max && utf8.ValidString(s) && strings.TrimSpace(s) == s && !strings.ContainsAny(s, "\x00\r\n")
}

func baseKey(s Session) (string, error) {
	if !validToken(s.Host, 128) || !validToken(s.ConversationID, 2048) || !validToken(s.ProjectID, 256) || s.Epoch < 0 {
		return "", errors.New("host, conversation ID, project ID and nonnegative epoch are required")
	}
	project := strings.TrimPrefix(s.ProjectID, "project:")
	if project == "" || strings.Contains(strings.TrimPrefix(project, "folder:"), ":") || project == "folder:" {
		return "", errors.New("delivery requires a project ID")
	}
	if s.FolderScope != "" {
		return digest(s.Host, s.ConversationID, project, s.FolderScope), nil
	}
	return digest(s.Host, s.ConversationID, project), nil
}

func emptyState(key string) state {
	return state{Version: 1, SessionKey: key, Advances: map[string]int{}, Events: map[string]string{}, Deliveries: map[string]record{}}
}

func hexDigest(s string) bool {
	if len(s) != 64 {
		return false
	}
	b, err := hex.DecodeString(s)
	return err == nil && len(b) == 32 && strings.ToLower(s) == s
}

func (l *Ledger) ensureDir(create bool) (bool, error) {
	if l.dir == "." || l.dir == "" {
		return false, errors.New("a dedicated ledger directory is required")
	}
	info, err := os.Lstat(l.dir)
	if errors.Is(err, os.ErrNotExist) {
		if !create {
			return false, nil
		}
		if err = os.MkdirAll(l.dir, 0700); err != nil {
			return false, err
		}
		info, err = os.Lstat(l.dir)
	}
	if err != nil {
		return false, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return false, errors.New("ledger directory must be a real directory")
	}
	if info.Mode().Perm()&0077 != 0 {
		return false, errors.New("ledger directory must have private permissions (0700)")
	}
	return true, nil
}

func (l *Ledger) lock(key string) (func(), error) {
	if _, err := l.ensureDir(true); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(l.dir, key+".lock"), os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return nil, err
	}
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		f.Close()
		return nil, errors.New("ledger lock must be a private regular file")
	}
	if err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		f.Close()
		return nil, err
	}
	return func() { syscall.Flock(int(f.Fd()), syscall.LOCK_UN); f.Close() }, nil
}

func validateState(s state, key string) error {
	if s.Version != 1 || s.SessionKey != key || s.Epoch < 0 || s.Advances == nil || s.Events == nil || s.Deliveries == nil {
		return ErrCorrupt
	}
	for event, epoch := range s.Advances {
		if !hexDigest(event) || epoch < 1 || epoch > s.Epoch {
			return ErrCorrupt
		}
	}
	for id, r := range s.Deliveries {
		if id != r.ID || len(id) != 34 || !strings.HasPrefix(id, "d-") || !validToken(r.Owner, 256) || !hexDigest(r.Event) || r.Epoch < 0 || r.Epoch > s.Epoch || len(r.Memories) == 0 || len(r.Memories) > 1000 {
			return ErrCorrupt
		}
		if _, err := hex.DecodeString(id[2:]); err != nil {
			return ErrCorrupt
		}
		if r.State != "claimed" && r.State != "emitted" && r.State != "uncertain" {
			return ErrCorrupt
		}
		if _, err := time.Parse(time.RFC3339Nano, r.CreatedAt); err != nil {
			return ErrCorrupt
		}
		if _, err := time.Parse(time.RFC3339Nano, r.UpdatedAt); err != nil {
			return ErrCorrupt
		}
		if s.Events[r.Event] != id {
			return ErrCorrupt
		}
		ids := map[string]bool{}
		for _, m := range r.Memories {
			if !validToken(m.ID, 256) || !hexDigest(m.Hash) || ids[m.ID] {
				return ErrCorrupt
			}
			ids[m.ID] = true
		}
	}
	for event, id := range s.Events {
		if !hexDigest(event) {
			return ErrCorrupt
		}
		if id != "" {
			if r, ok := s.Deliveries[id]; !ok || r.Event != event {
				return ErrCorrupt
			}
		}
	}
	return nil
}

func (l *Ledger) read(key string) (state, error) {
	initial := emptyState(key)
	exists, err := l.ensureDir(false)
	if err != nil || !exists {
		return initial, err
	}
	f, err := os.OpenFile(filepath.Join(l.dir, key+".json"), os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if errors.Is(err, os.ErrNotExist) {
		return initial, nil
	}
	if err != nil {
		return initial, fmt.Errorf("read ledger: %w", err)
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return initial, err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() > maxStateBytes {
		return initial, ErrCorrupt
	}
	dec := json.NewDecoder(io.LimitReader(f, maxStateBytes+1))
	dec.DisallowUnknownFields()
	var s state
	if err = dec.Decode(&s); err != nil {
		return initial, ErrCorrupt
	}
	var extra any
	if err = dec.Decode(&extra); err != io.EOF {
		return initial, ErrCorrupt
	}
	if err = validateState(s, key); err != nil {
		return initial, err
	}
	return s, nil
}

func (l *Ledger) write(key string, s state) error {
	if err := validateState(s, key); err != nil {
		return err
	}
	b, err := json.Marshal(s)
	if err != nil {
		return err
	}
	if len(b) > maxStateBytes {
		return errors.New("delivery ledger reached its size limit")
	}
	f, err := os.CreateTemp(l.dir, ".ledger-*")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if err = f.Chmod(0600); err != nil {
		f.Close()
		return err
	}
	if _, err = io.Copy(f, bytes.NewReader(b)); err != nil {
		f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	if err = os.Rename(name, filepath.Join(l.dir, key+".json")); err != nil {
		return err
	}
	d, err := os.Open(l.dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

func candidates(memories []model.Memory) ([]model.Memory, []receipt, error) {
	if len(memories) > 1000 {
		return nil, nil, errors.New("too many memories in one delivery request")
	}
	unique := []model.Memory{}
	receipts := []receipt{}
	ids := map[string]string{}
	for _, m := range memories {
		if !validToken(m.ID, 256) {
			return nil, nil, errors.New("memory ID is required for a delivery")
		}
		hash := model.HashMemory(m)
		if previous, ok := ids[m.ID]; ok {
			if previous != hash {
				return nil, nil, errors.New("a delivery cannot contain two versions of one memory")
			}
			continue
		}
		ids[m.ID] = hash
		m.ContentHash = hash
		unique = append(unique, m)
		receipts = append(receipts, receipt{ID: m.ID, Hash: hash})
	}
	return unique, receipts, nil
}

func seen(s state, epoch int) map[string]bool {
	out := map[string]bool{}
	for _, r := range s.Deliveries {
		if r.Epoch != epoch {
			continue
		}
		// claimed and uncertain both suppress retries, just as emitted does.
		for _, m := range r.Memories {
			out[digest(m.ID, m.Hash)] = true
		}
	}
	return out
}

// FilterUnseen is a read-only optimization before a paid model invocation. Its
// result is advisory: Claim repeats the check under an interprocess lock.
func (l *Ledger) FilterUnseen(session Session, memories []model.Memory) ([]model.Memory, error) {
	key, err := baseKey(session)
	if err != nil {
		return nil, err
	}
	unique, receipts, err := candidates(memories)
	if err != nil {
		return nil, err
	}
	s, err := l.read(key)
	if err != nil {
		return nil, err
	}
	if session.Epoch != s.Epoch {
		return nil, ErrStaleEpoch
	}
	known := seen(s, session.Epoch)
	out := []model.Memory{}
	for i, m := range unique {
		if !known[digest(receipts[i].ID, receipts[i].Hash)] {
			out = append(out, m)
		}
	}
	return out, nil
}

// Claim atomically reserves a batch before any payload leaves the worker. The
// caller must emit Memories only when this call returns a nonempty slice. A
// repeated event returns its receipt/status with no payload, including when the
// prior owner crashed. force permits a new explicit recall, never an event retry.
func (l *Ledger) Claim(session Session, owner, eventID string, memories []model.Memory, force bool) (Delivery, error) {
	key, err := baseKey(session)
	if err != nil {
		return Delivery{}, err
	}
	if !validToken(owner, 256) || !validToken(eventID, 2048) {
		return Delivery{}, errors.New("owner and event ID are required")
	}
	unique, receipts, err := candidates(memories)
	if err != nil {
		return Delivery{}, err
	}
	unlock, err := l.lock(key)
	if err != nil {
		return Delivery{}, err
	}
	defer unlock()
	s, err := l.read(key)
	if err != nil {
		return Delivery{}, err
	}
	if session.Epoch != s.Epoch {
		return Delivery{}, ErrStaleEpoch
	}
	event := digest(strconv.Itoa(session.Epoch), eventID)
	if id, ok := s.Events[event]; ok {
		if id == "" {
			return Delivery{State: "suppressed"}, nil
		}
		return Delivery{ID: id, State: s.Deliveries[id].State}, nil
	}
	known := seen(s, session.Epoch)
	selected := []model.Memory{}
	chosen := []receipt{}
	for i, m := range unique {
		if !force && known[digest(receipts[i].ID, receipts[i].Hash)] {
			continue
		}
		selected = append(selected, m)
		chosen = append(chosen, receipts[i])
	}
	if len(selected) == 0 {
		s.Events[event] = ""
		if err = l.write(key, s); err != nil {
			return Delivery{}, err
		}
		return Delivery{State: "suppressed"}, nil
	}
	random := make([]byte, 16)
	if _, err = rand.Read(random); err != nil {
		return Delivery{}, err
	}
	id := "d-" + hex.EncodeToString(random)
	if _, exists := s.Deliveries[id]; exists {
		return Delivery{}, errors.New("delivery ID collision")
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	r := record{ID: id, Owner: owner, Event: event, Epoch: session.Epoch, State: "claimed", CreatedAt: now, UpdatedAt: now, Memories: chosen}
	s.Events[event] = id
	s.Deliveries[id] = r
	if err = l.write(key, s); err != nil {
		return Delivery{}, err
	}
	return Delivery{ID: id, Memories: selected, State: "claimed"}, nil
}

func (l *Ledger) transition(session Session, id, owner, target string) error {
	key, err := baseKey(session)
	if err != nil {
		return err
	}
	if !validToken(id, 256) || !validToken(owner, 256) {
		return errors.New("delivery ID and owner are required")
	}
	unlock, err := l.lock(key)
	if err != nil {
		return err
	}
	defer unlock()
	s, err := l.read(key)
	if err != nil {
		return err
	}
	r, ok := s.Deliveries[id]
	if !ok || r.Owner != owner || r.Epoch != session.Epoch {
		return errors.New("delivery does not belong to this owner and session")
	}
	if r.State == target || (target == "uncertain" && r.State == "emitted") {
		return nil
	}
	r.State = target
	r.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	s.Deliveries[id] = r
	return l.write(key, s)
}

func (l *Ledger) Emitted(session Session, deliveryID, owner string) error {
	return l.transition(session, deliveryID, owner, "emitted")
}
func (l *Ledger) Uncertain(session Session, deliveryID, owner string) error {
	return l.transition(session, deliveryID, owner, "uncertain")
}

// RecoverOwner marks the stopped worker's outstanding handoffs uncertain. It
// deliberately does not release them for an automatic retry after a timeout.
func (l *Ledger) RecoverOwner(owner string) error {
	if !validToken(owner, 256) {
		return errors.New("owner is required")
	}
	exists, err := l.ensureDir(false)
	if err != nil || !exists {
		return err
	}
	entries, err := os.ReadDir(l.dir)
	if err != nil {
		return err
	}
	keys := []string{}
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasSuffix(name, ".json") && hexDigest(strings.TrimSuffix(name, ".json")) {
			keys = append(keys, strings.TrimSuffix(name, ".json"))
		}
	}
	sort.Strings(keys)
	for _, key := range keys {
		err = func() error {
			unlock, err := l.lock(key)
			if err != nil {
				return err
			}
			defer unlock()
			s, err := l.read(key)
			if err != nil {
				return err
			}
			changed := false
			for id, r := range s.Deliveries {
				if r.Owner != owner || r.State != "claimed" {
					continue
				}
				r.State = "uncertain"
				r.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
				s.Deliveries[id] = r
				changed = true
			}
			if changed {
				return l.write(key, s)
			}
			return nil
		}()
		if err != nil {
			return err
		}
	}
	return nil
}

// Epoch reads the current context epoch without creating filesystem state.
func (l *Ledger) Epoch(sessionbase Session) (int, error) {
	key, err := baseKey(sessionbase)
	if err != nil {
		return 0, err
	}
	s, err := l.read(key)
	return s.Epoch, err
}

// AdvanceEpoch handles a documented compaction/reset signal. Repeated event IDs
// never increment twice and return the active epoch, including after later resets.
func (l *Ledger) AdvanceEpoch(sessionbase Session, eventID string) (int, error) {
	key, err := baseKey(sessionbase)
	if err != nil {
		return 0, err
	}
	if !validToken(eventID, 2048) {
		return 0, errors.New("reset event ID is required")
	}
	unlock, err := l.lock(key)
	if err != nil {
		return 0, err
	}
	defer unlock()
	s, err := l.read(key)
	if err != nil {
		return 0, err
	}
	event := digest(eventID)
	if _, ok := s.Advances[event]; ok {
		return s.Epoch, nil
	}
	if s.Epoch >= 1_000_000_000 {
		return 0, errors.New("context epoch limit reached")
	}
	s.Epoch++
	s.Advances[event] = s.Epoch
	if err = l.write(key, s); err != nil {
		return 0, err
	}
	return s.Epoch, nil
}
