package relay

// Called under s.mu. Serialized node, CSS and metadata bytes are an accounting
// budget, not a bound on the Go heap or in-flight snapshots.
func (s *Server) clearDocument(l *live) {
	s.domBytes -= l.document.retainedBytes()
	l.document = documentState{}
}

func (s *Server) applyDocument(l *live, d *Document) error {
	before := l.document.retainedBytes()
	budget := min(4<<20, s.cfg.DOMCacheBytes-s.domBytes+before)
	if err := l.document.applyBudget(d, budget); err != nil {
		return err
	}
	s.domBytes += l.document.retainedBytes() - before
	return nil
}

func needsDOMCache(l *live) bool {
	for viewer := range l.viewers {
		if !viewer.direct {
			return true
		}
	}
	return false
}
