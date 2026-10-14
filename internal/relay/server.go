package relay

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/qinyongliang/tabShare/web"
)

type Config struct {
	DataDir, PublicURL string
	STUNURLs, TURNURLs []string
	TURNSecret         string
}
type Session struct {
	ID       string `json:"id"`
	Key      string `json:"key"`
	AgentID  string `json:"agentId"`
	Kind     string `json:"kind"`
	URL      string `json:"url"`
	TabID    int    `json:"tabId,omitempty"`
	TabEpoch string `json:"tabEpoch,omitempty"`
	Title    string `json:"title"`
}
type Message struct {
	Type       string      `json:"type"`
	Signal     *Signal     `json:"signal,omitempty"`
	ICEServers []ICEServer `json:"iceServers,omitempty"`
	ViewerID   string      `json:"viewerId,omitempty"`
	Viewport   *Viewport   `json:"viewport,omitempty"`
	Asset      *AssetMeta  `json:"asset,omitempty"`
	Assets     []AssetMeta `json:"assets,omitempty"`
	Mode       string      `json:"mode,omitempty"`
	Dialog     *Dialog     `json:"dialog,omitempty"`
	SessionID  string      `json:"sessionId,omitempty"`
	Token      string      `json:"token,omitempty"`
	AgentID    string      `json:"agentId,omitempty"`
	Key        string      `json:"key,omitempty"`
	Session    *Session    `json:"session,omitempty"`
	Data       string      `json:"data,omitempty"`
	Width      float64     `json:"width,omitempty"`
	Height     float64     `json:"height,omitempty"`
	Status     string      `json:"status,omitempty"`
	Detail     string      `json:"detail,omitempty"`
	URL        string      `json:"url,omitempty"`
	Title      string      `json:"title,omitempty"`
	Viewers    int         `json:"viewers,omitempty"`
	Input      *Input      `json:"input,omitempty"`
	Document   *Document   `json:"document,omitempty"`
	NodeID     string      `json:"nodeId,omitempty"`
	Full       bool        `json:"full,omitempty"`
}
type Input struct {
	Action            string     `json:"action"`
	ViewerID          string     `json:"viewerId,omitempty"`
	Width             int        `json:"width,omitempty"`
	Height            int        `json:"height,omitempty"`
	DeviceScaleFactor float64    `json:"deviceScaleFactor,omitempty"`
	Mode              string     `json:"mode,omitempty"`
	DialogID          string     `json:"dialogId,omitempty"`
	Accept            bool       `json:"accept,omitempty"`
	Selection         *Selection `json:"selection,omitempty"`
	Values            []string   `json:"values,omitempty"`
	X                 float64    `json:"x,omitempty"`
	Y                 float64    `json:"y,omitempty"`
	Button            string     `json:"button,omitempty"`
	Buttons           int        `json:"buttons,omitempty"`
	ClickCount        int        `json:"clickCount,omitempty"`
	DeltaX            float64    `json:"deltaX,omitempty"`
	DeltaY            float64    `json:"deltaY,omitempty"`
	Key               string     `json:"key,omitempty"`
	Code              string     `json:"code,omitempty"`
	KeyCode           int        `json:"keyCode,omitempty"`
	Modifiers         int        `json:"modifiers,omitempty"`
	Text              string     `json:"text,omitempty"`
	URL               string     `json:"url,omitempty"`
	NodeID            string     `json:"nodeId,omitempty"`
	ScrollTop         float64    `json:"scrollTop,omitempty"`
	ScrollLeft        float64    `json:"scrollLeft,omitempty"`
}
type Viewport struct {
	Width             int     `json:"width"`
	Height            int     `json:"height"`
	DeviceScaleFactor float64 `json:"deviceScaleFactor"`
	Owner             string  `json:"owner"`
}
type Selection struct {
	Anchor       string `json:"anchor"`
	Focus        string `json:"focus"`
	AnchorOffset int    `json:"anchorOffset"`
	FocusOffset  int    `json:"focusOffset"`
	Start        int    `json:"start"`
	End          int    `json:"end"`
}
type Dialog struct {
	ID      string `json:"id"`
	Kind    string `json:"kind"`
	Message string `json:"message"`
	Default string `json:"default,omitempty"`
}
type peer struct {
	id     string
	direct bool
	conn   *websocket.Conn
	queue  chan Message
	cancel context.CancelFunc
}
type live struct {
	viewers       map[*peer]bool
	document      documentState
	status        string
	resources     map[string]*assetEntry
	resourceBytes int
	full          bool
	mode          string
	dialog        *Dialog
	viewport      *Viewport
}
type Server struct {
	mu         sync.Mutex
	cfg        Config
	token      string
	sessions   map[string]*Session
	agents     map[string]*peer
	live       map[string]*live
	assets     map[string]*assetBlob
	assetBytes int
}

var identifier = regexp.MustCompile(`^[A-Za-z0-9_-]{8,80}$`)

func randomID() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
func New(cfg Config) (*Server, error) {
	u, err := url.Parse(cfg.PublicURL)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || (u.Path != "" && u.Path != "/") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("public-url must be an HTTP(S) origin")
	}
	cfg.PublicURL = strings.TrimRight(cfg.PublicURL, "/")
	if err = validateICE(cfg); err != nil {
		return nil, err
	}
	if err = os.MkdirAll(cfg.DataDir, 0700); err != nil {
		return nil, err
	}
	path := filepath.Join(cfg.DataDir, "admin-token")
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		b = []byte(randomID() + "\n")
		f, e := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if e != nil {
			return nil, e
		}
		_, e = f.Write(b)
		closeErr := f.Close()
		if e != nil {
			return nil, e
		}
		if closeErr != nil {
			return nil, closeErr
		}
	} else if err != nil {
		return nil, err
	}
	s := &Server{assets: map[string]*assetBlob{}, cfg: cfg, token: strings.TrimSpace(string(b)), sessions: map[string]*Session{}, agents: map[string]*peer{}, live: map[string]*live{}}
	if len(s.token) < 32 {
		return nil, errors.New("pairing token is too short")
	}
	b, err = os.ReadFile(filepath.Join(cfg.DataDir, "sessions.json"))
	if err == nil {
		if err = json.Unmarshal(b, &s.sessions); err != nil {
			return nil, fmt.Errorf("read sessions: %w", err)
		}
		if s.sessions == nil {
			s.sessions = map[string]*Session{}
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	for id := range s.sessions {
		s.live[id] = &live{viewers: map[*peer]bool{}, status: "offline"}
	}
	return s, nil
}
func (s *Server) persist() error {
	b, err := json.MarshalIndent(s.sessions, "", "  ")
	if err != nil {
		return err
	}
	path := filepath.Join(s.cfg.DataDir, "sessions.json")
	if err = os.WriteFile(path+".tmp", b, 0600); err != nil {
		return err
	}
	return os.Rename(path+".tmp", path)
}
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { jsonResponse(w, 200, map[string]string{"status": "ok"}) })
	mux.HandleFunc("/api/sessions", s.api)
	mux.HandleFunc("DELETE /api/sessions/{id}", s.remove)
	mux.HandleFunc("OPTIONS /api/sessions/{id}", s.api)
	mux.HandleFunc("/api/resources/{id}/{asset}", s.resource)
	mux.HandleFunc("GET /ws/agent", s.agentWS)
	mux.HandleFunc("GET /ws/view/{id}", s.viewerWS)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			http.Error(w, "method not allowed", 405)
			return
		}
		web.Serve(w, r)
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'")
		mux.ServeHTTP(w, r)
	})
}
func jsonResponse(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func sameSecret(a, b string) bool { return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1 }
func canonical(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil {
		return "", errors.New("only HTTP(S) URLs without credentials are supported")
	}
	u.Fragment = ""
	u.Host = strings.ToLower(u.Host)
	if u.Path == "" {
		u.Path = "/"
	}
	return u.String(), nil
}
func (s *Server) api(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	if origin != "" {
		if origin != s.cfg.PublicURL && !strings.HasPrefix(origin, "chrome-extension://") {
			http.Error(w, "origin rejected", 403)
			return
		}
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Vary", "Origin")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS")
	}
	if r.Method == "OPTIONS" {
		w.WriteHeader(204)
		return
	}
	if !sameSecret(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), s.token) {
		http.Error(w, "pairing token required", 401)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if r.Method == "GET" {
		jsonResponse(w, 200, s.sessions)
		return
	}
	if r.Method != "POST" {
		http.Error(w, "method not allowed", 405)
		return
	}
	var req Session
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16384))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		http.Error(w, "invalid request", 400)
		return
	}
	if !identifier.MatchString(req.AgentID) || (req.Kind != "url" && req.Kind != "tab") || (req.Kind == "tab" && (req.TabID <= 0 || !identifier.MatchString(req.TabEpoch))) {
		http.Error(w, "invalid sharing target", 400)
		return
	}
	var err error
	req.URL, err = canonical(req.URL)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	if len(req.Title) > 512 || len(req.URL) > 8192 {
		http.Error(w, "target too long", 400)
		return
	}
	for _, old := range s.sessions {
		if old.AgentID == req.AgentID && old.Kind == req.Kind && ((req.Kind == "url" && old.URL == req.URL) || (req.Kind == "tab" && old.TabID == req.TabID && old.TabEpoch == req.TabEpoch)) {
			jsonResponse(w, 200, map[string]any{"session": old, "shareUrl": s.cfg.PublicURL + "/s/" + old.ID + "#" + old.Key})
			return
		}
	}
	if len(s.sessions) >= 1000 {
		http.Error(w, "session limit reached", 429)
		return
	}
	req.ID = randomID()
	req.Key = randomID()
	s.sessions[req.ID] = &req
	if err = s.persist(); err != nil {
		delete(s.sessions, req.ID)
		http.Error(w, "could not save session", 500)
		return
	}
	s.live[req.ID] = &live{viewers: map[*peer]bool{}, status: "waiting"}
	jsonResponse(w, 201, map[string]any{"session": &req, "shareUrl": s.cfg.PublicURL + "/s/" + req.ID + "#" + req.Key})
}
func (s *Server) remove(w http.ResponseWriter, r *http.Request) {
	if !sameSecret(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), s.token) {
		http.Error(w, "pairing token required", 401)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	id := r.PathValue("id")
	se := s.sessions[id]
	if se == nil {
		http.NotFound(w, r)
		return
	}
	delete(s.sessions, id)
	if err := s.persist(); err != nil {
		s.sessions[id] = se
		http.Error(w, "could not revoke session", 500)
		return
	}
	if a := s.agents[se.AgentID]; a != nil {
		send(a, Message{Type: "pause", SessionID: id})
	}
	for p := range s.live[id].viewers {
		p.cancel()
		_ = p.conn.CloseNow()
	}
	s.clearAssets(s.live[id])
	// Keep the live object until existing viewer cleanup has finished.
	w.WriteHeader(204)
}
func (s *Server) accept(w http.ResponseWriter, r *http.Request, agent bool) (*websocket.Conn, error) {
	origin := r.Header.Get("Origin")
	if agent {
		if origin != "" && !strings.HasPrefix(origin, "chrome-extension://") {
			http.Error(w, "origin rejected", 403)
			return nil, errors.New("origin rejected")
		}
	} else {
		if origin != "" && origin != s.cfg.PublicURL {
			http.Error(w, "origin rejected", 403)
			return nil, errors.New("origin rejected")
		}
	}
	// Origin is checked above against the configured external origin, including behind TLS proxies.
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true, CompressionMode: websocket.CompressionDisabled})
	if err == nil {
		if agent {
			c.SetReadLimit(4 << 20)
		} else {
			c.SetReadLimit(131072)
		}
	}
	return c, err
}
func first(c *websocket.Conn, r *http.Request) (Message, error) {
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	var m Message
	err := wsjson.Read(ctx, c, &m)
	return m, err
}
func newPeer(c *websocket.Conn, r *http.Request) *peer {
	ctx, cancel := context.WithCancel(r.Context())
	p := &peer{id: randomID(), conn: c, queue: make(chan Message, 32), cancel: cancel}
	go func() {
		defer cancel()
		defer c.CloseNow()
		ticker := time.NewTicker(20 * time.Second)
		defer ticker.Stop()
		for {
			var m Message
			select {
			case <-ctx.Done():
				return
			case m = <-p.queue:
			case <-ticker.C:
				m = Message{Type: "ping"}
			}
			writeCtx, done := context.WithTimeout(ctx, 5*time.Second)
			err := wsjson.Write(writeCtx, c, m)
			done()
			if err != nil {
				return
			}
		}
	}()
	return p
}
func send(p *peer, m Message) {
	select {
	case p.queue <- m:
	default:
		// Slow consumers reconnect with a fresh DOM state instead of losing deltas or input.
		p.cancel()
		_ = p.conn.CloseNow()
	}
}
func (s *Server) broadcast(id string, m Message) {
	for p := range s.live[id].viewers {
		if p.direct && (m.Type == "dom" || m.Type == "raster" || m.Type == "resource" || m.Type == "resources") {
			continue
		}
		send(p, m)
	}
}
func safeSession(s *Session) *Session { copy := *s; copy.Key = ""; return &copy }
func (s *Server) agentWS(w http.ResponseWriter, r *http.Request) {
	c, err := s.accept(w, r, true)
	if err != nil {
		return
	}
	defer c.CloseNow()
	m, err := first(c, r)
	if err != nil || m.Type != "hello" || !sameSecret(m.Token, s.token) || !identifier.MatchString(m.AgentID) {
		_ = c.Close(websocket.StatusPolicyViolation, "invalid agent credentials")
		return
	}
	id := m.AgentID
	p := newPeer(c, r)
	defer p.cancel()
	s.mu.Lock()
	if old := s.agents[id]; old != nil {
		old.cancel()
		_ = old.conn.CloseNow()
	}
	s.agents[id] = p
	send(p, Message{Type: "ready"})
	for sid, session := range s.sessions {
		if session.AgentID == id && len(s.live[sid].viewers) > 0 {
			send(p, Message{Type: "open", Session: safeSession(session)})
			for viewer := range s.live[sid].viewers {
				viewer.direct = false
				send(p, Message{Type: "peer", SessionID: sid, ViewerID: viewer.id, ICEServers: s.iceServers(viewer.id)})
			}
		}
	}
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.agents[id] != p {
			return
		}
		delete(s.agents, id)
		for sid, se := range s.sessions {
			if se.AgentID == id {
				s.clearAssets(s.live[sid])
				s.live[sid].dialog = nil
				s.live[sid].viewport = nil
				s.broadcast(sid, Message{Type: "viewport"})
				s.live[sid].document = documentState{}
				s.live[sid].status = "offline"
				s.broadcast(sid, Message{Type: "status", Status: "offline", Detail: "共享浏览器已断开，正在等待自动重连"})
			}
		}
	}()
	for {
		var m Message
		if err = wsjson.Read(r.Context(), c, &m); err != nil {
			return
		}
		if m.Type == "pong" {
			continue
		}
		s.mu.Lock()
		se := s.sessions[m.SessionID]
		if s.agents[id] != p {
			s.mu.Unlock()
			return
		}
		if se == nil || se.AgentID != id {
			s.mu.Unlock()
			continue
		}
		switch m.Type {
		case "signal":
			if validSignal(m.Signal) {
				for viewer := range s.live[se.ID].viewers {
					if viewer.id == m.ViewerID {
						send(viewer, Message{Type: "signal", Signal: m.Signal})
						break
					}
				}
			}
		case "transport":
			for viewer := range s.live[se.ID].viewers {
				if viewer.id == m.ViewerID {
					viewer.direct = m.Status == "p2p"
					break
				}
			}
		case "raster":
			if m.Width > 0 && m.Width <= 16384 && m.Height > 0 && m.Height <= 16384 && len(m.Data) < 2<<20 && len(m.NodeID) <= 32 {
				s.broadcast(se.ID, Message{Type: "raster", Data: m.Data, Width: m.Width, Height: m.Height, NodeID: m.NodeID, Full: m.Full})
			}
		case "viewport":
			if m.Viewport == nil || (validViewport(m.Viewport.Width, m.Viewport.Height, m.Viewport.DeviceScaleFactor) && identifier.MatchString(m.Viewport.Owner)) {
				s.live[se.ID].viewport = m.Viewport
				s.broadcast(se.ID, Message{Type: "viewport", Viewport: m.Viewport})
			}
		case "mode":
			if m.Mode == "dom" || m.Mode == "raster" {
				s.live[se.ID].mode = m.Mode
			}
			s.live[se.ID].full = m.Full
			s.broadcast(se.ID, Message{Type: "mode", Full: m.Full, Mode: s.live[se.ID].mode})
		case "dialog":
			if m.Dialog == nil || (identifier.MatchString(m.Dialog.ID) && len(m.Dialog.Message) <= 8192 && len(m.Dialog.Default) <= 8192) {
				s.live[se.ID].dialog = m.Dialog
				s.broadcast(se.ID, Message{Type: "dialog", Dialog: m.Dialog})
			}
		case "dom":
			if len(s.live[se.ID].viewers) == 0 {
				break
			}
			if err := s.live[se.ID].document.apply(m.Document); err == nil {
				if m.Document.Reset {
					s.pruneAssets(s.live[se.ID], m.Document.Version)
				}
				out := Message{Type: "dom", Document: m.Document}
				s.live[se.ID].status = "connected"
				s.broadcast(se.ID, out)
			} else {
				send(p, Message{Type: "resync", SessionID: se.ID})
			}
		case "status":
			if len(m.Detail) <= 1024 && len(m.URL) <= 8192 && len(m.Title) <= 512 {
				s.live[se.ID].status = m.Status
				if m.Status != "connected" {
					s.live[se.ID].document = documentState{}
				}
				s.broadcast(se.ID, Message{Type: "status", Status: m.Status, Detail: m.Detail, URL: m.URL, Title: m.Title})
			}
		}
		s.mu.Unlock()
	}
}
func (s *Server) viewerWS(w http.ResponseWriter, r *http.Request) {
	c, err := s.accept(w, r, false)
	if err != nil {
		return
	}
	defer c.CloseNow()
	m, err := first(c, r)
	id := r.PathValue("id")
	s.mu.Lock()
	se := s.sessions[id]
	if err != nil || m.Type != "join" || se == nil || !sameSecret(m.Key, se.Key) {
		s.mu.Unlock()
		_ = c.Close(websocket.StatusPolicyViolation, "invalid share link")
		return
	}
	l := s.live[id]
	if len(l.viewers) >= 32 {
		s.mu.Unlock()
		_ = c.Close(websocket.StatusTryAgainLater, "viewer limit reached")
		return
	}
	p := newPeer(c, r)
	defer p.cancel()
	l.viewers[p] = true
	send(p, Message{Type: "joined", ViewerID: p.id, ICEServers: s.iceServers(p.id)})
	send(p, Message{Type: "viewport", Viewport: l.viewport})
	s.broadcast(id, Message{Type: "viewers", Viewers: len(l.viewers)})
	send(p, Message{Type: "status", Status: l.status, URL: se.URL, Title: se.Title})
	assets := make([]AssetMeta, 0, len(l.resources))
	for _, a := range l.resources {
		assets = append(assets, a.AssetMeta)
	}
	send(p, Message{Type: "resources", Assets: assets})
	send(p, Message{Type: "mode", Full: l.full, Mode: l.mode})
	if l.dialog != nil {
		send(p, Message{Type: "dialog", Dialog: l.dialog})
	}
	if doc := l.document.snapshot(); doc != nil {
		send(p, Message{Type: "dom", Document: doc})
	}
	if agent := s.agents[se.AgentID]; agent != nil {
		send(agent, Message{Type: "open", Session: safeSession(se)})
		send(agent, Message{Type: "peer", SessionID: id, ViewerID: p.id, ICEServers: s.iceServers(p.id)})
	} else {
		send(p, Message{Type: "status", Status: "offline", Detail: "等待共享浏览器连接"})
	}
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		delete(l.viewers, p)
		if a := s.agents[se.AgentID]; a != nil {
			send(a, Message{Type: "peer-left", SessionID: id, ViewerID: p.id})
		}
		if l.viewport != nil && l.viewport.Owner == p.id {
			l.viewport = nil
			s.broadcast(id, Message{Type: "viewport"})
			if a := s.agents[se.AgentID]; a != nil {
				send(a, Message{Type: "input", SessionID: id, Input: &Input{Action: "viewportRelease", ViewerID: p.id}})
			}
		}
		s.broadcast(id, Message{Type: "viewers", Viewers: len(l.viewers)})
		if len(l.viewers) == 0 {
			l.document = documentState{}
			s.clearAssets(l)
			l.dialog = nil
			if a := s.agents[se.AgentID]; a != nil {
				send(a, Message{Type: "pause", SessionID: id})
			}
		}
	}()
	tokens := float64(200)
	last := time.Now()
	for {
		var m Message
		if err = wsjson.Read(r.Context(), c, &m); err != nil {
			return
		}
		if m.Type == "pong" {
			continue
		}
		now := time.Now()
		tokens += now.Sub(last).Seconds() * 120
		if tokens > 200 {
			tokens = 200
		}
		last = now
		tokens--
		if tokens < 0 {
			_ = c.Close(websocket.StatusPolicyViolation, "too many commands")
			return
		}
		if m.Type == "signal" && validSignal(m.Signal) {
			s.mu.Lock()
			if a := s.agents[se.AgentID]; a != nil {
				send(a, Message{Type: "signal", SessionID: id, ViewerID: p.id, Signal: m.Signal})
			}
			s.mu.Unlock()
			continue
		}
		if m.Type == "resync" {
			s.mu.Lock()
			if a := s.agents[se.AgentID]; a != nil {
				send(a, Message{Type: "resync", SessionID: id})
			}
			s.mu.Unlock()
			continue
		}
		if m.Type != "retry" && (m.Type != "input" || !validInput(m.Input)) {
			continue
		}
		s.mu.Lock()
		if a := s.agents[se.AgentID]; a != nil {
			if m.Type == "retry" {
				send(a, Message{Type: "open", Session: safeSession(se)})
			} else {
				if m.Input.Action == "viewport" || m.Input.Action == "restoreViewport" {
					m.Input.ViewerID = p.id
				}
				send(a, Message{Type: "input", SessionID: id, Input: m.Input})
			}
		}
		s.mu.Unlock()
	}
}
func validInput(i *Input) bool {
	if i == nil || i.Modifiers < 0 || i.Modifiers > 15 || len(i.Text) > 8192 || len(i.Key) > 64 || len(i.Code) > 64 || len(i.NodeID) > 32 {
		return false
	}
	if i.Selection != nil {
		v := i.Selection
		if len(v.Anchor) > 32 || len(v.Focus) > 32 || v.AnchorOffset < 0 || v.FocusOffset < 0 || v.Start < 0 || v.End < 0 || v.AnchorOffset > 100000 || v.FocusOffset > 100000 || v.Start > 100000 || v.End > 100000 {
			return false
		}
	}
	switch i.Action {
	case "mouseMoved", "mousePressed", "mouseReleased", "mouseWheel":
		if i.Button != "" && i.Button != "none" && i.Button != "left" && i.Button != "right" && i.Button != "middle" {
			return false
		}
		return i.X >= 0 && i.X <= 16384 && i.Y >= 0 && i.Y <= 16384 && i.Buttons >= 0 && i.Buttons <= 7 && i.ClickCount >= 0 && i.ClickCount <= 3 && i.DeltaX >= -10000 && i.DeltaX <= 10000 && i.DeltaY >= -10000 && i.DeltaY <= 10000
	case "keyDown", "keyUp":
		return i.KeyCode >= 0 && i.KeyCode <= 255
	case "text":
		return i.Text != ""
	case "scroll":
		return i.NodeID != "" && i.ScrollTop >= 0 && i.ScrollTop <= 10000000 && i.ScrollLeft >= 0 && i.ScrollLeft <= 10000000
	case "select":
		if len(i.Values) > 128 {
			return false
		}
		n := 0
		for _, v := range i.Values {
			n += len(v)
		}
		return i.NodeID != "" && n <= 8192
	case "mode":
		return i.Mode == "dom" || i.Mode == "raster"
	case "selection":
		return i.NodeID != "" && i.Selection != nil
	case "dialog":
		return identifier.MatchString(i.DialogID)
	case "closePopup":
		return true
	case "viewport":
		return validViewport(i.Width, i.Height, i.DeviceScaleFactor)
	case "restoreViewport":
		return true
	case "navigate":
		_, err := canonical(i.URL)
		return err == nil && len(i.URL) <= 8192
	case "reload", "back", "forward":
		return true
	}
	return false
}
func validViewport(width, height int, dpr float64) bool {
	return width >= 320 && width <= 3840 && height >= 240 && height <= 2160 && !math.IsNaN(dpr) && !math.IsInf(dpr, 0) && dpr >= 1 && dpr <= 2 && float64(width)*dpr <= 4096 && float64(height)*dpr <= 4096 && float64(width)*float64(height)*dpr*dpr <= 8294400
}
func (s *Server) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, p := range s.agents {
		p.cancel()
		_ = p.conn.CloseNow()
	}
	for _, l := range s.live {
		s.clearAssets(l)
		for p := range l.viewers {
			p.cancel()
			_ = p.conn.CloseNow()
		}
	}
}
