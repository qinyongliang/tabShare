package relay

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

type gatedBody struct {
	entered, release chan struct{}
	once             sync.Once
}

func (r *gatedBody) Read([]byte) (int, error) {
	r.once.Do(func() { close(r.entered) })
	<-r.release
	return 0, io.EOF
}
func TestSlowSessionBodyDoesNotBlockOtherSessions(t *testing.T) {
	f := setup(t)
	body := &gatedBody{entered: make(chan struct{}), release: make(chan struct{})}
	var once sync.Once
	release := func() { once.Do(func() { close(body.release) }) }
	defer release()
	request := httptest.NewRequest(http.MethodPost, "/api/sessions", body)
	request.Header.Set("Authorization", "Bearer "+f.s.token)
	postDone := make(chan struct{})
	go func() { f.s.Handler().ServeHTTP(httptest.NewRecorder(), request); close(postDone) }()
	select {
	case <-body.entered:
	case <-time.After(time.Second):
		t.Fatal("POST did not read body")
	}
	get := httptest.NewRequest(http.MethodGet, "/api/sessions", nil)
	get.Header.Set("Authorization", "Bearer "+f.s.token)
	done := make(chan struct{})
	response := httptest.NewRecorder()
	go func() { f.s.Handler().ServeHTTP(response, get); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		release()
		t.Fatal("slow body blocked an unrelated session read")
	}
	if response.Code != 200 {
		t.Fatal("session read failed")
	}
	release()
	<-postDone
}
func TestConcurrentSessionWritesPersistWithoutLosingUpdates(t *testing.T) {
	f := setup(t)
	var group sync.WaitGroup
	for i := 0; i < 12; i++ {
		group.Add(1)
		go func(i int) {
			defer group.Done()
			body, _ := json.Marshal(Session{AgentID: "parallel-agent", Kind: "url", URL: "https://example.com/" + string(rune('a'+i))})
			r := httptest.NewRequest("POST", "/api/sessions", bytes.NewReader(body))
			r.Header.Set("Authorization", "Bearer "+f.s.token)
			w := httptest.NewRecorder()
			f.s.Handler().ServeHTTP(w, r)
			if w.Code != 201 {
				t.Errorf("create status %d", w.Code)
			}
		}(i)
	}
	group.Wait()
	data, err := os.ReadFile(filepath.Join(f.s.cfg.DataDir, "sessions.json"))
	if err != nil {
		t.Fatal(err)
	}
	var saved map[string]Session
	if err = json.Unmarshal(data, &saved); err != nil {
		t.Fatal(err)
	}
	if len(saved) != 12 || len(f.s.sessions) != 12 {
		t.Fatal("concurrent persistence lost sessions")
	}
}
func TestSessionWriteFailureDoesNotPublishCreationOrRevocation(t *testing.T) {
	f := setup(t)
	se, _ := f.create(t, Session{AgentID: "failure-agent", Kind: "url", URL: "https://example.com"})
	if err := os.Mkdir(filepath.Join(f.s.cfg.DataDir, "sessions.json.tmp"), 0700); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(Session{AgentID: "failure-agent", Kind: "url", URL: "https://example.com/new"})
	r := httptest.NewRequest("POST", "/api/sessions", bytes.NewReader(body))
	r.Header.Set("Authorization", "Bearer "+f.s.token)
	w := httptest.NewRecorder()
	f.s.Handler().ServeHTTP(w, r)
	if w.Code != 500 || len(f.s.sessions) != 1 {
		t.Fatal("failed creation was published")
	}
	r = httptest.NewRequest("DELETE", "/api/sessions/"+se.ID, nil)
	r.Header.Set("Authorization", "Bearer "+f.s.token)
	w = httptest.NewRecorder()
	f.s.Handler().ServeHTTP(w, r)
	if w.Code != 500 || f.s.sessions[se.ID] == nil {
		t.Fatal("failed revocation changed the active share")
	}
}

func TestWebSocketBacklogByteBudgetIsReleasedOnDisconnect(t *testing.T) {
	f := setup(t)
	c := dial(t, f, "/ws/agent", Message{Type: "hello", Token: f.s.token, AgentID: "queue-browser"})
	readType(t, c, "ready")
	f.s.mu.Lock()
	p := f.s.agents["queue-browser"]
	f.s.mu.Unlock()
	payload := bytes.Repeat([]byte("x"), 1<<20)
	for i := 0; i < 32; i++ {
		sendPacket(p, payload)
	}
	_ = c.CloseNow()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if f.s.queuedBytes.Load() == 0 {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("closed WebSocket retained its global byte budget")
}
func TestStatsRequireAuthenticationAndExposeOnlyCounts(t *testing.T) {
	f := setup(t)
	r := httptest.NewRequest("GET", "/api/stats", nil)
	w := httptest.NewRecorder()
	f.s.Handler().ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatal("public diagnostics exposed")
	}
	r = httptest.NewRequest("GET", "/api/stats", nil)
	r.Header.Set("Authorization", "Bearer "+f.s.token)
	w = httptest.NewRecorder()
	f.s.Handler().ServeHTTP(w, r)
	if w.Code != 200 || bytes.Contains(w.Body.Bytes(), []byte(f.s.token)) {
		t.Fatal("diagnostics failed or leaked credentials")
	}
	var stats map[string]int
	if err := json.Unmarshal(w.Body.Bytes(), &stats); err != nil {
		t.Fatal(err)
	}
	if stats["websocketQueuedBytes"] != 0 || stats["resourceBytes"] != 0 {
		t.Fatal("unexpected diagnostic counters")
	}
}
