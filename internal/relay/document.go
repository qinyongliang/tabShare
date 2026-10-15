package relay

import (
	"encoding/json"
	"errors"
)

var errDOMBudget = errors.New("DOM cache budget exceeded")

type Document struct {
	Version    string           `json:"version"`
	Sequence   int              `json:"sequence"`
	Reset      bool             `json:"reset"`
	Root       string           `json:"root"`
	Nodes      []map[string]any `json:"nodes"`
	Updates    []NodeUpdate     `json:"updates"`
	Removes    []string         `json:"removes"`
	Meta       map[string]any   `json:"meta"`
	CSSChanged bool             `json:"cssChanged,omitempty"`
	CSS        string           `json:"css,omitempty"`
}
type NodeUpdate struct {
	ID      string         `json:"id"`
	Changes map[string]any `json:"changes"`
}
type documentState struct {
	version  string
	sequence int
	root     string
	nodes    map[string]map[string]any
	meta     map[string]any
	css      string
	sizes    map[string]int
	bytes    int
	auxBytes int
}

func (state *documentState) retainedBytes() int { return state.bytes + state.auxBytes }

func cloneMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}
func (state *documentState) apply(d *Document) error {
	return state.applyBudget(d, 4<<20)
}
func (state *documentState) applyBudget(d *Document, budget int) error {
	if d == nil || len(d.Version) > 80 || d.Version == "" || d.Sequence <= 0 || len(d.Root) > 32 || len(d.Nodes) > 3500 || len(d.Updates) > 3500 || len(d.Removes) > 7000 || len(d.CSS) > 100000 {
		return errors.New("invalid DOM delta")
	}
	if !d.Reset && (state.nodes == nil || state.version != d.Version || d.Sequence <= state.sequence) {
		return errors.New("stale DOM delta")
	}
	base := state.nodes
	sizes := state.sizes
	bytes := state.bytes
	if d.Reset || base == nil {
		base = map[string]map[string]any{}
		sizes = map[string]int{}
		bytes = 0
	}
	next := map[string]map[string]any{}
	lookup := func(id string) map[string]any {
		if n, ok := next[id]; ok {
			return n
		}
		return base[id]
	}
	for _, n := range d.Nodes {
		id, ok := n["id"].(string)
		if !ok || id == "" || len(id) > 32 {
			return errors.New("invalid node identity")
		}
		next[id] = cloneMap(n)
	}
	for _, update := range d.Updates {
		old := lookup(update.ID)
		if old == nil {
			return errors.New("update refers to missing node")
		}
		node := cloneMap(old)
		for field, value := range update.Changes {
			if field == "id" {
				return errors.New("immutable node identity")
			}
			if field == "style" || field == "attrs" {
				changes, ok := value.(map[string]any)
				if !ok {
					return errors.New("invalid property delta")
				}
				base, _ := old[field].(map[string]any)
				merged := cloneMap(base)
				for k, v := range changes {
					if v == nil {
						delete(merged, k)
					} else {
						merged[k] = v
					}
				}
				node[field] = merged
			} else {
				node[field] = value
			}
		}
		next[update.ID] = node
	}
	removed := map[string]bool{}
	count := len(base)
	for _, id := range d.Removes {
		removed[id] = true
		delete(next, id)
	}
	for id := range removed {
		if base[id] != nil {
			count--
			bytes -= sizes[id]
		}
	}
	newSizes := map[string]int{}
	for id, node := range next {
		encoded, err := json.Marshal(node)
		if err != nil {
			return err
		}
		newSizes[id] = len(encoded)
		if base[id] == nil {
			count++
		}
		bytes += len(encoded) - sizes[id]
	}
	if count > 3500 || removed[d.Root] || lookup(d.Root) == nil {
		return errors.New("invalid document size or root")
	}
	css := state.css
	if d.Reset || d.CSSChanged || d.CSS != "" {
		css = d.CSS
	}
	meta, err := json.Marshal(d.Meta)
	if err != nil {
		return err
	}
	auxBytes := len(meta) + len(css) + len(d.Version) + len(d.Root)
	if bytes+auxBytes > budget {
		return errDOMBudget
	}
	// Commit validated changes only. Unchanged nodes stay in place and their immutable maps
	// can still be used by queued messages and late-join snapshots without being copied.
	for id := range removed {
		delete(base, id)
		delete(sizes, id)
	}
	for id, node := range next {
		base[id] = node
		sizes[id] = newSizes[id]
	}
	state.nodes = base
	state.sizes = sizes
	state.bytes = bytes
	state.auxBytes = auxBytes
	state.version = d.Version
	state.sequence = d.Sequence
	state.root = d.Root
	state.meta = d.Meta
	state.css = css
	return nil
}
func (state *documentState) snapshot() *Document {
	if state.nodes == nil {
		return nil
	}
	d := &Document{Version: state.version, Sequence: state.sequence, Reset: true, Root: state.root, Meta: state.meta, CSS: state.css, Nodes: make([]map[string]any, 0, len(state.nodes))}
	for _, n := range state.nodes {
		d.Nodes = append(d.Nodes, n)
	}
	return d
}
