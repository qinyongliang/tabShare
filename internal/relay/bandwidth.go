package relay

import (
	"sync"
	"time"
)

// One shared token bucket for TURN relay payload in both directions. Discarding
// excess datagrams lets RTP/SCTP congestion control react without unbounded queues
// or blocking TURN authentication and keepalive handling.
type byteBudget struct {
	mu                  sync.Mutex
	rate, burst, tokens float64
	last                time.Time
}

func newByteBudget(bytesPerSecond int64) *byteBudget {
	burst := float64(max(65536, min(262144, bytesPerSecond/4)))
	return &byteBudget{rate: float64(bytesPerSecond), burst: burst, tokens: burst, last: time.Now()}
}

func (b *byteBudget) allow(size int, now time.Time) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if elapsed := now.Sub(b.last).Seconds(); elapsed > 0 {
		b.tokens = min(b.burst, b.tokens+elapsed*b.rate)
		b.last = now
	}
	if size < 0 || float64(size) > b.tokens {
		return false
	}
	b.tokens -= float64(size)
	return true
}
