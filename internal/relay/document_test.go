package relay

import "testing"

func TestDocumentDeltasAndLateJoin(t *testing.T) {
	s := documentState{}
	initial := &Document{Version: "v1", Sequence: 1, Reset: true, Root: "1", Nodes: []map[string]any{{"id": "1", "tag": "body", "children": []any{"2"}}, {"id": "2", "tag": "input", "value": "old", "style": map[string]any{"color": "red", "width": "200px"}}}}
	if err := s.apply(initial); err != nil {
		t.Fatal(err)
	}
	delta := &Document{Version: "v1", Sequence: 2, Root: "1", Updates: []NodeUpdate{{ID: "2", Changes: map[string]any{"value": "new", "style": map[string]any{"color": "blue"}}}}}
	if err := s.apply(delta); err != nil {
		t.Fatal(err)
	}
	style := s.nodes["2"]["style"].(map[string]any)
	if style["width"] != "200px" || style["color"] != "blue" || s.nodes["2"]["value"] != "new" {
		t.Fatal("delta did not preserve unchanged properties")
	}
	if initial.Nodes[1]["style"].(map[string]any)["color"] != "red" {
		t.Fatal("apply mutated the initial packet still in writer queues")
	}
	snapshot := s.snapshot()
	if !snapshot.Reset || len(snapshot.Nodes) != 2 || snapshot.Sequence != 2 {
		t.Fatal("late visitor needs consolidated current state")
	}
	rebuilt := documentState{}
	if err := rebuilt.apply(snapshot); err != nil {
		t.Fatal(err)
	}
	if rebuilt.nodes["2"]["value"] != "new" {
		t.Fatal("late join lost previous deltas")
	}
	if err := s.apply(delta); err == nil {
		t.Fatal("duplicate delta accepted")
	}
}
func TestDocumentRejectsBrokenDeltaAtomically(t *testing.T) {
	s := documentState{}
	initial := &Document{Version: "v1", Sequence: 1, Reset: true, Root: "1", Nodes: []map[string]any{{"id": "1", "tag": "body"}}}
	if err := s.apply(initial); err != nil {
		t.Fatal(err)
	}
	err := s.apply(&Document{Version: "v1", Sequence: 2, Root: "1", Updates: []NodeUpdate{{ID: "1", Changes: map[string]any{"text": "bad"}}, {ID: "missing", Changes: map[string]any{"text": "bad"}}}})
	if err == nil || s.nodes["1"]["text"] != nil || s.sequence != 1 {
		t.Fatal("failed delta corrupted retained state")
	}
}
func BenchmarkSmallDOMDelta(b *testing.B) {
	s := documentState{}
	nodes := make([]map[string]any, 1500)
	for i := range nodes {
		id := string(rune(i + 1000))
		nodes[i] = map[string]any{"id": id, "tag": "div", "style": map[string]any{"color": "red", "width": "100px"}}
	}
	initial := &Document{Version: "v1", Sequence: 1, Reset: true, Root: nodes[0]["id"].(string), Nodes: nodes}
	if err := s.apply(initial); err != nil {
		b.Fatal(err)
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		d := &Document{Version: "v1", Sequence: i + 2, Root: initial.Root, Updates: []NodeUpdate{{ID: initial.Root, Changes: map[string]any{"text": "one small change"}}}}
		if err := s.apply(d); err != nil {
			b.Fatal(err)
		}
	}
}
