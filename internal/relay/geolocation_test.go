package relay

import (
	"context"
	"testing"
	"time"

	"github.com/coder/websocket/wsjson"
)

func TestGeolocationPromptIsRecipientScoped(t *testing.T) {
	f := setup(t)
	se, _ := f.create(t, Session{AgentID: "geo-browser", Kind: "url", URL: "https://example.com"})
	agent := dial(t, f, "/ws/agent", Message{Type: "hello", Token: f.s.token, AgentID: se.AgentID})
	readType(t, agent, "ready")
	one := dial(t, f, "/ws/view/"+se.ID, Message{Type: "join", Key: se.Key})
	joined := readType(t, one, "joined")
	readType(t, agent, "open")
	two := dial(t, f, "/ws/view/"+se.ID, Message{Type: "join", Key: se.Key})
	readType(t, two, "joined")
	payload := `{"kind":"request","id":"request-123","epoch":"epoch-123","origin":"https://example.com","watch":false}`
	write(t, agent, Message{Type: "geolocation", SessionID: se.ID, ViewerID: joined.ViewerID, Data: payload})
	if got := readType(t, one, "geolocation"); got.Data != payload {
		t.Fatal("geolocation prompt changed")
	}
	write(t, agent, Message{Type: "notice", SessionID: se.ID, Detail: "after-prompt"})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	for {
		var message Message
		if err := wsjson.Read(ctx, two, &message); err != nil {
			t.Fatal(err)
		}
		if message.Type == "geolocation" {
			t.Fatal("permission prompt leaked to another viewer")
		}
		if message.Type == "notice" {
			break
		}
	}
	for _, action := range []string{"downloadAck", "geolocationResult"} {
		if !validInput(&Input{Action: action, Text: `{}`}) {
			t.Fatal("valid response envelope rejected")
		}
		if validInput(&Input{Action: action, Text: `not JSON`}) {
			t.Fatal("malformed response accepted")
		}
	}
}
