package relay

import (
	"bytes"
	"encoding/base64"
	"io"
	"net/http"
	"testing"
)

func TestClipboardRequiresActiveViewerAndForwardsOnlyBoundedImage(t *testing.T) {
	f := setup(t)
	se, _ := f.create(t, Session{AgentID: "clipboard-browser", Kind: "url", URL: "https://example.com"})
	agent := dial(t, f, "/ws/agent", Message{Type: "hello", Token: f.s.token, AgentID: se.AgentID})
	readType(t, agent, "ready")
	viewer := dial(t, f, "/ws/view/"+se.ID, Message{Type: "join", Key: se.Key})
	joined := readType(t, viewer, "joined")
	readType(t, agent, "open")
	png, _ := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jgH8AAAAASUVORK5CYII=")
	post := func(key, member string) int {
		t.Helper()
		r, _ := http.NewRequest("POST", f.http.URL+"/api/clipboard/"+se.ID, bytes.NewReader(png))
		r.Header.Set("Authorization", "Bearer "+key)
		r.Header.Set("Content-Type", "image/png")
		r.Header.Set("X-Viewer-ID", member)
		r.Header.Set("X-Document-Version", "v1")
		r.Header.Set("X-Node-ID", "3")
		response, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		io.Copy(io.Discard, response.Body)
		response.Body.Close()
		return response.StatusCode
	}
	if got := post("wrong", joined.ViewerID); got != 401 {
		t.Fatal("accepted wrong capability", got)
	}
	if got := post(se.Key, "forged"); got != 401 {
		t.Fatal("accepted a disconnected viewer", got)
	}
	if got := post(se.Key, joined.ViewerID); got != 202 {
		t.Fatal("clipboard upload failed", got)
	}
	message := readType(t, agent, "clipboard")
	if message.Image == nil || message.Image.Version != "v1" || message.Image.NodeID != "3" || message.Image.MIME != "image/png" {
		t.Fatal("lost clipboard target metadata")
	}
	data, err := base64.StdEncoding.DecodeString(message.Image.Data)
	if err != nil || !bytes.Equal(data, png) {
		t.Fatal("image bytes changed")
	}
	if got := post(se.Key, joined.ViewerID); got != 429 {
		t.Fatal("clipboard rate not bounded", got)
	}
}
