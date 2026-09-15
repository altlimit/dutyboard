// Package localmcp is the bridge between an agent and the daemon.
//
// Claude starts `dutyboard mcp` as an MCP server over stdio. That process holds no key and knows
// nothing about boards: it passes each JSON-RPC message to the running daemon, which decides what
// the message may do — which board, which duty, which agent — adds the machine key, and forwards it.
// So the key never leaves the daemon, and a session cannot reach a board or a duty it was not given.
//
// The daemon listens on a loopback TCP port and writes its address and a random secret to
// run/daemon.json, readable only by this user. A plain socket file would do on Unix; loopback plus a
// secret works the same on Windows, with one code path. Anything running as this user can read the
// secret, exactly as it could read the key itself — this guards against mistakes and other users,
// not against this user's own processes.
package localmcp

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"sync"
	"time"

	"github.com/altlimit/dutyboard/cli/internal/state"
)

// Handler is the daemon's side.
type Handler interface {
	// MCP answers one JSON-RPC message; nil for a notification. runToken names a session the daemon
	// started (empty for an interactive session), and cwd is where that session is working.
	MCP(ctx context.Context, runToken, cwd string, message json.RawMessage) (json.RawMessage, error)
	// Reload re-reads links and settings, after another invocation linked a folder.
	Reload()
	// Stop shuts the daemon down as Ctrl+C would: sessions end, and the duties they held are resumed
	// when it starts again.
	Stop()
}

// Endpoint is run/daemon.json.
type Endpoint struct {
	Addr   string `json:"addr"`
	Secret string `json:"secret"`
	PID    int    `json:"pid"`
}

func endpointPath() string { return state.Path("run", "daemon.json") }

type request struct {
	Secret   string          `json:"secret"`
	Op       string          `json:"op"`
	RunToken string          `json:"run_token,omitempty"`
	Cwd      string          `json:"cwd,omitempty"`
	Message  json.RawMessage `json:"message,omitempty"`
}

type response struct {
	Reply json.RawMessage `json:"reply,omitempty"`
	Error string          `json:"error,omitempty"`
}

// Serve listens until ctx ends.
func Serve(ctx context.Context, h Handler) error {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	secretBytes := make([]byte, 32)
	if _, err := rand.Read(secretBytes); err != nil {
		return err
	}
	ep := Endpoint{Addr: ln.Addr().String(), Secret: hex.EncodeToString(secretBytes), PID: os.Getpid()}
	if err := os.MkdirAll(state.Path("run"), 0o700); err != nil {
		return err
	}
	if err := state.WriteJSON(endpointPath(), ep, 0o600); err != nil {
		return err
	}
	go func() {
		<-ctx.Done()
		ln.Close()
		_ = os.Remove(endpointPath())
	}()
	for {
		c, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			continue
		}
		go serveConn(ctx, c, h, ep.Secret)
	}
}

func serveConn(ctx context.Context, c net.Conn, h Handler, secret string) {
	defer c.Close()
	r := bufio.NewReaderSize(c, 1<<20)
	enc := json.NewEncoder(c)
	for {
		line, err := r.ReadBytes('\n')
		if err != nil {
			return
		}
		var req request
		if json.Unmarshal(line, &req) != nil || req.Secret != secret {
			_ = enc.Encode(response{Error: "refused"})
			return
		}
		switch req.Op {
		case "mcp":
			reply, err := h.MCP(ctx, req.RunToken, req.Cwd, req.Message)
			res := response{Reply: reply}
			if err != nil {
				res.Error = err.Error()
			}
			_ = enc.Encode(res)
		case "reload":
			h.Reload()
			_ = enc.Encode(response{})
		case "stop":
			_ = enc.Encode(response{})
			h.Stop()
		case "ping":
			_ = enc.Encode(response{})
		default:
			_ = enc.Encode(response{Error: "unknown op " + req.Op})
		}
	}
}

// Client is a connection to the running daemon.
type Client struct {
	mu     sync.Mutex
	ep     Endpoint
	conn   net.Conn
	reader *bufio.Reader
}

// ErrNotRunning is no daemon on this machine.
var ErrNotRunning = errors.New("the dutyboard daemon is not running on this machine — start it with `dutyboard`")

// Dial connects to the running daemon.
func Dial() (*Client, error) {
	var ep Endpoint
	b, err := os.ReadFile(endpointPath())
	if err != nil {
		return nil, ErrNotRunning
	}
	if json.Unmarshal(b, &ep) != nil {
		return nil, ErrNotRunning
	}
	c := &Client{ep: ep}
	if err := c.connect(); err != nil {
		return nil, ErrNotRunning
	}
	return c, nil
}

func (c *Client) connect() error {
	conn, err := net.DialTimeout("tcp", c.ep.Addr, 3*time.Second)
	if err != nil {
		return err
	}
	c.conn, c.reader = conn, bufio.NewReaderSize(conn, 1<<20)
	return nil
}

// Close closes the connection.
func (c *Client) Close() error {
	if c.conn != nil {
		return c.conn.Close()
	}
	return nil
}

func (c *Client) do(req request) (*response, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	req.Secret = c.ep.Secret
	b, _ := json.Marshal(req)
	for attempt := 0; attempt < 2; attempt++ {
		if c.conn == nil {
			if err := c.connect(); err != nil {
				return nil, ErrNotRunning
			}
		}
		if _, err := c.conn.Write(append(b, '\n')); err == nil {
			line, err := c.reader.ReadBytes('\n')
			if err == nil {
				var res response
				if err := json.Unmarshal(line, &res); err != nil {
					return nil, err
				}
				return &res, nil
			}
		}
		c.conn.Close()
		c.conn = nil
	}
	return nil, ErrNotRunning
}

// Reload tells the daemon its links changed.
func (c *Client) Reload() error {
	res, err := c.do(request{Op: "reload"})
	if err != nil {
		return err
	}
	if res.Error != "" {
		return errors.New(res.Error)
	}
	return nil
}

// Stop asks the daemon to shut down, and waits up to `within` for it to be gone.
func (c *Client) Stop(within time.Duration) error {
	res, err := c.do(request{Op: "stop"})
	if err != nil {
		return err
	}
	if res.Error != "" {
		return errors.New(res.Error)
	}
	c.Close()
	deadline := time.Now().Add(within)
	for Running() {
		if time.Now().After(deadline) {
			return fmt.Errorf("dutyboard was asked to stop and is still running after %s", within)
		}
		time.Sleep(300 * time.Millisecond)
	}
	return nil
}

// Running reports whether a daemon answers.
func Running() bool {
	c, err := Dial()
	if err != nil {
		return false
	}
	defer c.Close()
	_, err = c.do(request{Op: "ping"})
	return err == nil
}

// ServeStdio is `dutyboard mcp`: MCP over stdio, one JSON-RPC message per line, each answered by
// the daemon. A daemon that is not running is reported to the agent as an error on every request,
// rather than the server failing to start — an agent can say "the daemon is down"; a missing
// server it cannot explain.
func ServeStdio(ctx context.Context, in io.Reader, out io.Writer) error {
	runToken := os.Getenv("DUTYBOARD_RUN_TOKEN")
	cwd, _ := os.Getwd()
	sc := bufio.NewScanner(in)
	sc.Buffer(make([]byte, 1<<20), 16<<20)
	w := bufio.NewWriter(out)
	var client *Client
	for sc.Scan() {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		line := append([]byte(nil), sc.Bytes()...)
		if len(line) == 0 {
			continue
		}
		var head struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		_ = json.Unmarshal(line, &head)
		notification := len(head.ID) == 0 || string(head.ID) == "null"

		if client == nil {
			client, _ = Dial()
		}
		var reply json.RawMessage
		var failure string
		if client == nil {
			failure = ErrNotRunning.Error()
		} else if res, err := client.do(request{Op: "mcp", RunToken: runToken, Cwd: cwd, Message: line}); err != nil {
			failure = err.Error()
			client = nil
		} else if res.Error != "" {
			failure = res.Error
		} else {
			reply = res.Reply
		}
		if notification {
			continue
		}
		if failure != "" {
			reply, _ = json.Marshal(map[string]any{
				"jsonrpc": "2.0", "id": head.ID,
				"error": map[string]any{"code": -32000, "message": failure},
			})
		}
		if len(reply) == 0 {
			continue
		}
		if _, err := fmt.Fprintf(w, "%s\n", reply); err != nil {
			return err
		}
		if err := w.Flush(); err != nil {
			return err
		}
	}
	return sc.Err()
}
