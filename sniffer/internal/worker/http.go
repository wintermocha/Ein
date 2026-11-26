package worker

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"ein.local/sniffer/internal/host"
)

func (e *Engine) Handler(token string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			http.Error(w, "method", 405)
			return
		}
		reply(w, map[string]string{"status": "ok", "host": e.Host, "project": e.Project})
	})
	mux.HandleFunc("/v1/event", func(w http.ResponseWriter, r *http.Request) {
		var v host.Event
		if !decode(w, r, &v) {
			return
		}
		out, err := e.Handle(r.Context(), v)
		respond(w, out, err)
	})
	mux.HandleFunc("/v1/ack", func(w http.ResponseWriter, r *http.Request) {
		var a Ack
		if !decode(w, r, &a) {
			return
		}
		respond(w, map[string]string{"status": "ok"}, e.Acknowledge(a))
	})
	mux.HandleFunc("/v1/recall", func(w http.ResponseWriter, r *http.Request) {
		var v RecallRequest
		if !decode(w, r, &v) {
			return
		}
		out, err := e.Recall(r.Context(), v)
		respond(w, out, err)
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		if r.Header.Get("Origin") != "" {
			http.Error(w, "origin denied", 403)
			return
		}
		if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
			http.Error(w, "unauthorized", 401)
			return
		}
		got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if len(token) < 32 || subtle.ConstantTimeCompare([]byte(got), []byte(token)) != 1 {
			http.Error(w, "unauthorized", 401)
			return
		}
		mux.ServeHTTP(w, r)
	})
}
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	if r.Method != "POST" {
		http.Error(w, "method", 405)
		return false
	}
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		http.Error(w, "invalid request", 400)
		return false
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		http.Error(w, "trailing request data", 400)
		return false
	}
	return true
}
func respond(w http.ResponseWriter, v any, err error) {
	if err != nil {
		w.WriteHeader(http.StatusConflict)
		reply(w, map[string]string{"error": err.Error()})
		return
	}
	reply(w, v)
}
func reply(w http.ResponseWriter, v any) { _ = json.NewEncoder(w).Encode(v) }

type Client struct {
	Endpoint, Token string
	HTTP            *http.Client
}

func ClientFromEnv() (Client, error) {
	if os.Getenv("EIN_SNIFFER_ROLE") == "memory-agent" {
		return Client{}, errors.New("read-only memory agent cannot connect to the main worker")
	}
	if os.Getenv("EIN_SNIFFER_RUN_ID") == "" {
		return Client{}, errors.New("not running under sniffer run")
	}
	u, err := url.Parse(os.Getenv("EIN_SNIFFER_ENDPOINT"))
	if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.Port() == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return Client{}, errors.New("invalid worker endpoint")
	}
	path := os.Getenv("EIN_SNIFFER_TOKEN_FILE")
	st, err := os.Lstat(path)
	if err != nil {
		return Client{}, err
	}
	if !st.Mode().IsRegular() || st.Mode().Perm()&0077 != 0 || st.Size() > 256 {
		return Client{}, errors.New("worker token file is not private")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return Client{}, err
	}
	if len(b) < 32 {
		return Client{}, errors.New("invalid worker token")
	}
	return Client{Endpoint: u.String(), Token: string(b), HTTP: &http.Client{Timeout: 7 * time.Second, Transport: &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 2 * time.Second}).DialContext}, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("worker redirects denied") }}}, nil
}
func (c Client) Post(ctx context.Context, path string, in, out any) error {
	b, err := json.Marshal(in)
	if err != nil {
		return err
	}
	r, err := http.NewRequestWithContext(ctx, "POST", c.Endpoint+path, bytes.NewReader(b))
	if err != nil {
		return err
	}
	r.Header.Set("Authorization", "Bearer "+c.Token)
	r.Header.Set("Content-Type", "application/json")
	resp, err := c.HTTP.Do(r)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	b, err = io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode != 200 {
		return errors.New("worker rejected request: " + strings.TrimSpace(string(b)))
	}
	return json.Unmarshal(b, out)
}
