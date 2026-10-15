package relay

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/pion/turn/v4"
)

func turnAddress(t *testing.T) string {
	t.Helper()
	l, e := net.Listen("tcp4", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	a := l.Addr().String()
	_ = l.Close()
	return a
}
func turnFixture(t *testing.T, private bool, tlsFiles ...string) *fixture {
	t.Helper()
	cfg := Config{DataDir: t.TempDir(), PublicURL: "http://localhost:8080", BuiltinTURN: TURNConfig{Listen: turnAddress(t), PublicIP: "127.0.0.1", RelayIP: "127.0.0.1", MinPort: 53000, MaxPort: 53099, AllowPrivatePeers: private}}
	if len(tlsFiles) > 0 {
		cfg.BuiltinTURN.TLSListen = turnAddress(t)
		cfg.BuiltinTURN.CertFile = tlsFiles[0]
		cfg.BuiltinTURN.KeyFile = tlsFiles[1]
	}
	s, e := New(cfg)
	if e != nil {
		t.Fatal(e)
	}
	h := httptest.NewServer(s.Handler())
	t.Cleanup(func() { s.Close(); h.Close() })
	return &fixture{s, h}
}
func turnLogin(t *testing.T, f *fixture) (Session, *websocket.Conn, Message, ICEServer) {
	t.Helper()
	se, _ := f.create(t, Session{AgentID: "turn-browser", Kind: "url", URL: "https://example.com"})
	v := dial(t, f, "/ws/view/"+se.ID, Message{Type: "join", Key: se.Key})
	m := readType(t, v, "joined")
	for _, ice := range m.ICEServers {
		if ice.Username != "" {
			return se, v, m, ice
		}
	}
	t.Fatal("built-in TURN omitted ICE credentials")
	return Session{}, nil, Message{}, ICEServer{}
}
func newTURNClient(t *testing.T, f *fixture, ice ICEServer, transport string, roots *x509.CertPool) *turn.Client {
	t.Helper()
	addr := f.s.cfg.BuiltinTURN.Listen
	var pc net.PacketConn
	switch transport {
	case "udp":
		c, e := net.ListenPacket("udp4", "127.0.0.1:0")
		if e != nil {
			t.Fatal(e)
		}
		pc = c
	case "tcp":
		c, e := net.DialTimeout("tcp4", addr, 2*time.Second)
		if e != nil {
			t.Fatal(e)
		}
		pc = turn.NewSTUNConn(c)
	case "tls":
		addr = f.s.cfg.BuiltinTURN.TLSListen
		c, e := tls.DialWithDialer(&net.Dialer{Timeout: 2 * time.Second}, "tcp4", addr, &tls.Config{RootCAs: roots, ServerName: "127.0.0.1", MinVersion: tls.VersionTLS12})
		if e != nil {
			t.Fatal(e)
		}
		pc = turn.NewSTUNConn(c)
	default:
		t.Fatal("unknown test transport")
	}
	client, e := turn.NewClient(&turn.ClientConfig{Conn: pc, STUNServerAddr: addr, TURNServerAddr: addr, Username: ice.Username, Password: ice.Credential, Realm: f.s.turn.realm, RTO: 30 * time.Millisecond})
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { client.Close(); _ = pc.Close() })
	if e = client.Listen(); e != nil {
		t.Fatal(e)
	}
	return client
}
func echoTURN(t *testing.T, f *fixture, ice ICEServer, transport string, roots *x509.CertPool) net.PacketConn {
	t.Helper()
	client := newTURNClient(t, f, ice, transport, roots)
	allocation, e := client.Allocate()
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { _ = allocation.Close() })
	port := allocation.LocalAddr().(*net.UDPAddr).Port
	if port < f.s.cfg.BuiltinTURN.MinPort || port > f.s.cfg.BuiltinTURN.MaxPort {
		t.Fatal("relay escaped configured range")
	}
	echo, e := net.ListenPacket("udp4", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	defer echo.Close()
	payload := []byte("real TURN " + transport + " media/data packet")
	if _, e = allocation.WriteTo(payload, echo.LocalAddr()); e != nil {
		t.Fatal(e)
	}
	_ = echo.SetReadDeadline(time.Now().Add(2 * time.Second))
	buffer := make([]byte, 4096)
	n, src, e := echo.ReadFrom(buffer)
	if e != nil {
		t.Fatal(e)
	}
	if !bytes.Equal(buffer[:n], payload) {
		t.Fatal("outbound payload changed")
	}
	if _, e = echo.WriteTo(buffer[:n], src); e != nil {
		t.Fatal(e)
	}
	_ = allocation.SetReadDeadline(time.Now().Add(2 * time.Second))
	n, _, e = allocation.ReadFrom(buffer)
	if e != nil {
		t.Fatal(e)
	}
	if !bytes.Equal(buffer[:n], payload) {
		t.Fatal("inbound payload changed")
	}
	return allocation
}
func waitTURN(t *testing.T, check func() bool) {
	t.Helper()
	end := time.Now().Add(3 * time.Second)
	for time.Now().Before(end) {
		if check() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("TURN cleanup did not complete")
}
func TestBuiltinTURNRelaysUDPAndTCPAndRevokesOnLeave(t *testing.T) {
	for _, transport := range []string{"udp", "tcp"} {
		t.Run(transport, func(t *testing.T) {
			f := turnFixture(t, true)
			_, v, joined, ice := turnLogin(t, f)
			if len(ice.URLs) != 2 || !strings.HasSuffix(ice.URLs[0], "?transport=udp") || !strings.HasSuffix(ice.URLs[1], "?transport=tcp") {
				t.Fatal("missing automatic UDP/TCP ICE URLs")
			}
			client := newTURNClient(t, f, ice, transport, nil)
			if _, e := client.SendBindingRequest(); e != nil {
				t.Fatal("built-in STUN failed:", e)
			}
			_ = echoTURN(t, f, ice, transport, nil)
			_ = v.CloseNow()
			waitTURN(t, func() bool { f.s.turn.mu.Lock(); defer f.s.turn.mu.Unlock(); return len(f.s.turn.relays) == 0 })
			if _, ok := f.s.turn.auth(ice.Username, f.s.turn.realm, nil); ok {
				t.Fatal("left viewer still authenticates")
			}
			f.s.mu.Lock()
			active := f.s.turnViewers[joined.ViewerID]
			f.s.mu.Unlock()
			if active {
				t.Fatal("left viewer membership retained")
			}
		})
	}
}
func TestBuiltinTURNRejectsAnonymousExpiredAndWrongCredentials(t *testing.T) {
	f := turnFixture(t, true)
	_, _, _, ice := turnLogin(t, f)
	bad := ice
	bad.Credential = "wrong-password"
	if _, e := newTURNClient(t, f, bad, "tcp", nil).Allocate(); e == nil {
		t.Fatal("wrong password allocated a relay")
	}
	bad.Username = strconv.FormatInt(time.Now().Add(time.Hour).Unix(), 10) + ":" + randomID()
	bad.Credential = "unpaired"
	if _, e := newTURNClient(t, f, bad, "udp", nil).Allocate(); e == nil {
		t.Fatal("unpaired user allocated a relay")
	}
	_, id, _ := strings.Cut(ice.Username, ":")
	for _, username := range []string{"anonymous", strconv.FormatInt(time.Now().Add(-time.Minute).Unix(), 10) + ":" + id, strconv.FormatInt(time.Now().Add(48*time.Hour).Unix(), 10) + ":" + id} {
		if _, ok := f.s.turn.auth(username, f.s.turn.realm, nil); ok {
			t.Fatal("invalid/expired credential accepted")
		}
	}
	if _, ok := f.s.turn.auth(ice.Username, "wrong-realm", nil); ok {
		t.Fatal("wrong realm accepted")
	}
}
func TestBuiltinTURNBlocksPrivatePeersUnlessExplicitlyAllowed(t *testing.T) {
	for _, ip := range []string{"127.0.0.1", "10.0.0.1", "172.16.1.1", "192.168.1.2", "169.254.169.254", "100.100.100.200", "0.0.0.0", "224.0.0.1", "198.18.0.1", "192.0.0.2", "::1"} {
		if turnPeerAllowed(net.ParseIP(ip), false) {
			t.Fatalf("private/reserved peer permitted: %s", ip)
		}
	}
	if !turnPeerAllowed(net.ParseIP("8.8.8.8"), false) || !turnPeerAllowed(net.ParseIP("127.0.0.1"), true) {
		t.Fatal("valid peer rejected")
	}
	f := turnFixture(t, false)
	_, _, _, ice := turnLogin(t, f)
	client := newTURNClient(t, f, ice, "udp", nil)
	allocation, e := client.Allocate()
	if e != nil {
		t.Fatal(e)
	}
	defer allocation.Close()
	peer := &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 9}
	if _, e = allocation.WriteTo([]byte("blocked"), peer); e == nil {
		t.Fatal("private peer bypassed actual TURN permission")
	}
}
func TestBuiltinTURNPortLimitsAndStartupRollback(t *testing.T) {
	f := turnFixture(t, true)
	g := &turnGenerator{m: f.s.turn}
	if _, _, e := g.AllocatePacketConn("udp4", f.s.cfg.BuiltinTURN.MaxPort+1); e == nil {
		t.Fatal("requested port escaped range")
	}
	if _, _, e := g.AllocateConn("tcp4", 0); e == nil {
		t.Fatal("unexpected TCP relay allocation support")
	}
	for i := 0; i < 8; i++ {
		if !f.s.turn.quota("user", "localhost", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 1000 + i}) {
			t.Fatal("quota rejected within limit")
		}
	}
	if f.s.turn.quota("user", "localhost", &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: 2000}) {
		t.Fatal("quota accepted excessive pending allocations")
	}
	occupied, e := net.Listen("tcp4", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	defer occupied.Close()
	addr := occupied.Addr().String()
	if _, e = New(Config{DataDir: t.TempDir(), PublicURL: "http://localhost:8080", BuiltinTURN: TURNConfig{Listen: addr, PublicIP: "127.0.0.1"}}); e == nil {
		t.Fatal("occupied TCP listener did not fail startup")
	}
	udp, e := net.ListenPacket("udp4", addr)
	if e != nil {
		t.Fatal("failed startup leaked UDP listener:", e)
	}
	_ = udp.Close()
}
func TestBuiltinTURNSecretPersistenceAndShutdown(t *testing.T) {
	f := turnFixture(t, true)
	_, _, _, ice := turnLogin(t, f)
	_ = echoTURN(t, f, ice, "tcp", nil)
	path := filepath.Join(f.s.cfg.DataDir, "turn-secret")
	info, e := os.Stat(path)
	if e != nil {
		t.Fatal(e)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatal("TURN secret must be private")
	}
	before := f.s.cfg.TURNSecret
	cfg := f.s.cfg
	cfg.TURNSecret = ""
	f.s.Close()
	if _, e = net.DialTimeout("tcp4", cfg.BuiltinTURN.Listen, 100*time.Millisecond); e == nil {
		t.Fatal("TCP listener survived shutdown")
	}
	udp, e := net.ListenPacket("udp4", cfg.BuiltinTURN.Listen)
	if e != nil {
		t.Fatal("UDP listener survived shutdown")
	}
	_ = udp.Close()
	restored, e := New(cfg)
	if e != nil {
		t.Fatal(e)
	}
	defer restored.Close()
	if restored.cfg.TURNSecret != before {
		t.Fatal("restart changed persisted TURN secret")
	}
}
func TestBuiltinTURNShareRevocationClosesRelay(t *testing.T) {
	f := turnFixture(t, true)
	se, _, _, ice := turnLogin(t, f)
	_ = echoTURN(t, f, ice, "tcp", nil)
	req, _ := http.NewRequest("DELETE", f.http.URL+"/api/sessions/"+se.ID, nil)
	req.Header.Set("Authorization", "Bearer "+f.s.token)
	response, e := http.DefaultClient.Do(req)
	if e != nil {
		t.Fatal(e)
	}
	response.Body.Close()
	if response.StatusCode != 204 {
		t.Fatal("share revoke failed")
	}
	waitTURN(t, func() bool { f.s.turn.mu.Lock(); defer f.s.turn.mu.Unlock(); return len(f.s.turn.relays) == 0 })
}
func TestBuiltinTURNTLS(t *testing.T) {
	key, e := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "TURN test"}, NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour), IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, e := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if e != nil {
		t.Fatal(e)
	}
	keyDER, e := x509.MarshalPKCS8PrivateKey(key)
	if e != nil {
		t.Fatal(e)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})
	dir := t.TempDir()
	certPath, keyPath := filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem")
	if e = os.WriteFile(certPath, certPEM, 0600); e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(keyPath, keyPEM, 0600); e != nil {
		t.Fatal(e)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(certPEM) {
		t.Fatal("test CA failed")
	}
	f := turnFixture(t, true, certPath, keyPath)
	_, _, _, ice := turnLogin(t, f)
	if len(ice.URLs) != 3 || !strings.HasPrefix(ice.URLs[2], "turns:") {
		t.Fatal("TLS URL omitted")
	}
	_ = echoTURN(t, f, ice, "tls", roots)
}
