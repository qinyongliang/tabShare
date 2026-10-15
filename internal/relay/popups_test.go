package relay

import (
	"net/http"
	"testing"
)

func TestPopupPublicationAndParentRevocation(t *testing.T) {
	f := setup(t)
	parent, _ := f.create(t, Session{AgentID: "popup-agent", Kind: "url", URL: "https://example.com/"})
	child, _ := f.create(t, Session{ParentID: parent.ID, AgentID: parent.AgentID, Kind: "tab", URL: "https://example.com/child", TabID: 2, TabEpoch: "browser-epoch"})
	duplicate, _ := f.create(t, Session{ParentID: parent.ID, AgentID: parent.AgentID, Kind: "tab", URL: "https://example.com/child", TabID: 2, TabEpoch: "browser-epoch"})
	if duplicate.ID != child.ID {
		t.Fatal("duplicate browser events created duplicate shares")
	}
	grandchild, _ := f.create(t, Session{ParentID: child.ID, AgentID: parent.AgentID, Kind: "tab", URL: "https://example.com/nested", TabID: 3, TabEpoch: "browser-epoch"})
	agent := dial(t, f, "/ws/agent", Message{Type: "hello", Token: f.s.token, AgentID: parent.AgentID})
	readType(t, agent, "ready")
	viewer := dial(t, f, "/ws/view/"+parent.ID, Message{Type: "join", Key: parent.Key})
	readType(t, viewer, "joined")
	write(t, agent, Message{Type: "popup", SessionID: parent.ID, Popup: &Popup{ID: child.ID, ShareURL: "https://untrusted.example/"}})
	shown := readType(t, viewer, "popup").Popup
	if shown.ID != child.ID || shown.ShareURL != f.s.cfg.PublicURL+"/s/"+child.ID+"#"+child.Key {
		t.Fatal("popup did not use its parent-authorized share URL")
	}
	req, _ := http.NewRequest("DELETE", f.http.URL+"/api/sessions/"+parent.ID, nil)
	req.Header.Set("Authorization", "Bearer "+f.s.token)
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 204 {
		t.Fatal(response.StatusCode)
	}
	f.s.mu.Lock()
	defer f.s.mu.Unlock()
	for _, id := range []string{parent.ID, child.ID, grandchild.ID} {
		if f.s.sessions[id] != nil {
			t.Fatal("revoked parent retained child capability")
		}
	}
}
