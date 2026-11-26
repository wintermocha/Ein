package native

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"unicode/utf8"
)

func ParseDecision(raw []byte) (Decision, error) {
	var d Decision
	if len(raw) == 0 || len(raw) > 16384 || !utf8.Valid(raw) {
		return d, errors.New("invalid agent decision size or encoding")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&d); err != nil {
		return d, err
	}
	var tail any
	if decoder.Decode(&tail) != io.EOF {
		return d, errors.New("agent decision has trailing data")
	}
	if d.Decision != "inject" && d.Decision != "none" || d.References == nil || len(d.References) > 3 || utf8.RuneCountInString(d.Reason) > 512 {
		return d, errors.New("invalid agent decision")
	}
	if (d.Decision == "none") != (len(d.References) == 0) {
		return d, errors.New("decision and references disagree")
	}
	seen := map[string]bool{}
	for _, ref := range d.References {
		if ref.ID == "" || len(ref.ID) > 128 || strings.ContainsAny(ref.ID, "/\\\x00\r\n") || seen[ref.ID] {
			return d, errors.New("invalid or duplicate memory reference")
		}
		if len(ref.Revision) != 40 && len(ref.Revision) != 64 {
			return d, errors.New("memory reference needs its exact Git blob revision")
		}
		if _, err := hex.DecodeString(ref.Revision); err != nil {
			return d, errors.New("invalid memory revision")
		}
		seen[ref.ID] = true
	}
	return d, nil
}

func New(cfg Config) (Session, error) {
	switch cfg.Host {
	case "codex":
		return NewCodex(cfg)
	case "agy":
		return NewAGY(cfg)
	case "claude":
		return nil, errors.New("Claude sessions are owned by the native Sniffer mod; no external Claude runner exists")
	default:
		return nil, errors.New("unsupported native session host")
	}
}
