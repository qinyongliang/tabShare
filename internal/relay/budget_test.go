package relay

import (
	"bytes"
	"context"
	"errors"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket/wsjson"
)

func budgetDocument(version string, size int) *Document {
	return &Document{Reset: true, Version: version, Sequence: 1, Root: "1", Nodes: []map[string]any{{"id": "1", "tag": "body", "text": strings.Repeat("x", size)}}, CSS: "body{}", Meta: map[string]any{"width": 1280}}
}

func TestDOMGlobalBudgetIsAtomicAndReleased(t *testing.T) {
	f := setup(t)
	f.s.cfg.DOMCacheBytes = 1500
	a, b := &live{}, &live{}
	if err := f.s.applyDocument(a, budgetDocument("one", 900)); err != nil {
		t.Fatal(err)
	}
	before := f.s.domBytes
	if err := f.s.applyDocument(b, budgetDocument("two", 900)); !errors.Is(err, errDOMBudget) {
		t.Fatal("global budget allowed a second large room", err)
	}
	if f.s.domBytes != before || b.document.snapshot() != nil {
		t.Fatal("rejection changed cached state")
	}
	if err := f.s.applyDocument(a, &Document{Version: "one", Sequence: 2, Root: "1", CSSChanged: true, CSS: strings.Repeat("x", 1000)}); !errors.Is(err, errDOMBudget) {
		t.Fatal("CSS bypassed shared budget")
	}
	if a.document.css != "body{}" || f.s.domBytes != before {
		t.Fatal("CSS rejection was not atomic")
	}
	f.s.clearDocument(a)
	if f.s.domBytes != 0 {
		t.Fatal("cache clear leaked budget")
	}
	if err := f.s.applyDocument(b, budgetDocument("two", 900)); err != nil {
		t.Fatal("freed budget was not reusable", err)
	}
	f.s.clearDocument(b)
	f.s.clearDocument(b)
	if f.s.domBytes != 0 {
		t.Fatal("repeated cleanup double-released budget")
	}
}

func TestDOMCapacityAffectsOnlyFallbackRoomAndRecovers(t *testing.T) {
	f := setup(t)
	f.s.cfg.DOMCacheBytes = 1500
	one, _ := f.create(t, Session{AgentID: "budget-browser", Kind: "url", URL: "https://example.com/one"})
	two, _ := f.create(t, Session{AgentID: "budget-browser", Kind: "url", URL: "https://example.com/two"})
	agent := dial(t, f, "/ws/agent", Message{Type: "hello", Token: f.s.token, AgentID: one.AgentID})
	readType(t, agent, "ready")
	v1 := dial(t, f, "/ws/view/"+one.ID, Message{Type: "join", Key: one.Key})
	readType(t, agent, "open")
	v2 := dial(t, f, "/ws/view/"+two.ID, Message{Type: "join", Key: two.Key})
	readType(t, agent, "open")
	readType(t, v2, "mode")
	write(t, agent, Message{Type: "dom", SessionID: one.ID, Document: budgetDocument("one", 900)})
	readType(t, v1, "dom")
	write(t, agent, Message{Type: "dom", SessionID: two.ID, Document: budgetDocument("two", 900)})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := wsjson.Read(ctx, v2, &Message{}); err == nil {
		t.Fatal("over-budget fallback remained active")
	}
	write(t, v1, Message{Type: "input", Input: &Input{Action: "text", Text: "still works"}})
	if readType(t, agent, "input").SessionID != one.ID {
		t.Fatal("another room was affected")
	}
	_ = v1.CloseNow()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		f.s.mu.Lock()
		free := f.s.domBytes == 0
		f.s.mu.Unlock()
		if free {
			break
		}
		time.Sleep(time.Millisecond)
	}
	v3 := dial(t, f, "/ws/view/"+two.ID, Message{Type: "join", Key: two.Key})
	readType(t, v3, "mode")
	write(t, agent, Message{Type: "dom", SessionID: two.ID, Document: budgetDocument("two", 900)})
	if readType(t, v3, "dom").Document.Version != "two" {
		t.Fatal("capacity recovery did not restore snapshot")
	}
}

func TestAllDirectViewersReleaseFallbackDOMCache(t *testing.T) {
	f := setup(t)
	se, _ := f.create(t, Session{AgentID: "direct-browser", Kind: "url", URL: "https://example.com"})
	agent := dial(t, f, "/ws/agent", Message{Type: "hello", Token: f.s.token, AgentID: se.AgentID})
	readType(t, agent, "ready")
	viewer := dial(t, f, "/ws/view/"+se.ID, Message{Type: "join", Key: se.Key})
	joined := readType(t, viewer, "joined")
	readType(t, agent, "open")
	write(t, agent, Message{Type: "dom", SessionID: se.ID, Document: budgetDocument("one", 900)})
	readType(t, viewer, "dom")
	upload := func() int {
		t.Helper()
		r, _ := http.NewRequest("POST", f.http.URL+"/api/resources/"+se.ID+"/image", bytes.NewBufferString("image"))
		r.Header.Set("Authorization", "Bearer "+f.s.token)
		r.Header.Set("Content-Type", "image/png")
		response, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		return response.StatusCode
	}
	if upload() != 201 {
		t.Fatal("initial resource upload failed")
	}
	write(t, agent, Message{Type: "transport", SessionID: se.ID, ViewerID: joined.ViewerID, Status: "p2p"})
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		f.s.mu.Lock()
		free := f.s.domBytes == 0 && f.s.assetBytes == 0
		f.s.mu.Unlock()
		if free {
			break
		}
		time.Sleep(time.Millisecond)
	}
	f.s.mu.Lock()
	free := f.s.domBytes == 0 && f.s.assetBytes == 0
	f.s.mu.Unlock()
	if !free {
		t.Fatal("direct-only room retained redundant cache")
	}
	if upload() != 202 {
		t.Fatal("in-flight upload after P2P switch was retained")
	}
	fallback := dial(t, f, "/ws/view/"+se.ID, Message{Type: "join", Key: se.Key})
	readType(t, fallback, "resources")
	if upload() != 201 {
		t.Fatal("new fallback resource could not be restored")
	}
	readType(t, fallback, "resource")
	_ = fallback.CloseNow()
	deadline = time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		f.s.mu.Lock()
		free := f.s.assetBytes == 0 && len(f.s.live[se.ID].viewers) == 1
		f.s.mu.Unlock()
		if free {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("last fallback leaving did not free redundant cache for remaining direct viewer")
}

func TestByteBudgetRefillsAndSharesAcrossConcurrentSenders(t *testing.T) {
	b := newByteBudget(1000000)
	now := b.last
	if !b.allow(int(b.burst), now) || b.allow(1, now) {
		t.Fatal("initial burst bound failed")
	}
	if !b.allow(1000, now.Add(time.Millisecond)) || b.allow(1, now.Add(time.Millisecond)) {
		t.Fatal("refill bound failed")
	}
	b = newByteBudget(1000000)
	now = b.last
	var accepted atomic.Int64
	var group sync.WaitGroup
	for i := 0; i < 100; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			if b.allow(10000, now) {
				accepted.Add(10000)
			}
		}()
	}
	group.Wait()
	if accepted.Load() > int64(b.burst) || accepted.Load() < int64(b.burst)-10000 {
		t.Fatal("parallel senders bypassed bucket", accepted.Load())
	}
	if b.allow(-1, now) || b.allow(300000, now.Add(time.Hour)) {
		t.Fatal("invalid or oversize packet passed")
	}
}

func TestTURNPayloadBudgetDropsWithoutClosingAllocation(t *testing.T) {
	f := turnFixture(t, true)
	m := f.s.turn
	raw, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	remote, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer remote.Close()
	p := &turnPacket{PacketConn: raw, manager: m}
	payload := []byte("budget-test")
	exhaust := func() {
		m.bandwidth.mu.Lock()
		m.bandwidth.tokens = 0
		m.bandwidth.last = time.Now().Add(time.Hour)
		m.bandwidth.mu.Unlock()
	}
	refill := func() {
		m.bandwidth.mu.Lock()
		m.bandwidth.tokens = m.bandwidth.burst
		m.bandwidth.last = time.Now()
		m.bandwidth.mu.Unlock()
	}
	exhaust()
	if n, e := p.WriteTo(payload, remote.LocalAddr()); e != nil || n != len(payload) {
		t.Fatal("drop terminated writer", n, e)
	}
	_ = remote.SetReadDeadline(time.Now().Add(20 * time.Millisecond))
	buf := make([]byte, 128)
	if _, _, e := remote.ReadFrom(buf); e == nil {
		t.Fatal("egress budget did not discard payload")
	}
	if _, e := remote.WriteTo(payload, raw.LocalAddr()); e != nil {
		t.Fatal(e)
	}
	_ = p.SetReadDeadline(time.Now().Add(20 * time.Millisecond))
	if _, _, e := p.ReadFrom(buf); e == nil {
		t.Fatal("ingress budget did not discard payload")
	}
	if m.droppedBytes.Load() != uint64(2*len(payload)) {
		t.Fatal("drop diagnostics incorrect")
	}
	refill()
	_ = remote.SetReadDeadline(time.Now().Add(time.Second))
	if _, e := p.WriteTo(payload, remote.LocalAddr()); e != nil {
		t.Fatal(e)
	}
	if n, _, e := remote.ReadFrom(buf); e != nil || n != len(payload) {
		t.Fatal("budget recovery failed", e)
	}
	// Authentication and fresh allocations remain usable while payload was limited.
	_, _, _, ice := turnLogin(t, f)
	_ = echoTURN(t, f, ice, "tcp", nil)
}
