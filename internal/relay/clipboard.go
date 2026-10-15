package relay

import (
	"encoding/base64"
	"io"
	"mime"
	"net/http"
	"time"
)

const maxClipboardImage = 4 << 20

type ClipboardImage struct {
	MIME    string `json:"mime"`
	Name    string `json:"name,omitempty"`
	NodeID  string `json:"nodeId,omitempty"`
	Version string `json:"version"`
	Data    string `json:"data"`
}

func (s *Server) clipboard(w http.ResponseWriter, r *http.Request) {
	sid := r.PathValue("id")
	if origin := r.Header.Get("Origin"); origin != "" && origin != s.cfg.PublicURL {
		http.Error(w, "origin rejected", 403)
		return
	}
	authenticate := func() (*peer, *peer) {
		session, state := s.sessions[sid], s.live[sid]
		if session == nil || state == nil || !sameSecret(bearer(r), session.Key) {
			return nil, nil
		}
		for p := range state.viewers {
			if p.id == r.Header.Get("X-Viewer-ID") {
				return p, s.agents[session.AgentID]
			}
		}
		return nil, nil
	}
	s.mu.Lock()
	viewer, agent := authenticate()
	if viewer == nil || agent == nil {
		s.mu.Unlock()
		http.Error(w, "active share required", 401)
		return
	}
	if time.Since(viewer.lastClipboard) < time.Second {
		s.mu.Unlock()
		http.Error(w, "clipboard rate exceeded", 429)
		return
	}
	viewer.lastClipboard = time.Now()
	s.mu.Unlock()
	kind, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || (kind != "image/png" && kind != "image/jpeg" && kind != "image/webp" && kind != "image/gif") {
		http.Error(w, "unsupported image", 415)
		return
	}
	version, node := r.Header.Get("X-Document-Version"), r.Header.Get("X-Node-ID")
	if version == "" || len(version) > 80 || len(node) > 32 {
		http.Error(w, "invalid clipboard target", 400)
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxClipboardImage))
	if err != nil {
		http.Error(w, "image exceeds 4 MiB", 413)
		return
	}
	if len(data) == 0 || http.DetectContentType(data) != kind {
		http.Error(w, "invalid image data", 415)
		return
	}
	encoded := base64.StdEncoding.EncodeToString(data)
	s.mu.Lock()
	defer s.mu.Unlock()
	current, host := authenticate()
	if current != viewer || host != agent {
		http.Error(w, "share disconnected", 409)
		return
	}
	send(agent, Message{Type: "clipboard", SessionID: sid, Image: &ClipboardImage{MIME: kind, Name: "clipboard", NodeID: node, Version: version, Data: encoded}})
	w.WriteHeader(http.StatusAccepted)
}
