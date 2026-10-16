package relay

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"github.com/coder/websocket/wsjson"
	"testing"
	"time"
)

func TestDownloadBoundariesAndRecipientIsolation(t *testing.T) {
	f := setup(t)
	se, _ := f.create(t, Session{AgentID: "download-browser", Kind: "url", URL: "https://example.com"})
	agent := dial(t, f, "/ws/agent", Message{Type: "hello", Token: f.s.token, AgentID: se.AgentID})
	readType(t, agent, "ready")
	one := dial(t, f, "/ws/view/"+se.ID, Message{Type: "join", Key: se.Key})
	joined := readType(t, one, "joined")
	readType(t, agent, "open")
	two := dial(t, f, "/ws/view/"+se.ID, Message{Type: "join", Key: se.Key})
	readType(t, two, "joined")
	bytes := []byte("file bytes")
	hash := sha256.Sum256(bytes)
	chunk := &DownloadChunk{ID: "download-123", Name: "report.txt", MIME: "text/plain", Data: base64.StdEncoding.EncodeToString(bytes), SHA256: hex.EncodeToString(hash[:]), Done: true}
	if !validDownload(chunk) {
		t.Fatal("valid chunk rejected")
	}
	write(t, agent, Message{Type: "download", SessionID: se.ID, ViewerID: joined.ViewerID, Download: chunk})
	received := readType(t, one, "download")
	if received.Download == nil || received.Download.Data != chunk.Data {
		t.Fatal("download bytes changed")
	}
	write(t, agent, Message{Type: "notice", SessionID: se.ID, Detail: "after-download"})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	for {
		var message Message
		if err := wsjson.Read(ctx, two, &message); err != nil {
			t.Fatal(err)
		}
		if message.Type == "download" {
			t.Fatal("download leaked to another viewer")
		}
		if message.Type == "notice" {
			break
		}
	}
	chunk.Offset = 64 << 20
	if !validDownload(chunk) {
		t.Fatal("rejected streaming file beyond 64 MiB")
	}
	chunk.Offset = 1<<53 - 1
	if validDownload(chunk) {
		t.Fatal("accepted unsafe offset overflow")
	}
	chunk.Offset = -1
	if validDownload(chunk) {
		t.Fatal("accepted negative offset")
	}
	chunk.Offset = 0
	chunk.Data = "invalid base64!"
	if validDownload(chunk) {
		t.Fatal("accepted malformed binary")
	}
}
