package web

import (
	"embed"
	"net/http"
	"strings"
)

//go:embed *.html *.css *.js
var assets embed.FS

func Serve(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/assets/")
	if r.URL.Path == "/" {
		name = "index.html"
	}
	if strings.HasPrefix(r.URL.Path, "/s/") {
		name = "viewer.html"
	}
	switch name {
	case "index.html", "viewer.html", "viewer.js", "style.css", "mirror.js", "mirror.html", "resources.js", "display.js", "peer.js", "draggable.js", "navigation.js", "clipboard.js", "context-menu.js", "remote-input.js", "downloads.js", "pointer.js", "popups.js", "geolocation.js":
	default:
		http.NotFound(w, r)
		return
	}
	b, err := assets.ReadFile(name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	if strings.HasSuffix(name, ".js") {
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	}
	if strings.HasSuffix(name, ".css") {
		w.Header().Set("Content-Type", "text/css; charset=utf-8")
	}
	if strings.HasSuffix(name, ".html") {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
	}
	if name == "mirror.html" {
		w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; sandbox allow-same-origin")
	}
	_, _ = w.Write(b)
}
