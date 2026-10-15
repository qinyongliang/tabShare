package relay

import "net/http"

// Diagnostics contain counts only; never page content, links or pairing credentials.
func (s *Server) stats(w http.ResponseWriter, r *http.Request) {
	if !sameSecret(bearer(r), s.token) {
		http.Error(w, "pairing token required", 401)
		return
	}
	s.mu.Lock()
	result := map[string]any{"sessions": len(s.sessions), "agents": len(s.agents), "resourceBytes": s.assetBytes, "websocketQueuedBytes": s.queuedBytes.Load()}
	viewers, direct := 0, 0
	for _, live := range s.live {
		viewers += len(live.viewers)
		for peer := range live.viewers {
			if peer.direct {
				direct++
			}
		}
	}
	result["viewers"] = viewers
	result["webrtcPeers"] = direct
	result["domBytes"] = s.domBytes
	result["domCacheLimitBytes"] = s.cfg.DOMCacheBytes
	result["domCacheRejected"] = s.domRejected.Load()
	s.mu.Unlock()
	if s.turn != nil {
		s.turn.mu.Lock()
		result["turnAllocations"] = len(s.turn.relays)
		s.turn.mu.Unlock()
		result["turnRelayBytesSent"] = s.turn.sentBytes.Load()
		result["turnRelayBytesReceived"] = s.turn.receivedBytes.Load()
		result["turnRelayBytesDropped"] = s.turn.droppedBytes.Load()
		result["turnMaxMbps"] = s.turn.cfg.MaxMbps
	}
	jsonResponse(w, 200, result)
}
