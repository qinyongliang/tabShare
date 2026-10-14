package relay

import (
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"github.com/coder/websocket/wsjson"
	"strings"
	"testing"
	"time"
)

func TestRTCSignalingBoundToAuthenticatedViewerAndRoom(t *testing.T) {
	f := setup(t)
	se, _ := f.create(t, Session{AgentID: "browser-one", Kind: "url", URL: "https://example.com"})
	other, _ := f.create(t, Session{AgentID: "browser-two", Kind: "url", URL: "https://other.example.com"})
	a := dial(t, f, "/ws/agent", Message{Type: "hello", Token: f.s.token, AgentID: se.AgentID})
	readType(t, a, "ready")
	v := dial(t, f, "/ws/view/"+se.ID, Message{Type: "join", Key: se.Key})
	joined := readType(t, v, "joined")
	readType(t, a, "open")
	grant := readType(t, a, "peer")
	if grant.ViewerID != joined.ViewerID || grant.SessionID != se.ID {
		t.Fatal("grant must come from authenticated membership")
	}
	attempt := randomID()
	signal := &Signal{Attempt: attempt, Description: &Description{Type: "offer", SDP: "v=0\r\n"}}
	write(t, a, Message{Type: "signal", SessionID: se.ID, ViewerID: joined.ViewerID, Signal: signal})
	if readType(t, v, "signal").Signal.Attempt != attempt {
		t.Fatal("offer did not route")
	}
	signal.Description.Type = "answer"
	write(t, v, Message{Type: "signal", SessionID: other.ID, ViewerID: "spoofed-viewer", Signal: signal})
	answer := readType(t, a, "signal")
	if answer.SessionID != se.ID || answer.ViewerID != joined.ViewerID {
		t.Fatal("viewer can spoof signal identity")
	}
	// A room belonging to another browser cannot be targeted by this authenticated agent.
	write(t, a, Message{Type: "signal", SessionID: other.ID, ViewerID: joined.ViewerID, Signal: signal})
	write(t, a, Message{Type: "signal", SessionID: se.ID, ViewerID: joined.ViewerID, Signal: &Signal{Attempt: attempt, Description: &Description{Type: "offer", SDP: "sentinel"}}})
	if readType(t, v, "signal").Signal.Description.SDP != "sentinel" {
		t.Fatal("cross-room signal escaped scoping")
	}
	// Revocation closes signaling; source gets membership removal to close direct channels too.
	_ = v.CloseNow()
	if readType(t, a, "peer-left").ViewerID != joined.ViewerID {
		t.Fatal("disconnect omitted peer revocation")
	}
}
func TestDirectPeersDoNotReceiveRelayedDocumentTraffic(t *testing.T) {
	f := setup(t)
	se, _ := f.create(t, Session{AgentID: "browser-one", Kind: "url", URL: "https://example.com"})
	a := dial(t, f, "/ws/agent", Message{Type: "hello", Token: f.s.token, AgentID: se.AgentID})
	readType(t, a, "ready")
	v := dial(t, f, "/ws/view/"+se.ID, Message{Type: "join", Key: se.Key})
	joined := readType(t, v, "joined")
	readType(t, a, "open")
	write(t, a, Message{Type: "transport", SessionID: se.ID, ViewerID: joined.ViewerID, Status: "p2p"})
	write(t, a, Message{Type: "raster", SessionID: se.ID, Data: "discard", Width: 10, Height: 10, Full: true})
	write(t, a, Message{Type: "status", SessionID: se.ID, Status: "connected", Detail: "sentinel"})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		var m Message
		if err := wsjson.Read(ctx, v, &m); err != nil {
			t.Fatal(err)
		}
		if m.Type == "raster" {
			t.Fatal("direct peer received relayed pixels")
		}
		if m.Detail == "sentinel" {
			break
		}
	}
}
func TestICECredentialsAreTemporaryAndSecretNeverSent(t *testing.T) {
	secret := strings.Repeat("x", 32)
	s := &Server{cfg: Config{STUNURLs: []string{"stun:stun.example.com:3478"}, TURNURLs: []string{"turn:turn.example.com:3478?transport=udp"}, TURNSecret: secret}}
	if err := validateICE(s.cfg); err != nil {
		t.Fatal(err)
	}
	ice := s.iceServers("viewer-one")
	if len(ice) != 2 {
		t.Fatal("missing ICE servers")
	}
	mac := hmac.New(sha1.New, []byte(secret))
	_, _ = mac.Write([]byte(ice[1].Username))
	if ice[1].Credential != base64.StdEncoding.EncodeToString(mac.Sum(nil)) || ice[1].Credential == secret {
		t.Fatal("TURN REST credentials do not match")
	}
	for _, invalid := range []Config{{TURNURLs: s.cfg.TURNURLs}, {STUNURLs: []string{"https://example.com"}}, {TURNURLs: []string{"turn:user:password@example.com"}, TURNSecret: secret}} {
		if validateICE(invalid) == nil {
			t.Fatal("invalid ICE configuration accepted")
		}
	}
	if validSignal(&Signal{Attempt: randomID(), Description: &Description{Type: "rollback", SDP: "v=0"}}) || validSignal(&Signal{Attempt: "short", Candidate: &Candidate{}}) {
		t.Fatal("invalid signaling accepted")
	}
}
