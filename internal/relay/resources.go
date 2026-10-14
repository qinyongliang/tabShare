package relay

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"mime"
	"net/http"
	"regexp"
	"strings"
)

const maxAssetSize = 8 << 20
const maxAssetMemory = 128 << 20

type AssetMeta struct {
	ID     string `json:"id"`
	MIME   string `json:"mime"`
	Size   int    `json:"size"`
	SHA256 string `json:"sha256"`
}
type assetBlob struct {
	data []byte
	refs int
}
type assetEntry struct {
	AssetMeta
	blob *assetBlob
}

var assetID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,100}$`)
var assetMIMEs = map[string]bool{"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true, "image/avif": true, "image/svg+xml": true, "image/bmp": true, "image/x-icon": true, "font/woff": true, "font/woff2": true, "font/ttf": true, "font/otf": true, "application/font-woff": true}

func (s *Server) resource(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	if origin != "" {
		if origin != s.cfg.PublicURL && !extensionOrigin(origin) {
			http.Error(w, "origin rejected", 403)
			return
		}
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Vary", "Origin")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	}
	if r.Method == "OPTIONS" {
		w.WriteHeader(204)
		return
	}
	sid, id := r.PathValue("id"), r.PathValue("asset")
	if !assetID.MatchString(id) {
		http.Error(w, "invalid resource", 400)
		return
	}
	token := bearer(r)
	s.mu.Lock()
	session := s.sessions[sid]
	state := s.live[sid]
	if session == nil || state == nil {
		s.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	if r.Method == "GET" {
		if !sameSecret(token, session.Key) {
			s.mu.Unlock()
			http.Error(w, "share key required", 401)
			return
		}
		entry := state.resources[id]
		if entry == nil {
			s.mu.Unlock()
			http.NotFound(w, r)
			return
		}
		meta, data := entry.AssetMeta, entry.blob.data
		s.mu.Unlock()
		w.Header().Set("Content-Type", meta.MIME)
		w.Header().Set("ETag", `"`+meta.SHA256+`"`)
		w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
		w.Header().Set("Content-Disposition", "attachment")
		_, _ = w.Write(data)
		return
	}
	if r.Method != "POST" {
		s.mu.Unlock()
		http.Error(w, "method not allowed", 405)
		return
	}
	if !sameSecret(token, s.token) {
		s.mu.Unlock()
		http.Error(w, "pairing token required", 401)
		return
	}
	s.mu.Unlock()
	kind, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || !assetMIMEs[kind] {
		http.Error(w, "unsupported resource type", 415)
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxAssetSize))
	if err != nil {
		http.Error(w, "resource exceeds 8 MiB limit", 413)
		return
	}
	if len(data) == 0 {
		http.Error(w, "empty resource", 400)
		return
	}
	sum := sha256.Sum256(data)
	hash := hex.EncodeToString(sum[:])
	meta := AssetMeta{ID: id, MIME: kind, Size: len(data), SHA256: hash}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sessions[sid] != session || len(state.viewers) == 0 {
		http.Error(w, "share is no longer active", 409)
		return
	}
	if old := state.resources[id]; old != nil {
		if old.SHA256 != hash || old.MIME != kind {
			http.Error(w, "resource identity is immutable", 409)
			return
		}
		jsonResponse(w, 200, old.AssetMeta)
		return
	}
	if len(state.resources) >= 256 || state.resourceBytes+len(data) > 32<<20 {
		http.Error(w, "session resource budget exceeded", 413)
		return
	}
	blob := s.assets[hash]
	if blob == nil {
		if s.assetBytes+len(data) > maxAssetMemory {
			http.Error(w, "server resource budget exceeded", 503)
			return
		}
		blob = &assetBlob{data: data}
		s.assets[hash] = blob
		s.assetBytes += len(data)
	}
	blob.refs++
	if state.resources == nil {
		state.resources = map[string]*assetEntry{}
	}
	state.resources[id] = &assetEntry{AssetMeta: meta, blob: blob}
	state.resourceBytes += len(data)
	s.broadcast(sid, Message{Type: "resource", Asset: &meta})
	jsonResponse(w, 201, meta)
}
func (s *Server) clearAssets(state *live) {
	for _, entry := range state.resources {
		entry.blob.refs--
		if entry.blob.refs == 0 {
			delete(s.assets, entry.SHA256)
			s.assetBytes -= len(entry.blob.data)
		}
	}
	state.resources = nil
	state.resourceBytes = 0
}
func bearer(r *http.Request) string {
	value := r.Header.Get("Authorization")
	if len(value) > 7 && value[:7] == "Bearer " {
		return value[7:]
	}
	return ""
}

func extensionOrigin(origin string) bool { return strings.HasPrefix(origin, "chrome-extension://") }

// Drop old navigation resources without racing uploads for the new document.
func (s *Server) pruneAssets(state *live, version string) {
	for id, entry := range state.resources {
		if strings.HasPrefix(id, version+"_") {
			continue
		}
		entry.blob.refs--
		if entry.blob.refs == 0 {
			delete(s.assets, entry.SHA256)
			s.assetBytes -= len(entry.blob.data)
		}
		state.resourceBytes -= entry.Size
		delete(state.resources, id)
	}
}
