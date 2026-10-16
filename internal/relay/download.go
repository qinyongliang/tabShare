package relay

import "encoding/base64"

type DownloadChunk struct {
	ID     string `json:"id"`
	Name   string `json:"name,omitempty"`
	MIME   string `json:"mime,omitempty"`
	Offset int64  `json:"offset"`
	Done   bool   `json:"done,omitempty"`
	Data   string `json:"data,omitempty"`
	SHA256 string `json:"sha256,omitempty"`
	Error  string `json:"error,omitempty"`
}

func validDownload(d *DownloadChunk) bool {
	if d == nil || !identifier.MatchString(d.ID) || len(d.Name) > 512 || len(d.MIME) > 128 || d.Offset < 0 || d.Offset > 1<<53-1 || len(d.Error) > 512 || len(d.Data) > 349528 {
		return false
	}
	if d.Error != "" {
		return d.Data == ""
	}
	bytes, err := base64.StdEncoding.DecodeString(d.Data)
	return err == nil && len(bytes) <= 256<<10 && d.Offset+int64(len(bytes)) <= 1<<53-1 && len(d.SHA256) == 64
}
