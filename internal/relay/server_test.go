package relay

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

type fixture struct {
	s    *Server
	http *httptest.Server
}

func setup(t *testing.T) *fixture {
	t.Helper()
	s, err := New(Config{DataDir: t.TempDir(), PublicURL: "http://localhost:8080"})
	if err != nil {
		t.Fatal(err)
	}
	h := httptest.NewServer(s.Handler())
	f := &fixture{s, h}
	t.Cleanup(func() { s.Close(); h.Close() })
	return f
}
func (f *fixture) create(t *testing.T, session Session) (Session, string) {
	t.Helper()
	body, _ := json.Marshal(session)
	req, _ := http.NewRequest("POST", f.http.URL+"/api/sessions", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+f.s.token)
	r, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	if r.StatusCode != 200 && r.StatusCode != 201 {
		t.Fatalf("create status %d", r.StatusCode)
	}
	var result struct {
		Session  Session `json:"session"`
		ShareURL string  `json:"shareUrl"`
	}
	if err = json.NewDecoder(r.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	return result.Session, result.ShareURL
}
func dial(t *testing.T, f *fixture, path string, first Message) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, strings.Replace(f.http.URL, "http", "ws", 1)+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.CloseNow() })
	if err = wsjson.Write(ctx, c, first); err != nil {
		t.Fatal(err)
	}
	return c
}
func readType(t *testing.T, c *websocket.Conn, kind string) Message {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		var m Message
		if err := wsjson.Read(ctx, c, &m); err != nil {
			t.Fatalf("read %s: %v", kind, err)
		}
		if m.Type == kind {
			return m
		}
	}
}
func write(t *testing.T, c *websocket.Conn, m Message) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := wsjson.Write(ctx, c, m); err != nil {
		t.Fatal(err)
	}
}

func TestURLSessionReusesAndPersists(t *testing.T) {
	f := setup(t)
	first, link := f.create(t, Session{AgentID: "browser-one", Kind: "url", URL: "https://EXAMPLE.com#section"})
	second, _ := f.create(t, Session{AgentID: "browser-one", Kind: "url", URL: "https://example.com/"})
	if first.ID != second.ID || first.Key != second.Key {
		t.Fatal("same URL created a different shared session")
	}
	if !strings.HasSuffix(link, "#"+first.Key) {
		t.Fatal("share capability must live in fragment")
	}
	restored, err := New(f.s.cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	if restored.token != f.s.token || restored.sessions[first.ID].Key != first.Key {
		t.Fatal("restart lost credentials or stable share link")
	}
	info, err := os.Stat(filepath.Join(f.s.cfg.DataDir, "sessions.json"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatal("session keys require private file permissions")
	}
}
func TestTabIDsCannotRebindAfterBrowserRestart(t *testing.T) {
	f := setup(t)
	a, _ := f.create(t, Session{AgentID: "browser-one", Kind: "tab", URL: "https://example.com", TabID: 1, TabEpoch: "epoch-one"})
	b, _ := f.create(t, Session{AgentID: "browser-one", Kind: "tab", URL: "https://example.com", TabID: 1, TabEpoch: "epoch-two"})
	if a.ID == b.ID {
		t.Fatal("Chrome tab IDs may be recycled after restart")
	}
}
func TestMultipleViewersShareDOMAndInput(t *testing.T) {
	f := setup(t)
	se, _ := f.create(t, Session{AgentID: "browser-one", Kind: "url", URL: "https://example.com"})
	a := dial(t, f, "/ws/agent", Message{Type: "hello", Token: f.s.token, AgentID: se.AgentID})
	readType(t, a, "ready")
	v1 := dial(t, f, "/ws/view/"+se.ID, Message{Type: "join", Key: se.Key})
	open := readType(t, a, "open")
	if open.Session.ID != se.ID || open.Session.Key != "" {
		t.Fatal("agent needs target, not share capability")
	}
	v2 := dial(t, f, "/ws/view/"+se.ID, Message{Type: "join", Key: se.Key})
	readType(t, a, "open")
	write(t, a, Message{Type: "dom", SessionID: se.ID, Document: &Document{Version: "test", Sequence: 1, Reset: true, Root: "1", Nodes: []map[string]any{{"id": "1", "tag": "body", "text": "shared"}}, Meta: map[string]any{"width": 1280, "height": 720}}})
	if readType(t, v1, "dom").Document.Root != "1" || readType(t, v2, "dom").Document.Root != "1" {
		t.Fatal("viewers did not share the same DOM")
	}
	write(t, v1, Message{Type: "input", Input: &Input{Action: "text", Text: "from one"}})
	if m := readType(t, a, "input"); m.SessionID != se.ID || m.Input.Text != "from one" {
		t.Fatal("input routed to wrong tab")
	}
	write(t, v2, Message{Type: "input", Input: &Input{Action: "text", Text: "from two"}})
	if readType(t, a, "input").Input.Text != "from two" {
		t.Fatal("second viewer cannot control tab")
	}
	write(t, v2, Message{Type: "input", Input: &Input{Action: "Runtime.evaluate", Text: "bad"}})
	write(t, v2, Message{Type: "input", Input: &Input{Action: "reload"}})
	if readType(t, a, "input").Input.Action != "reload" {
		t.Fatal("arbitrary debugging command reached browser")
	}
	_ = a.CloseNow()
	readType(t, v1, "status") // May first consume the initial waiting status; reconnect still requests target below.
	a2 := dial(t, f, "/ws/agent", Message{Type: "hello", Token: f.s.token, AgentID: se.AgentID})
	readType(t, a2, "ready")
	if readType(t, a2, "open").Session.ID != se.ID {
		t.Fatal("reconnected agent did not resume live shared session")
	}
}
func TestAuthAndRevocation(t *testing.T) {
	f := setup(t)
	r, err := http.Get(f.http.URL + "/api/sessions")
	if err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	if r.StatusCode != 401 {
		t.Fatal("API must require pairing token")
	}
	se, _ := f.create(t, Session{AgentID: "browser-one", Kind: "url", URL: "https://example.com"})
	bad := dial(t, f, "/ws/view/"+se.ID, Message{Type: "join", Key: "wrong"})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var m Message
	if err := wsjson.Read(ctx, bad, &m); websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
		t.Fatalf("bad share accepted: %v", err)
	}
	req, _ := http.NewRequest("DELETE", f.http.URL+"/api/sessions/"+se.ID, nil)
	req.Header.Set("Authorization", "Bearer "+f.s.token)
	r, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	if r.StatusCode != 204 {
		t.Fatalf("revoke: %d", r.StatusCode)
	}
	old := dial(t, f, "/ws/view/"+se.ID, Message{Type: "join", Key: se.Key})
	if err := wsjson.Read(ctx, old, &m); websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
		t.Fatal("revoked capability can still join")
	}
	restored, err := New(f.s.cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	if restored.sessions[se.ID] != nil {
		t.Fatal("revocation did not survive restart")
	}
}
func TestInputRestrictions(t *testing.T) {
	for _, i := range []*Input{{Action: "navigate", URL: "file:///etc/passwd"}, {Action: "navigate", URL: "javascript:alert(1)"}, {Action: "Runtime.evaluate"}, {Action: "mousePressed", X: -1}, {Action: "keyDown", Modifiers: 16}} {
		if validInput(i) {
			t.Fatalf("unsafe input accepted: %+v", i)
		}
	}
	if !validInput(&Input{Action: "text", Text: "你好"}) {
		t.Fatal("IME text should be supported")
	}
}
