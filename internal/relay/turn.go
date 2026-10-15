package relay

import (
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/turn/v4"
)

// TURNConfig enables an IPv4 UDP/TCP TURN listener in the same process as HTTP.
// A blank Listen leaves TURN disabled. Ports must be forwarded without translation.
type TURNConfig struct {
	Listen, PublicIP, RelayIP, Host string
	MinPort, MaxPort                int
	TLSListen, CertFile, KeyFile    string
	AllowPrivatePeers               bool
	MaxMbps                         int
}

func prepareTURN(cfg *Config) error {
	c := &cfg.BuiltinTURN
	if c.MaxMbps == 0 {
		c.MaxMbps = 50
	}
	if c.MaxMbps < 1 || c.MaxMbps > 100000 {
		return errors.New("turn-max-mbps must be between 1 and 100000")
	}
	if c.Listen == "" {
		if c.TLSListen != "" {
			return errors.New("turn-tls-listen requires turn-listen")
		}
		return nil
	}
	host, port, err := net.SplitHostPort(c.Listen)
	n, e := strconv.Atoi(port)
	if err != nil || e != nil || n < 1 || n > 65535 {
		return errors.New("turn-listen must be an IPv4 host:port with a nonzero port")
	}
	if host != "" && (net.ParseIP(host) == nil || net.ParseIP(host).To4() == nil) {
		return errors.New("TURN listen host must be an IPv4 address")
	}
	if c.PublicIP == "" {
		name := c.Host
		if name == "" {
			u, _ := url.Parse(cfg.PublicURL)
			name = u.Hostname()
		}
		c.PublicIP, err = detectTURNIP(name, net.DefaultResolver.LookupIP)
		if err != nil {
			return err
		}
		if c.Host == "" {
			c.Host = name
		}
	}
	ip := net.ParseIP(c.PublicIP)
	if ip == nil || ip.To4() == nil || ip.IsUnspecified() || ip.IsMulticast() {
		return errors.New("turn-public-ip must be a concrete IPv4 address")
	}
	if c.RelayIP == "" {
		c.RelayIP = host
		if c.RelayIP == "" {
			c.RelayIP = "0.0.0.0"
		}
	}
	if net.ParseIP(c.RelayIP) == nil || net.ParseIP(c.RelayIP).To4() == nil {
		return errors.New("turn-relay-ip must be an IPv4 address")
	}
	if c.MinPort == 0 && c.MaxPort == 0 {
		c.MinPort = 49160
		c.MaxPort = 49359
	}
	if c.MinPort < 1024 || c.MaxPort > 65535 || c.MaxPort < c.MinPort || c.MaxPort-c.MinPort > 4095 {
		return errors.New("TURN relay range must contain 1–4096 ports between 1024 and 65535")
	}
	if n >= c.MinPort && n <= c.MaxPort {
		return errors.New("TURN listen port overlaps relay range")
	}
	if c.Host == "" {
		c.Host = c.PublicIP
	}
	if strings.ContainsAny(c.Host, "/:@?#[] \t\r\n") || len(c.Host) > 253 {
		return errors.New("turn-host must be an IPv4 address or DNS hostname")
	}
	urls := []string{"turn:" + net.JoinHostPort(c.Host, port) + "?transport=udp", "turn:" + net.JoinHostPort(c.Host, port) + "?transport=tcp"}
	if c.TLSListen != "" {
		th, tp, err := net.SplitHostPort(c.TLSListen)
		tn, te := strconv.Atoi(tp)
		if err != nil || te != nil || tn < 1 || tn > 65535 || (th != "" && (net.ParseIP(th) == nil || net.ParseIP(th).To4() == nil)) || tn >= c.MinPort && tn <= c.MaxPort {
			return errors.New("invalid TURN TLS listener or overlapping relay range")
		}
		if c.CertFile == "" || c.KeyFile == "" {
			return errors.New("TURN TLS requires certificate and key paths")
		}
		if _, err = tls.LoadX509KeyPair(c.CertFile, c.KeyFile); err != nil {
			return errors.New("cannot load TURN TLS certificate and key")
		}
		urls = append(urls, "turns:"+net.JoinHostPort(c.Host, tp)+"?transport=tcp")
	}
	if cfg.TURNSecret == "" {
		path := filepath.Join(cfg.DataDir, "turn-secret")
		if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
			f, e := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
			if e != nil && !errors.Is(e, os.ErrExist) {
				return e
			}
			if e == nil {
				_, e = f.WriteString(randomID() + "\n")
				ce := f.Close()
				if e != nil {
					return e
				}
				if ce != nil {
					return ce
				}
			}
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		cfg.TURNSecret = strings.TrimSpace(string(b))
	}
	if len(cfg.TURNSecret) < 32 {
		return errors.New("TURN shared secret must contain at least 32 characters")
	}
	if len(cfg.TURNURLs) == 0 {
		cfg.TURNURLs = urls
	}
	ownSTUN := "stun:" + net.JoinHostPort(c.Host, port)
	if len(cfg.STUNURLs) == 0 || cfg.STUNURLs[0] != ownSTUN {
		cfg.STUNURLs = append([]string{ownSTUN}, cfg.STUNURLs...)
	}
	return nil
}

// Infer the relay address from the deployment's DNS, without an external IP service.
// Multiple A records need an explicit address to avoid advertising the wrong host.
func detectTURNIP(host string, lookup func(context.Context, string, string) ([]net.IP, error)) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ips, err := lookup(ctx, "ip4", host)
	if err != nil {
		return "", fmt.Errorf("cannot resolve TURN IPv4 from %s; check DNS or set turn-public-ip: %w", host, err)
	}
	unique := map[string]bool{}
	address := ""
	for _, ip := range ips {
		if v := ip.To4(); v != nil {
			address = v.String()
			unique[address] = true
		}
	}
	if len(unique) != 1 {
		return "", fmt.Errorf("%s must resolve to exactly one TURN IPv4; set turn-public-ip for custom routing", host)
	}
	return address, nil
}

// Peer filtering applies to CreatePermission/ChannelBind and the relay socket itself.
// Explicit private-peer opt-in is needed for LAN deployments and loopback tests.
func turnPeerAllowed(ip net.IP, private bool) bool {
	v := ip.To4()
	if v == nil || !v.IsGlobalUnicast() {
		return private && ip.IsLoopback()
	}
	if private {
		return true
	}
	if v.IsPrivate() || v.IsLinkLocalUnicast() || v[0] == 0 || v[0] == 127 || v[0] >= 224 || v[0] == 100 && v[1] >= 64 && v[1] <= 127 || v[0] == 198 && (v[1] == 18 || v[1] == 19) || v[0] == 192 && v[1] == 0 && v[2] == 0 {
		return false
	}
	return true
}

type builtinTURN struct {
	mu            sync.Mutex
	server        *turn.Server
	owner         *Server
	cfg           TURNConfig
	realm         string
	closed        bool
	receivedBytes atomic.Uint64
	sentBytes     atomic.Uint64
	droppedBytes  atomic.Uint64
	bandwidth     *byteBudget
	relays        map[int]*turnPacket
	users         map[string]int
	pending       map[string]turnPending
	connections   map[*turnConn]struct{}
	listeners     []net.Listener
	udp           net.PacketConn
}
type turnPending struct {
	user string
	at   time.Time
}
type turnPacket struct {
	net.PacketConn
	manager *builtinTURN
	port    int
	user    string
	once    sync.Once
}

func (p *turnPacket) Close() error {
	var err error
	p.once.Do(func() {
		err = p.PacketConn.Close()
		m := p.manager
		m.mu.Lock()
		delete(m.relays, p.port)
		if p.user != "" {
			m.users[p.user]--
			if m.users[p.user] == 0 {
				delete(m.users, p.user)
			}
		}
		m.mu.Unlock()
	})
	return err
}
func (p *turnPacket) WriteTo(b []byte, a net.Addr) (int, error) {
	u, ok := a.(*net.UDPAddr)
	if !ok || !turnPeerAllowed(u.IP, p.manager.cfg.AllowPrivatePeers) {
		return 0, errors.New("TURN peer address denied")
	}
	if !p.manager.bandwidth.allow(len(b), time.Now()) {
		p.manager.droppedBytes.Add(uint64(len(b)))
		return len(b), nil
	}
	n, err := p.PacketConn.WriteTo(b, a)
	p.manager.sentBytes.Add(uint64(n))
	return n, err
}

func (p *turnPacket) ReadFrom(b []byte) (int, net.Addr, error) {
	for {
		n, a, err := p.PacketConn.ReadFrom(b)
		p.manager.receivedBytes.Add(uint64(n))
		if err != nil || p.manager.bandwidth.allow(n, time.Now()) {
			return n, a, err
		}
		p.manager.droppedBytes.Add(uint64(n))
	}
}

type turnGenerator struct{ m *builtinTURN }

func (g *turnGenerator) Validate() error { return nil }
func (g *turnGenerator) AllocateConn(string, int) (net.Conn, net.Addr, error) {
	return nil, nil, errors.New("TCP relay allocations are unsupported; use UDP relay over TURN/TCP")
}
func (g *turnGenerator) AllocatePacketConn(network string, requested int) (net.PacketConn, net.Addr, error) {
	m := g.m
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || len(m.relays) >= 256 {
		return nil, nil, errors.New("TURN allocation limit")
	}
	if network != "udp4" || requested != 0 && (requested < m.cfg.MinPort || requested > m.cfg.MaxPort) {
		return nil, nil, errors.New("TURN relay port outside configured range")
	}
	count := m.cfg.MaxPort - m.cfg.MinPort + 1
	for i := 0; i < count; i++ {
		port := m.cfg.MinPort + i
		if requested != 0 {
			port = requested
		}
		if m.relays[port] == nil {
			conn, err := net.ListenPacket("udp4", net.JoinHostPort(m.cfg.RelayIP, strconv.Itoa(port)))
			if err == nil {
				p := &turnPacket{PacketConn: conn, manager: m, port: port}
				m.relays[port] = p
				return p, &net.UDPAddr{IP: net.ParseIP(m.cfg.PublicIP), Port: port}, nil
			}
		}
		if requested != 0 {
			break
		}
	}
	return nil, nil, errors.New("TURN relay ports exhausted")
}
func turnSource(a net.Addr) string { return fmt.Sprintf("%T/%s", a, a.String()) }
func (m *builtinTURN) quota(username, realm string, src net.Addr) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	pending := 0
	for k, p := range m.pending {
		if now.Sub(p.at) > 10*time.Second {
			delete(m.pending, k)
		} else if p.user == username {
			pending++
		}
	}
	if m.closed || realm != m.realm || m.users[username]+pending >= 8 || len(m.relays)+len(m.pending) >= 256 {
		return false
	}
	m.pending[turnSource(src)] = turnPending{user: username, at: now}
	return true
}
func (m *builtinTURN) allocated(src, dst net.Addr, protocol, username, realm string, addr net.Addr, _ int) {
	a, ok := addr.(*net.UDPAddr)
	if !ok {
		return
	}
	m.mu.Lock()
	delete(m.pending, turnSource(src))
	p := m.relays[a.Port]
	if p != nil {
		p.user = username
		m.users[username]++
	}
	m.mu.Unlock()
	// The WebSocket may have left while allocation was being created.
	if !m.owner.turnUserActive(username) && p != nil {
		_ = p.Close()
	}
}
func (s *Server) turnUserActive(username string) bool {
	_, id, ok := strings.Cut(username, ":")
	if !ok {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.turnViewers[id]
}
func (m *builtinTURN) auth(username, realm string, _ net.Addr) ([]byte, bool) {
	timestamp, id, ok := strings.Cut(username, ":")
	expires, e := strconv.ParseInt(timestamp, 10, 64)
	now := time.Now().Unix()
	if !ok || e != nil || !identifier.MatchString(id) || expires <= now || expires > now+86460 || realm != m.realm || !m.owner.turnUserActive(username) {
		return nil, false
	}
	mac := hmac.New(sha1.New, []byte(m.owner.cfg.TURNSecret))
	_, _ = mac.Write([]byte(username))
	password := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	return turn.GenerateAuthKey(username, realm, password), true
}
func (m *builtinTURN) revoke(id string) {
	m.mu.Lock()
	var conns []*turnPacket
	for _, p := range m.relays {
		if strings.HasSuffix(p.user, ":"+id) {
			conns = append(conns, p)
		}
	}
	for k, p := range m.pending {
		if strings.HasSuffix(p.user, ":"+id) {
			delete(m.pending, k)
		}
	}
	m.mu.Unlock()
	for _, p := range conns {
		_ = p.Close()
	}
}

type turnConn struct {
	net.Conn
	m    *builtinTURN
	once sync.Once
}

func (c *turnConn) Read(b []byte) (int, error) {
	_ = c.Conn.SetReadDeadline(time.Now().Add(2 * time.Minute))
	return c.Conn.Read(b)
}
func (c *turnConn) Close() error {
	var err error
	c.once.Do(func() { err = c.Conn.Close(); c.m.mu.Lock(); delete(c.m.connections, c); c.m.mu.Unlock() })
	return err
}

type turnListener struct {
	net.Listener
	m *builtinTURN
}

func (l *turnListener) Accept() (net.Conn, error) {
	for {
		c, e := l.Listener.Accept()
		if e != nil {
			return nil, e
		}
		l.m.mu.Lock()
		if l.m.closed || len(l.m.connections) >= 256 {
			l.m.mu.Unlock()
			_ = c.Close()
			continue
		}
		conn := &turnConn{Conn: c, m: l.m}
		l.m.connections[conn] = struct{}{}
		l.m.mu.Unlock()
		return conn, nil
	}
}

func (s *Server) startTURN() (err error) {
	c := s.cfg.BuiltinTURN
	if c.Listen == "" {
		return nil
	}
	u, _ := url.Parse(s.cfg.PublicURL)
	m := &builtinTURN{owner: s, cfg: c, realm: u.Hostname(), relays: map[int]*turnPacket{}, users: map[string]int{}, pending: map[string]turnPending{}, connections: map[*turnConn]struct{}{}}
	m.bandwidth = newByteBudget(int64(c.MaxMbps) * 125000)
	defer func() {
		if err != nil {
			m.close()
		}
	}()
	m.udp, err = net.ListenPacket("udp4", c.Listen)
	if err != nil {
		return fmt.Errorf("listen TURN UDP: %w", err)
	}
	tcp, err := net.Listen("tcp4", c.Listen)
	if err != nil {
		return fmt.Errorf("listen TURN TCP: %w", err)
	}
	m.listeners = append(m.listeners, tcp)
	listeners := []turn.ListenerConfig{{Listener: &turnListener{Listener: tcp, m: m}, RelayAddressGenerator: &turnGenerator{m}, PermissionHandler: func(_ net.Addr, ip net.IP) bool { return turnPeerAllowed(ip, c.AllowPrivatePeers) }}}
	if c.TLSListen != "" {
		raw, e := net.Listen("tcp4", c.TLSListen)
		if e != nil {
			return fmt.Errorf("listen TURN TLS: %w", e)
		}
		m.listeners = append(m.listeners, raw)
		tc := &tls.Config{MinVersion: tls.VersionTLS12, GetCertificate: func(*tls.ClientHelloInfo) (*tls.Certificate, error) {
			cert, e := tls.LoadX509KeyPair(c.CertFile, c.KeyFile)
			return &cert, e
		}}
		listeners = append(listeners, turn.ListenerConfig{Listener: tls.NewListener(&turnListener{Listener: raw, m: m}, tc), RelayAddressGenerator: &turnGenerator{m}, PermissionHandler: func(_ net.Addr, ip net.IP) bool { return turnPeerAllowed(ip, c.AllowPrivatePeers) }})
	}
	m.server, err = turn.NewServer(turn.ServerConfig{Realm: m.realm, AuthHandler: m.auth, QuotaHandler: m.quota, EventHandler: turn.EventHandler{OnAllocationCreated: m.allocated}, PacketConnConfigs: []turn.PacketConnConfig{{PacketConn: m.udp, RelayAddressGenerator: &turnGenerator{m}, PermissionHandler: func(_ net.Addr, ip net.IP) bool { return turnPeerAllowed(ip, c.AllowPrivatePeers) }}}, ListenerConfigs: listeners})
	if err != nil {
		return err
	}
	s.turn = m
	return nil
}
func (m *builtinTURN) close() {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return
	}
	m.closed = true
	var relays []*turnPacket
	for _, p := range m.relays {
		relays = append(relays, p)
	}
	var clients []*turnConn
	for c := range m.connections {
		clients = append(clients, c)
	}
	m.mu.Unlock()
	if m.server != nil {
		_ = m.server.Close()
	}
	if m.udp != nil {
		_ = m.udp.Close()
	}
	for _, l := range m.listeners {
		_ = l.Close()
	}
	for _, c := range clients {
		_ = c.Close()
	}
	for _, p := range relays {
		_ = p.Close()
	}
}
