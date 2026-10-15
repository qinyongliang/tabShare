package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/qinyongliang/tabShare/internal/relay"
)

func main() {
	listen := flag.String("listen", "127.0.0.1:8080", "HTTP listen address")
	data := flag.String("data", ".data", "persistent session and pairing-token directory")
	public := flag.String("public-url", "http://localhost:8080", "external HTTP(S) URL, without a trailing path")
	stun := flag.String("stun", "stun:stun.l.google.com:19302", "comma-separated STUN URLs; empty disables STUN")
	turn := flag.String("turn", os.Getenv("TABSHARE_TURN_URLS"), "comma-separated TURN URLs")
	turnListen := flag.String("turn-listen", os.Getenv("TABSHARE_TURN_LISTEN"), "built-in TURN UDP/TCP IPv4 listen address; empty disables")
	turnIP := flag.String("turn-public-ip", os.Getenv("TABSHARE_TURN_PUBLIC_IP"), "advertised built-in TURN public IPv4")
	turnHost := flag.String("turn-host", "", "advertised TURN hostname, defaults to public IPv4")
	relayIP := flag.String("turn-relay-ip", "", "local relay bind IPv4, defaults to TURN listen host")
	ports := flag.String("turn-relay-ports", "49160-49359", "built-in TURN UDP relay port range")
	privatePeers := flag.Bool("turn-allow-private-peers", false, "allow LAN/loopback TURN peers (trusted networks only)")
	tlsListen := flag.String("turn-tls-listen", "", "optional built-in TURN TLS listen address")
	cert := flag.String("turn-cert", "", "TURN TLS certificate PEM path")
	key := flag.String("turn-key", "", "TURN TLS private key PEM path")
	flag.Parse()
	bounds := strings.Split(*ports, "-")
	if len(bounds) != 2 {
		log.Fatal("invalid turn-relay-ports range")
	}
	minPort, e1 := strconv.Atoi(bounds[0])
	maxPort, e2 := strconv.Atoi(bounds[1])
	if e1 != nil || e2 != nil {
		log.Fatal("invalid turn-relay-ports range")
	}
	builtin := relay.TURNConfig{Listen: *turnListen, PublicIP: *turnIP, Host: *turnHost, RelayIP: *relayIP, MinPort: minPort, MaxPort: maxPort, AllowPrivatePeers: *privatePeers, TLSListen: *tlsListen, CertFile: *cert, KeyFile: *key}
	split := func(value string) []string {
		if strings.TrimSpace(value) == "" {
			return nil
		}
		return strings.Split(value, ",")
	}
	app, err := relay.New(relay.Config{DataDir: *data, PublicURL: *public, STUNURLs: split(*stun), TURNURLs: split(*turn), TURNSecret: os.Getenv("TABSHARE_TURN_SECRET"), BuiltinTURN: builtin})
	if err != nil {
		log.Fatal(err)
	}
	defer app.Close()
	srv := &http.Server{Addr: *listen, Handler: app.Handler(), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		app.Close()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
	}()
	if *turnListen != "" {
		log.Printf("Built-in TURN UDP/TCP on %s; advertised IPv4 %s; relay UDP ports %s", *turnListen, *turnIP, *ports)
	}
	log.Printf("TabShare listening on %s; pairing token file: %s/admin-token (token is never logged)", *listen, *data)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
