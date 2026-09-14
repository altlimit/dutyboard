// Package altengine talks to an altengine deployment: the hosted service or a local emulator.
//
// Two control planes, one intent — the same split the old scripts/setup.mjs made. Hosted, an API key
// provisions through the MCP endpoint, which exposes the control operations as tools; the data
// plane (/v1/...) takes the rest. Locally, the emulator's admin API (/admin/...) is unauthenticated
// and can do everything. Which one applies is decided by the URL, not by a flag someone forgets.
package altengine

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync/atomic"
	"time"
)

// DefaultURL is hosted altengine's API origin.
const DefaultURL = "https://api.altengine.net"

var loopback = regexp.MustCompile(`^https?://(127\.0\.0\.1|localhost|\[::1\])(:|/|$)`)

// Client is one altengine, reached with one key.
type Client struct {
	BaseURL string
	Key     string
	HTTP    *http.Client
	// Hosted forces the hosted control plane on a loopback address — a tunnel to hosted altengine,
	// or a test standing in for it.
	Hosted bool
	rpcID  atomic.Int64
}

// New returns a client for baseURL (DefaultURL when empty).
func New(baseURL, key string) *Client {
	if baseURL == "" {
		baseURL = DefaultURL
	}
	return &Client{
		BaseURL: strings.TrimRight(baseURL, "/"),
		Key:     key,
		HTTP:    &http.Client{Timeout: 2 * time.Minute},
	}
}

// Local reports whether this is an emulator on this machine.
func (c *Client) Local() bool { return !c.Hosted && loopback.MatchString(c.BaseURL) }

// APIError is a non-2xx answer from the data plane or the admin API.
type APIError struct {
	Status  int
	Code    string
	Message string
	Body    string
}

func (e *APIError) Error() string {
	if e.Message != "" {
		return fmt.Sprintf("%d %s: %s", e.Status, e.Code, e.Message)
	}
	return fmt.Sprintf("%d: %s", e.Status, strings.TrimSpace(e.Body))
}

// ToolError is an MCP tool that answered isError: the platform's refusal, as text.
type ToolError struct {
	Tool    string
	Message string
}

func (e *ToolError) Error() string { return e.Tool + ": " + e.Message }

// IsStatus reports whether err is an APIError with this status.
func IsStatus(err error, status int) bool {
	var ae *APIError
	return errors.As(err, &ae) && ae.Status == status
}

// Do sends one JSON request to the data plane or admin API and decodes the answer into out (which
// may be nil). A 204 decodes nothing.
func (c *Client) Do(ctx context.Context, method, path string, body, out any) error {
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, rdr)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("content-type", "application/json")
	}
	if c.Key != "" {
		req.Header.Set("authorization", "Bearer "+c.Key)
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 32<<20))
	if err != nil {
		return err
	}
	if res.StatusCode >= 300 {
		ae := &APIError{Status: res.StatusCode, Body: string(raw)}
		var env struct {
			Error struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(raw, &env) == nil {
			ae.Code, ae.Message = env.Error.Code, env.Error.Message
		}
		return ae
	}
	if out == nil || res.StatusCode == http.StatusNoContent || len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	return json.Unmarshal(raw, out)
}

// Tool calls one MCP tool and decodes its result into out.
//
// The hosted endpoint is stateless — no initialize, no session — so a call is one POST. A tool
// that refuses answers isError with the reason as text rather than a JSON-RPC error, and both
// shapes are read, or a refusal would look like success.
func (c *Client) Tool(ctx context.Context, name string, args, out any) error {
	if args == nil {
		args = map[string]any{}
	}
	msg := map[string]any{
		"jsonrpc": "2.0",
		"id":      c.rpcID.Add(1),
		"method":  "tools/call",
		"params":  map[string]any{"name": name, "arguments": args},
	}
	var env struct {
		Result *struct {
			IsError           bool            `json:"isError"`
			StructuredContent json.RawMessage `json:"structuredContent"`
			Content           []struct {
				Text string `json:"text"`
			} `json:"content"`
		} `json:"result"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := c.Do(ctx, http.MethodPost, "/mcp", msg, &env); err != nil {
		if IsStatus(err, 401) || IsStatus(err, 403) {
			return fmt.Errorf("%s: the key needs CONTROL access to instances and functions (Settings → API keys), not just data access: %w", name, err)
		}
		return fmt.Errorf("%s: %w", name, err)
	}
	if env.Error != nil {
		return &ToolError{Tool: name, Message: env.Error.Message}
	}
	if env.Result == nil {
		return &ToolError{Tool: name, Message: "empty answer"}
	}
	text := ""
	if len(env.Result.Content) > 0 {
		text = env.Result.Content[0].Text
	}
	if env.Result.IsError {
		return &ToolError{Tool: name, Message: text}
	}
	if out == nil {
		return nil
	}
	if len(env.Result.StructuredContent) > 0 && string(env.Result.StructuredContent) != "null" {
		return json.Unmarshal(env.Result.StructuredContent, out)
	}
	return json.Unmarshal([]byte(text), out)
}

// Esc escapes one path segment.
func Esc(s string) string { return url.PathEscape(s) }
