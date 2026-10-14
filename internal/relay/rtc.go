package relay

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"
)

type ICEServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}
type Description struct {
	Type string `json:"type"`
	SDP  string `json:"sdp"`
}
type Candidate struct {
	Candidate        string  `json:"candidate"`
	SDPMid           *string `json:"sdpMid"`
	SDPMLineIndex    *int    `json:"sdpMLineIndex"`
	UsernameFragment string  `json:"usernameFragment,omitempty"`
}
type Signal struct {
	Attempt     string       `json:"attempt"`
	Description *Description `json:"description,omitempty"`
	Candidate   *Candidate   `json:"candidate,omitempty"`
}

func validSignal(v *Signal) bool {
	if v == nil || !identifier.MatchString(v.Attempt) {
		return false
	}
	if v.Description != nil {
		return v.Candidate == nil && (v.Description.Type == "offer" || v.Description.Type == "answer") && len(v.Description.SDP) > 0 && len(v.Description.SDP) <= 100000
	}
	if v.Candidate == nil {
		return false
	}
	c := v.Candidate
	return len(c.Candidate) <= 2048 && (c.SDPMid == nil || len(*c.SDPMid) <= 64) && (c.SDPMLineIndex == nil || (*c.SDPMLineIndex >= 0 && *c.SDPMLineIndex <= 32)) && len(c.UsernameFragment) <= 256
}
func validateICE(cfg Config) error {
	if len(cfg.TURNURLs) > 0 && len(cfg.TURNSecret) < 32 {
		return errors.New("TURN shared secret must contain at least 32 characters")
	}
	if len(cfg.STUNURLs)+len(cfg.TURNURLs) > 8 {
		return errors.New("too many ICE URLs")
	}
	for _, group := range []struct {
		urls   []string
		prefix string
	}{{cfg.STUNURLs, "stun"}, {cfg.TURNURLs, "turn"}} {
		for _, raw := range group.urls {
			u, e := url.Parse(raw)
			if e != nil || len(raw) > 512 || (u.Scheme != group.prefix && u.Scheme != group.prefix+"s") || u.Opaque == "" || strings.ContainsAny(u.Opaque, "@\r\n") {
				return fmt.Errorf("invalid %s URL", group.prefix)
			}
		}
	}
	return nil
}
func (s *Server) iceServers(id string) []ICEServer {
	result := []ICEServer{}
	if len(s.cfg.STUNURLs) > 0 {
		result = append(result, ICEServer{URLs: s.cfg.STUNURLs})
	}
	if len(s.cfg.TURNURLs) > 0 {
		username := fmt.Sprintf("%d:%s", time.Now().Add(24*time.Hour).Unix(), id)
		mac := hmac.New(sha1.New, []byte(s.cfg.TURNSecret))
		_, _ = mac.Write([]byte(username))
		result = append(result, ICEServer{URLs: s.cfg.TURNURLs, Username: username, Credential: base64.StdEncoding.EncodeToString(mac.Sum(nil))})
	}
	return result
}
