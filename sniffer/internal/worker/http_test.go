package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"ein.local/sniffer/internal/host"
	"ein.local/sniffer/internal/native"
)

const fixtureToken = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func TestWorkerHTTPRequiresBearerAndRejectsBrowserOrigins(t *testing.T) {
	e := &Engine{Host: "codex", Project: "alpha"}
	handler := e.Handler(fixtureToken)
	cases := []struct {
		name, authorization, origin string
		want                        int
	}{
		{"missing", "", "", 401},
		{"wrong", "Bearer wrong", "", 401},
		{"raw_token", fixtureToken, "", 401},
		{"wrong_scheme", "Basic " + fixtureToken, "", 401},
		{"browser_origin", "Bearer " + fixtureToken, "https://example.invalid", 403},
		{"opaque_origin", "Bearer " + fixtureToken, "null", 403},
		{"authorized", "Bearer " + fixtureToken, "", 200},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "http://127.0.0.1/health", nil)
			r.Header.Set("Authorization", tc.authorization)
			if tc.origin != "" {
				r.Header.Set("Origin", tc.origin)
			}
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if w.Code != tc.want {
				t.Fatalf("status=%d, want %d", w.Code, tc.want)
			}
			if w.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("worker response is cacheable")
			}
		})
	}
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "http://127.0.0.1/health", nil)
	r.Header.Set("Authorization", "Bearer short")
	e.Handler("short").ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatal("weak configured token accepted")
	}
}

func TestWorkerHTTPRejectsMalformedRequestsAndHasNoWriterRoute(t *testing.T) {
	var calls atomic.Int32
	f := newEngineFixture(t, "codex", func(ctx context.Context, in native.Request, tools native.ToolHandler) (native.Decision, error) {
		calls.Add(1)
		return oneDecision(ctx, in, tools)
	})
	handler := f.e.Handler(fixtureToken)
	valid, _ := json.Marshal(f.event("event", "retry"))
	cases := []struct {
		name, method, path, body string
		want                     int
	}{
		{"wrong_method", "GET", "/v1/event", "", 405},
		{"malformed_json", "POST", "/v1/event", `{"host":`, 400},
		{"trailing_json", "POST", "/v1/event", string(valid) + ` {}`, 400},
		{"unknown_field", "POST", "/v1/event", `{"unexpected":true}`, 400},
		{"too_large", "POST", "/v1/event", `{"query":"` + strings.Repeat("x", 1<<20) + `"}`, 400},
		{"writer_absent", "POST", "/v1/save", `{"body":"unauthorized save"}`, 404},
		{"promote_absent", "POST", "/v1/promote", `{}`, 404},
		{"invalid_ack", "POST", "/v1/ack", `{"conversation_id":"c","delivery_id":"d","outcome":"observed"}`, 409},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(tc.method, "http://127.0.0.1"+tc.path, strings.NewReader(tc.body))
			r.Header.Set("Authorization", "Bearer "+fixtureToken)
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if w.Code != tc.want {
				t.Fatalf("status=%d, want %d, body=%s", w.Code, tc.want, w.Body.String())
			}
		})
	}
	if calls.Load() != 0 {
		t.Fatalf("invalid requests invoked native agent %d times", calls.Load())
	}
}

func nativeEnvelope(t *testing.T, h, root string) []byte {
	t.Helper()
	var event any
	switch h {
	case "codex":
		event = map[string]any{"hook_event_name": "UserPromptSubmit", "session_id": "conversation-fixture", "event_id": "native-1", "cwd": root, "prompt": "retry key"}
	case "agy":
		event = map[string]any{"hookEventName": "PreInvocation", "conversationId": "conversation-fixture", "eventId": "native-1", "workspacePaths": []string{root}, "lastUserInput": "retry key"}
	default:
		t.Fatal("invalid fixture host")
	}
	b, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// This traverses the native event decoder, actual HTTP transport, local search,
// a mocked model decision, durable claim, native output encoding and ACK. It
// does not claim compatibility with a signed-in external CLI or a live model.
func TestNativeEventsThroughHTTPDeliveryAndAcknowledgement(t *testing.T) {
	for _, h := range []string{"codex", "agy"} {
		t.Run(h, func(t *testing.T) {
			var calls atomic.Int32
			f := newEngineFixture(t, h, func(ctx context.Context, in native.Request, tools native.ToolHandler) (native.Decision, error) {
				calls.Add(1)
				return allDecision(ctx, in, tools)
			})
			server := httptest.NewServer(f.e.Handler(fixtureToken))
			defer server.Close()
			client := Client{Endpoint: server.URL, Token: fixtureToken, HTTP: server.Client()}
			v, err := host.Decode(h, nativeEnvelope(t, h, f.alpha))
			if err != nil {
				t.Fatal(err)
			}
			var out Response
			if err = client.Post(context.Background(), "/v1/event", v, &out); err != nil {
				t.Fatal(err)
			}
			if out.Status != "claimed" || out.Context == "" || out.DeliveryID == "" {
				t.Fatalf("native event did not produce delivery: %+v", out)
			}
			encoded, err := host.Encode(h, v.Name, out.Context)
			if err != nil {
				t.Fatal(err)
			}
			if !json.Valid(encoded) || !bytes.Contains(encoded, []byte("m-project")) || bytes.Contains(encoded, []byte("PRIVATE_SIBLING_SENTINEL")) {
				t.Fatalf("invalid native output: %s", encoded)
			}
			var envelope map[string]json.RawMessage
			_ = json.Unmarshal(encoded, &envelope)
			wantKey := map[string]string{"codex": "hookSpecificOutput", "agy": "injectSteps"}[h]
			if _, ok := envelope[wantKey]; !ok {
				t.Fatalf("wrong native injection envelope: %s", encoded)
			}
			ack := Ack{ConversationID: out.ConversationID, Epoch: out.Epoch, DeliveryID: out.DeliveryID, Outcome: "emitted"}
			var status map[string]string
			if err = client.Post(context.Background(), "/v1/ack", ack, &status); err != nil || status["status"] != "ok" {
				t.Fatalf("ACK failed: %v %v", status, err)
			}
			// Repeating the same native callback neither emits nor starts a turn.
			out = Response{}
			if err = client.Post(context.Background(), "/v1/event", v, &out); err != nil {
				t.Fatal(err)
			}
			if out.Context != "" || calls.Load() != 1 {
				t.Fatalf("repeat delivery or model call: %+v calls=%d", out, calls.Load())
			}
			// A genuine later prompt may require agent judgment, while the durable
			// delivery ledger must still suppress the already handed-off content.
			v.EventID, v.Query = "native-2", "retry again"
			out = Response{}
			if err = client.Post(context.Background(), "/v1/event", v, &out); err != nil || out.Context != "" {
				t.Fatalf("new prompt replayed memory: %+v %v", out, err)
			}
			beforeManual := calls.Load()
			var forced Response
			if err = client.Post(context.Background(), "/v1/recall", RecallRequest{IDs: []string{"m-project"}, Force: true, EventID: "explicit-force"}, &forced); err != nil {
				t.Fatal(err)
			}
			if forced.Context == "" || forced.Status != "claimed" || calls.Load() != beforeManual {
				t.Fatalf("explicit recall did not use local engine: %+v", forced)
			}
		})
	}
}

func installClientEnv(t *testing.T, endpoint string) string {
	t.Helper()
	file := filepath.Join(t.TempDir(), "worker-token")
	if err := os.WriteFile(file, []byte(fixtureToken), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("EIN_SNIFFER_ROLE", "")
	t.Setenv("EIN_SNIFFER_RUN_ID", "test-run")
	t.Setenv("EIN_SNIFFER_ENDPOINT", endpoint)
	t.Setenv("EIN_SNIFFER_TOKEN_FILE", file)
	return file
}

func TestClientInactiveWithoutLauncherAndInsideMemoryAgent(t *testing.T) {
	installClientEnv(t, "http://127.0.0.1:12345")
	if _, err := ClientFromEnv(); err != nil {
		t.Fatalf("valid launcher environment rejected: %v", err)
	}
	t.Setenv("EIN_SNIFFER_RUN_ID", "")
	if _, err := ClientFromEnv(); err == nil {
		t.Fatal("GUI/direct CLI without launcher activated worker client")
	}
	t.Setenv("EIN_SNIFFER_RUN_ID", "test-run")
	t.Setenv("EIN_SNIFFER_ROLE", "memory-agent")
	if _, err := ClientFromEnv(); err == nil {
		t.Fatal("read-only memory agent connected recursively to main worker")
	}
}

func TestClientAcceptsOnlyLoopbackAndPrivateTokenFiles(t *testing.T) {
	for _, endpoint := range []string{
		"https://127.0.0.1:12345", "http://localhost:12345", "http://example.invalid:12345", "http://127.0.0.1",
		"http://user@127.0.0.1:12345", "http://127.0.0.1:12345/path", "http://127.0.0.1:12345?query=1", "http://127.0.0.1:12345#fragment",
	} {
		t.Run(endpoint, func(t *testing.T) {
			installClientEnv(t, endpoint)
			if _, err := ClientFromEnv(); err == nil {
				t.Fatal("unsafe endpoint accepted")
			}
		})
	}
	for _, name := range []string{"shared_permissions", "symlink", "short", "oversized"} {
		t.Run(name, func(t *testing.T) {
			file := installClientEnv(t, "http://127.0.0.1:12345")
			switch name {
			case "shared_permissions":
				if err := os.Chmod(file, 0644); err != nil {
					t.Fatal(err)
				}
			case "symlink":
				link := filepath.Join(t.TempDir(), "token-link")
				if err := os.Symlink(file, link); err != nil {
					t.Fatal(err)
				}
				t.Setenv("EIN_SNIFFER_TOKEN_FILE", link)
			case "short":
				if err := os.WriteFile(file, []byte("short"), 0600); err != nil {
					t.Fatal(err)
				}
			case "oversized":
				if err := os.WriteFile(file, bytes.Repeat([]byte("x"), 257), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := ClientFromEnv(); err == nil {
				t.Fatal("nonprivate or invalid token accepted")
			}
		})
	}
}

func TestClientDoesNotFollowWorkerRedirects(t *testing.T) {
	var leaked atomic.Int32
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaked.Add(1); w.WriteHeader(200) }))
	defer destination.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, destination.URL, http.StatusTemporaryRedirect)
	}))
	defer source.Close()
	installClientEnv(t, source.URL)
	client, err := ClientFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	var out Response
	if err = client.Post(context.Background(), "/v1/event", map[string]string{}, &out); err == nil {
		t.Fatal("redirect was followed")
	}
	if leaked.Load() != 0 {
		t.Fatal("token or query reached redirect destination")
	}
}

func TestWorkerHTTPRejectsEventsAfterOwnerExitAndClosesActiveSession(t *testing.T) {
	started, stopped := make(chan struct{}), make(chan struct{})
	f := newEngineFixture(t, "codex", func(ctx context.Context, _ native.Request, _ native.ToolHandler) (native.Decision, error) {
		close(started)
		<-ctx.Done()
		close(stopped)
		return native.Decision{}, ctx.Err()
	})
	f.e.Limits.WaitMillis = 5
	server := httptest.NewServer(f.e.Handler(fixtureToken))
	defer server.Close()
	client := Client{Endpoint: server.URL, Token: fixtureToken, HTTP: server.Client()}
	var out Response
	if err := client.Post(context.Background(), "/v1/event", f.event("running", "retry"), &out); err != nil || out.Status != "pending" {
		t.Fatalf("pending HTTP observation: %+v %v", out, err)
	}
	waitSignal(t, started)
	f.e.Close()
	waitSignal(t, stopped)
	if err := client.Post(context.Background(), "/v1/event", f.event("after-owner-exit", "retry"), &out); err == nil {
		t.Fatal("authenticated client restarted an exited owner's worker")
	}
	sessions, runs := f.agents.observations()
	if len(sessions) != 1 || len(runs) != 1 || !sessions[0].closed.Load() {
		t.Fatalf("HTTP owner lifetime leaked or restarted native session: %d sessions, %d runs", len(sessions), len(runs))
	}
}
