package board

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// Files on a duty, as a machine moves them: a board of one-off tasks hands its session the files a
// person attached, in a folder, and puts the files the session made back on the duty.

// Attachment is one file on a duty, with a short-lived URL to fetch it by while it is not Pending.
type Attachment struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	ContentType string `json:"content_type"`
	Size        int64  `json:"size"`
	AuthorType  string `json:"author_type"` // "human" or "agent"
	URL         string `json:"url"`
	Pending     bool   `json:"pending"` // reserved, and its bytes not arrived yet
}

// Attachments lists the files on a duty.
func (c *Client) Attachments(ctx context.Context, board, dutyID string) ([]Attachment, error) {
	var out struct {
		Attachments []Attachment `json:"attachments"`
	}
	return out.Attachments, c.Call(ctx, "/duty/attachments", board, map[string]any{"duty_id": dutyID}, &out)
}

// transfers move file bodies, which can take longer than an API call is allowed; the caller's context
// bounds them instead.
var transfers = &http.Client{}

// Download saves an attachment to path.
func (c *Client) Download(ctx context.Context, a Attachment, path string) error {
	if a.URL == "" {
		return fmt.Errorf("%s has no URL to fetch it by yet", a.Name)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.URL, nil)
	if err != nil {
		return err
	}
	res, err := transfers.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		return fmt.Errorf("fetching %s: %s", a.Name, res.Status)
	}
	tmp := path + ".part"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, res.Body); err != nil {
		f.Close()
		os.Remove(tmp)
		return fmt.Errorf("fetching %s: %w", a.Name, err)
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// inlineLimit is the most the board stores from an inline upload; anything larger is PUT to storage.
const inlineLimit = 2 << 20

// AttachFile puts the file at path on a duty, named name.
func (c *Client) AttachFile(ctx context.Context, board, dutyID, agentID, name, path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if info.Size() == 0 {
		return fmt.Errorf("%s is empty", name)
	}
	contentType := contentTypeOf(path)
	if info.Size() <= inlineLimit {
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return c.Attach(ctx, board, dutyID, agentID, name, contentType, b)
	}
	var minted struct {
		UploadURL       string            `json:"upload_url"`
		RequiredHeaders map[string]string `json:"required_headers"`
	}
	if err := c.Call(ctx, "/duty/attach", board, map[string]any{
		"duty_id": dutyID, "agent_id": agentID, "name": name, "content_type": contentType, "size": info.Size(),
	}, &minted); err != nil {
		return err
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, minted.UploadURL, f)
	if err != nil {
		return err
	}
	req.ContentLength = info.Size()
	for k, v := range minted.RequiredHeaders {
		req.Header.Set(k, v)
	}
	if req.Header.Get("content-type") == "" {
		req.Header.Set("content-type", contentType)
	}
	res, err := transfers.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(res.Body, 2000))
		return fmt.Errorf("uploading %s: %s %s", name, res.Status, strings.TrimSpace(string(body)))
	}
	return nil
}

// contentTypeOf names a file's type from its first bytes, and its extension where those say little.
func contentTypeOf(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return "application/octet-stream"
	}
	defer f.Close()
	head := make([]byte, 512)
	n, _ := io.ReadFull(f, head)
	sniffed := http.DetectContentType(head[:n])
	if sniffed != "application/octet-stream" && !strings.HasPrefix(sniffed, "text/plain") {
		return sniffed
	}
	switch strings.ToLower(filepath.Ext(path)) {
	case ".md":
		return "text/markdown; charset=utf-8"
	case ".csv":
		return "text/csv; charset=utf-8"
	case ".json":
		return "application/json"
	case ".docx":
		return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
	case ".xlsx":
		return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	case ".pptx":
		return "application/vnd.openxmlformats-officedocument.presentationml.presentation"
	}
	return sniffed
}
