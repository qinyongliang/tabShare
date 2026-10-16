package relay

import (
	"bytes"
	"io"
	"net/http"
	"testing"
)

func TestResourcesAreScopedImmutableAndReleased(t *testing.T) {
	f := setup(t)
	one, _ := f.create(t, Session{AgentID: "resource-agent", Kind: "url", URL: "https://example.com/"})
	other, _ := f.create(t, Session{AgentID: "resource-agent", Kind: "url", URL: "https://example.com/other"})
	viewer := dial(t, f, "/ws/view/"+one.ID, Message{Type: "join", Key: one.Key})
	readType(t, viewer, "resources")
	// Bytes can only be uploaded by the owner and read with this room's capability.
	request := func(method, key, mime, data string) int {
		t.Helper()
		r, _ := http.NewRequest(method, f.http.URL+"/api/resources/"+one.ID+"/image-1", bytes.NewBufferString(data))
		r.Header.Set("Authorization", "Bearer "+key)
		r.Header.Set("Content-Type", mime)
		response, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		_, _ = io.Copy(io.Discard, response.Body)
		return response.StatusCode
	}
	if got := request("POST", one.Key, "image/png", "image bytes"); got != 401 {
		t.Fatal(got)
	}
	if got := request("POST", f.s.token, "text/html", "<script>bad()</script>"); got != 415 {
		t.Fatal(got)
	}
	if got := request("POST", f.s.token, "image/png", "image bytes"); got != 201 {
		t.Fatal(got)
	}
	meta := readType(t, viewer, "resource").Asset
	if meta == nil || meta.Size != 11 {
		t.Fatal(meta)
	}
	if got := request("GET", other.Key, "", ""); got != 401 {
		t.Fatal(got)
	}
	if got := request("GET", one.Key, "", ""); got != 200 {
		t.Fatal(got)
	}
	if got := request("POST", f.s.token, "image/png", "changed"); got != 409 {
		t.Fatal(got)
	}
	if got := request("POST", f.s.token, "image/png", "image bytes"); got != 200 {
		t.Fatal(got)
	}
	late := dial(t, f, "/ws/view/"+one.ID, Message{Type: "join", Key: one.Key})
	list := readType(t, late, "resources")
	if len(list.Assets) != 1 || list.Assets[0].SHA256 != meta.SHA256 {
		t.Fatal(list)
	}
	f.s.mu.Lock()
	f.s.clearAssets(f.s.live[one.ID])
	if f.s.assetBytes != 0 || len(f.s.assets) != 0 {
		t.Error("resource bytes retained")
	}
	f.s.mu.Unlock()
	if got := request("GET", one.Key, "", ""); got != 404 {
		t.Fatal(got)
	}
}

func TestCompatibilityInputValidation(t *testing.T) {
	if !validInput(&Input{Action: "mouseLeave"}) || validInput(&Input{Action: "mouseLeave", NodeID: "3"}) {
		t.Fatal("invalid mouse leave validation")
	}
	for _, input := range []*Input{{Action: "mode", Mode: "dom"}, {Action: "mode", Mode: "raster"}, {Action: "history", EntryID: 42}, {Action: "dialog", DialogID: randomID()}, {Action: "selection", NodeID: "3", Selection: &Selection{Anchor: "4", Focus: "5", AnchorOffset: 1, FocusOffset: 2}}} {
		if !validInput(input) {
			t.Errorf("rejected %+v", input)
		}
	}
	for _, input := range []*Input{{Action: "mode", Mode: "javascript"}, {Action: "mode", Mode: "unknown"}, {Action: "history", EntryID: 0}, {Action: "history", EntryID: -1}, {Action: "history", EntryID: 2147483648}, {Action: "dialog", DialogID: "invalid"}, {Action: "selection", NodeID: "3", Selection: &Selection{AnchorOffset: -1}}, {Action: "select", NodeID: "3", Values: make([]string, 129)}} {
		if validInput(input) {
			t.Errorf("accepted %+v", input)
		}
	}
}
