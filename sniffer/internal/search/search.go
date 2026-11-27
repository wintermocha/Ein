// Package search performs local, scope-bounded lexical retrieval. It does not
// write memory files, caches, or delivery receipts and never calls a model.
package search

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"ein.local/sniffer/internal/model"
	"golang.org/x/text/cases"
	"golang.org/x/text/unicode/norm"
)

type Hit struct {
	Memory        model.Memory `json:"memory"`
	Score         float64      `json:"score"`
	Expanded      []string     `json:"expanded,omitempty"`
	ScopeDistance int          `json:"scope_distance"`
}

func normalize(s string) string {
	s = cases.Fold().String(norm.NFC.String(s))
	return strings.Join(strings.FieldsFunc(s, func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsNumber(r)
	}), " ")
}

func distances(s model.Snapshot, projectID string) (map[string]int, error) {
	chain, err := s.AccessChain(projectID)
	if err != nil {
		return nil, err
	}
	out := make(map[string]int, len(chain))
	for i, id := range chain {
		out[id] = i
	}
	return out, nil
}

// List lists committed, authorized memories. A scope filter can narrow the
// current project's ancestor set, but cannot grant access to a sibling scope.
func List(s model.Snapshot, projectID, scopeFilter string) ([]model.Memory, error) {
	dist, err := distances(s, projectID)
	if err != nil {
		return nil, err
	}
	if scopeFilter != "" {
		if _, ok := dist[scopeFilter]; !ok {
			return nil, errors.New("scope is outside the bound project's ancestry")
		}
	}
	out := []model.Memory{}
	for _, m := range s.Memories {
		if _, ok := dist[m.ScopeID]; ok && (scopeFilter == "" || m.ScopeID == scopeFilter) {
			out = append(out, m)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if dist[out[i].ScopeID] != dist[out[j].ScopeID] {
			return dist[out[i].ScopeID] < dist[out[j].ScopeID]
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}

func Read(s model.Snapshot, projectID, id string) (model.Memory, error) {
	memories, err := List(s, projectID, "")
	if err != nil {
		return model.Memory{}, err
	}
	for _, m := range memories {
		if m.ID == id {
			return m, nil
		}
	}
	// Do not disclose whether the ID exists in a private sibling project.
	return model.Memory{}, errors.New("memory not found in the bound project's ancestry")
}

func phraseIn(haystack, needle string) bool {
	if needle == "" {
		return false
	}
	// Korean suffixes often attach without spaces. Hangul phrases may therefore
	// match inside a token; Latin terms must respect normalized word boundaries.
	for _, r := range needle {
		if r >= 0xAC00 && r <= 0xD7A3 {
			return strings.Contains(haystack, needle)
		}
	}
	return strings.Contains(" "+haystack+" ", " "+needle+" ")
}

func expansions(query string, glossary [][]string) []string {
	seen := map[string]bool{query: true}
	out := []string{}
	for _, group := range glossary {
		matched := false
		for _, term := range group {
			if phraseIn(query, normalize(term)) {
				matched = true
				break
			}
		}
		if !matched {
			continue
		}
		for _, term := range group {
			t := normalize(term)
			if t != "" && !seen[t] {
				seen[t] = true
				out = append(out, t)
			}
		}
	}
	sort.Strings(out)
	if len(out) > 32 {
		out = out[:32]
	}
	return out
}

func textScore(m model.Memory, query string) float64 {
	desc, body := normalize(m.Description), normalize(m.Body)
	aliases, tags := normalize(strings.Join(m.Aliases, " ")), normalize(strings.Join(m.Tags, " "))
	score := 0.0
	if phraseIn(desc, query) {
		score += 12
	}
	if phraseIn(aliases, query) {
		score += 10
	}
	if phraseIn(tags, query) {
		score += 4
	}
	if phraseIn(body, query) {
		score += 3
	}
	seen := map[string]bool{}
	for _, term := range strings.Fields(query) {
		if seen[term] || utf8.RuneCountInString(term) < 2 {
			continue
		}
		seen[term] = true
		if phraseIn(desc, term) {
			score += 4
		}
		if phraseIn(aliases, term) {
			score += 3
		}
		if phraseIn(tags, term) {
			score += 2
		}
		if phraseIn(body, term) {
			score += 1
		}
	}
	if score == 0 {
		score = hangulScore(query, desc+" "+aliases+" "+body)
	}
	return score
}

func hangulScore(query, text string) float64 {
	// A conservative spelling/spacing fallback: at least two distinct matching
	// bigrams and 60 percent coverage. Two-syllable chance matches alone cannot
	// cause a result when no lexical term matched.
	grams := map[string]bool{}
	triples := map[string]bool{}
	for _, token := range strings.Fields(query) {
		r := []rune(token)
		for i := 0; i+1 < len(r); i++ {
			if r[i] >= 0xAC00 && r[i] <= 0xD7A3 && r[i+1] >= 0xAC00 && r[i+1] <= 0xD7A3 {
				grams[string(r[i:i+2])] = true
				if i+2 < len(r) && r[i+2] >= 0xAC00 && r[i+2] <= 0xD7A3 {
					triples[string(r[i:i+3])] = true
				}
			}
		}
	}
	if len(grams) < 2 {
		return 0
	}
	hits := 0
	for g := range grams {
		if strings.Contains(text, g) {
			hits++
		}
	}
	coverage := float64(hits) / float64(len(grams))
	if hits < 2 || coverage < 0.6 {
		return 0
	}
	tripleHits := 0
	for g := range triples {
		if strings.Contains(text, g) {
			tripleHits++
		}
	}
	if len(triples) > 0 {
		coverage = 0.7*coverage + 0.3*float64(tripleHits)/float64(len(triples))
	}
	return coverage // Always lower than a whole-word match.
}

// Find ranks authorized memories without semantic embeddings. A keyed override
// is selected before output: a matching inherited rule can identify the topic,
// but its closest project/group override is what the caller receives.
func Find(s model.Snapshot, projectID, query string, limit int) ([]Hit, error) {
	if !utf8.ValidString(query) || len(query) > 8192 {
		return nil, errors.New("query must be UTF-8 and no larger than 8192 bytes")
	}
	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		return nil, errors.New("search limit exceeds 100")
	}
	dist, err := distances(s, projectID)
	if err != nil {
		return nil, err
	}
	memories, err := List(s, projectID, "")
	if err != nil {
		return nil, err
	}
	q := normalize(query)
	if q == "" {
		return []Hit{}, nil
	}
	expanded := expansions(q, s.Glossary)
	type group struct {
		chosen   model.Memory
		score    float64
		distance int
		ids      map[string]bool
	}
	groups := map[string]*group{}
	for _, m := range memories {
		key := "id:" + m.ID
		if m.Key != "" {
			key = "key:" + m.Key
		}
		score := textScore(m, q)
		for _, term := range expanded {
			score += 0.35 * textScore(m, term)
		}
		g := groups[key]
		if g == nil {
			groups[key] = &group{m, score, dist[m.ScopeID], map[string]bool{m.ID: true}}
			continue
		}
		if g.ids[m.ID] {
			return nil, fmt.Errorf("duplicate memory ID in snapshot: %s", m.ID)
		}
		g.ids[m.ID] = true
		if score > g.score {
			g.score = score
		}
		if dist[m.ScopeID] < g.distance {
			g.chosen = m
			g.distance = dist[m.ScopeID]
		} else if dist[m.ScopeID] == g.distance {
			return nil, fmt.Errorf("ambiguous key %q in scope %s", m.Key, m.ScopeID)
		}
	}
	out := []Hit{}
	for _, g := range groups {
		if g.score <= 0 {
			continue
		}
		out = append(out, Hit{Memory: g.chosen, Score: g.score, Expanded: expanded, ScopeDistance: g.distance})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Score != out[j].Score {
			return out[i].Score > out[j].Score
		}
		if out[i].ScopeDistance != out[j].ScopeDistance {
			return out[i].ScopeDistance < out[j].ScopeDistance
		}
		return out[i].Memory.ID < out[j].Memory.ID
	})
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}
