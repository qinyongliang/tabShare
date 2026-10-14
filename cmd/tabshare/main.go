package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/qinyongliang/tabShare/internal/relay"
)

func main() {
	listen := flag.String("listen", "127.0.0.1:8080", "HTTP listen address")
	data := flag.String("data", ".data", "persistent session and pairing-token directory")
	public := flag.String("public-url", "http://localhost:8080", "external HTTP(S) URL, without a trailing path")
	flag.Parse()
	app, err := relay.New(relay.Config{DataDir: *data, PublicURL: *public})
	if err != nil {
		log.Fatal(err)
	}
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
	log.Printf("TabShare listening on %s; pairing token file: %s/admin-token (token is never logged)", *listen, *data)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
