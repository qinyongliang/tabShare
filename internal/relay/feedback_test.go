package relay

import (
	"context"
	"github.com/coder/websocket/wsjson"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestInputAckIsBoundedAndRecipientScoped(t *testing.T) {
	f := setup(t)
	se, _ := f.create(t, Session{AgentID: "feedback-browser", Kind: "url", URL: "https://example.com"})
	agent := dial(t, f, "/ws/agent", Message{Type: "hello", Token: f.s.token, AgentID: se.AgentID})
	readType(t, agent, "ready")
	one := dial(t, f, "/ws/view/"+se.ID, Message{Type: "join", Key: se.Key})
	joined := readType(t, one, "joined")
	readType(t, agent, "open")
	two := dial(t, f, "/ws/view/"+se.ID, Message{Type: "join", Key: se.Key})
	readType(t, two, "joined")
	write(t, one, Message{Type: "input", Input: &Input{Action: "reload", RequestID: "request_123"}})
	received := readType(t, agent, "input")
	if received.Input.RequestID != "request_123" || received.Input.ViewerID != joined.ViewerID {
		t.Fatal("input correlation/identity lost")
	}
	write(t, agent, Message{Type: "input-ack", SessionID: se.ID, ViewerID: joined.ViewerID, RequestID: "request_123", Status: "accepted"})
	if got := readType(t, one, "input-ack"); got.RequestID != "request_123" || got.Status != "accepted" {
		t.Fatal("ack changed")
	}
	write(t, agent, Message{Type: "notice", SessionID: se.ID, Detail: "after-ack"})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	for {
		var message Message
		if err := wsjson.Read(ctx, two, &message); err != nil {
			t.Fatal(err)
		}
		if message.Type == "input-ack" {
			t.Fatal("ack leaked to another viewer")
		}
		if message.Type == "notice" {
			break
		}
	}
	if validInput(&Input{Action: "reload", RequestID: strings.Repeat("x", 65)}) || validInput(&Input{Action: "reload", RequestID: "<script>"}) {
		t.Fatal("invalid request id accepted")
	}
}
func TestMirrorCSPAllowsStylesButNeverSourceScripts(t *testing.T) {
	f := setup(t)
	for _, path := range []string{"/assets/mirror.html", "/assets/viewer.js"} {
		response, err := http.Get(f.http.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		values := response.Header.Values("Content-Security-Policy")
		if len(values) != 1 {
			t.Fatalf("unexpected layered CSP: %v", values)
		}
		csp := values[0]
		if path == "/assets/mirror.html" {
			if !strings.Contains(csp, "style-src 'unsafe-inline'") || strings.Contains(csp, "allow-scripts") || !strings.Contains(csp, "sandbox allow-same-origin") {
				t.Fatal(csp)
			}
		} else if !strings.Contains(csp, "style-src 'self'") {
			t.Fatal("viewer shell style CSP weakened")
		}
	}
}
