package relay

import (
	"math"
	"testing"
	"time"
)

func TestViewportBounds(t *testing.T) {
	for _, v := range []Input{{Action: "viewport", Width: 320, Height: 240, DeviceScaleFactor: 1}, {Action: "viewport", Width: 1920, Height: 1080, DeviceScaleFactor: 2}, {Action: "restoreViewport"}} {
		if !validInput(&v) {
			t.Fatalf("rejected valid viewport: %+v", v)
		}
	}
	for _, v := range []Input{{Action: "viewport", Width: 0, Height: 240, DeviceScaleFactor: 1}, {Action: "viewport", Width: 5000, Height: 240, DeviceScaleFactor: 1}, {Action: "viewport", Width: 3840, Height: 2160, DeviceScaleFactor: 2}, {Action: "viewport", Width: 320, Height: 240, DeviceScaleFactor: math.NaN()}, {Action: "viewportRelease"}} {
		if validInput(&v) {
			t.Fatalf("accepted invalid viewport: %+v", v)
		}
	}
}

func TestViewportDriverIdentityAndRelease(t *testing.T) {
	f := setup(t)
	session, _ := f.create(t, Session{AgentID: "viewport-agent", Kind: "url", URL: "https://example.com/"})
	agent := dial(t, f, "/ws/agent", Message{Type: "hello", Token: f.s.token, AgentID: session.AgentID})
	readType(t, agent, "ready")
	one := dial(t, f, "/ws/view/"+session.ID, Message{Type: "join", Key: session.Key})
	oneJoined := readType(t, one, "joined")
	oneID := oneJoined.ViewerID
	if !oneJoined.AutoViewport {
		t.Fatal("first viewer must be the automatic viewport driver")
	}
	readType(t, one, "viewport")
	two := dial(t, f, "/ws/view/"+session.ID, Message{Type: "join", Key: session.Key})
	twoJoined := readType(t, two, "joined")
	twoID := twoJoined.ViewerID
	if twoJoined.AutoViewport {
		t.Fatal("concurrent join must not override the automatic driver")
	}
	readType(t, two, "viewport")
	forged := randomID()
	write(t, one, Message{Type: "input", Input: &Input{Action: "viewport", ViewerID: forged, Width: 390, Height: 700, DeviceScaleFactor: 2}})
	input := readType(t, agent, "input").Input
	if input.ViewerID != oneID || input.ViewerID == forged {
		t.Fatal("viewer supplied driver identity")
	}
	write(t, agent, Message{Type: "viewport", SessionID: session.ID, Viewport: &Viewport{Width: 390, Height: 700, DeviceScaleFactor: 2, Owner: oneID}})
	if readType(t, one, "viewport").Viewport.Owner != oneID || readType(t, two, "viewport").Viewport.Owner != oneID {
		t.Fatal("driver state not shared")
	}
	write(t, two, Message{Type: "input", Input: &Input{Action: "viewport", Width: 800, Height: 600, DeviceScaleFactor: 1}})
	if readType(t, agent, "input").Input.ViewerID != twoID {
		t.Fatal("second driver identity missing")
	}
	write(t, agent, Message{Type: "viewport", SessionID: session.ID, Viewport: &Viewport{Width: 800, Height: 600, DeviceScaleFactor: 1, Owner: twoID}})
	readType(t, one, "viewport")
	readType(t, two, "viewport")
	_ = one.CloseNow()
	deadline := time.Now().Add(2 * time.Second)
	for {
		f.s.mu.Lock()
		count := len(f.s.live[session.ID].viewers)
		owner := f.s.live[session.ID].viewport.Owner
		f.s.mu.Unlock()
		if count == 1 {
			if owner != twoID {
				t.Fatal("old driver cleared new driver")
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("viewer cleanup timeout")
		}
		time.Sleep(10 * time.Millisecond)
	}
	_ = two.CloseNow()
	release := readType(t, agent, "input").Input
	if release.Action != "viewportRelease" || release.ViewerID != twoID {
		t.Fatalf("wrong viewport release: %+v", release)
	}
}
