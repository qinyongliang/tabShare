// A loopback-only TURN/TCP fixture for real WebRTC tests. Never a deployment server.
package main

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"flag"
	"github.com/pion/turn/v4"
	"log"
	"net"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func main() {
	addr := flag.String("listen", "127.0.0.1:3478", "loopback TCP address")
	flag.Parse()
	host, _, err := net.SplitHostPort(*addr)
	if err != nil || host != "127.0.0.1" {
		log.Fatal("test TURN must listen on loopback")
	}
	secret := os.Getenv("TABSHARE_TEST_TURN_SECRET")
	if len(secret) < 32 {
		log.Fatal("test TURN secret missing")
	}
	listener, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatal(err)
	}
	server, err := turn.NewServer(turn.ServerConfig{
		Realm: "tabshare-test",
		AuthHandler: func(username, realm string, _ net.Addr) ([]byte, bool) {
			expires, e := strconv.ParseInt(strings.Split(username, ":")[0], 10, 64)
			if e != nil || expires <= time.Now().Unix() {
				return nil, false
			}
			mac := hmac.New(sha1.New, []byte(secret))
			_, _ = mac.Write([]byte(username))
			password := base64.StdEncoding.EncodeToString(mac.Sum(nil))
			return turn.GenerateAuthKey(username, realm, password), true
		},
		ListenerConfigs: []turn.ListenerConfig{{Listener: listener, RelayAddressGenerator: &turn.RelayAddressGeneratorStatic{RelayAddress: net.ParseIP("127.0.0.1"), Address: "127.0.0.1"}}},
	})
	if err != nil {
		log.Fatal(err)
	}
	defer server.Close()
	log.Print("test TURN/TCP ready on loopback")
	done := make(chan os.Signal, 1)
	signal.Notify(done, os.Interrupt, syscall.SIGTERM)
	<-done
}
