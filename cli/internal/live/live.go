// Package live keeps the daemon's socket to DutyBoard's channels open.
//
// It is how work reaches a machine within seconds instead of on its next poll: board channels carry
// every duty transition, and the machine's own channel carries commands. Nothing here is trusted to
// be complete — the platform drops a publish it cannot deliver, and a socket can be down — so every
// (re)connect tells the caller, which answers by polling everything once.
package live

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"regexp"
	"time"

	"github.com/coder/websocket"
)

// Event is one delivery on a channel.
type Event struct {
	Channel string         `json:"channel"`
	Data    map[string]any `json:"data"`
}

// T is the event's type field (`duty`, `thread`, `board`, `runner`, `setup`, …).
func (e Event) T() string { s, _ := e.Data["t"].(string); return s }

// Str reads a string field of the event.
func (e Event) Str(k string) string { s, _ := e.Data[k].(string); return s }

// Token is a minted subscribe token.
type Token struct {
	Token     string
	WSURL     string
	ExpiresAt int64
	Channels  []string
}

// Options configure a Run.
type Options struct {
	// Mint answers a fresh token. Called on every connect and before every rotation.
	Mint func(ctx context.Context) (*Token, error)
	// Server is the DutyBoard function URL; locally its origin replaces the socket host the token
	// names, which an emulator reports from its own point of view.
	Server string
	// OnEvent receives every delivery.
	OnEvent func(Event)
	// OnConnected is called after each successful subscribe — the moment to catch up by polling.
	OnConnected func()
	// OnState reports "connecting", "live", "reconnecting".
	OnState func(string)
}

var loopback = regexp.MustCompile(`^https?://(127\.0\.0\.1|localhost|\[::1\])(:|/|$)`)

// rotateBefore is how long before expiry a token is replaced. The platform closes a socket AT
// expiry; replacing it earlier, with the new socket subscribed before the old one closes, means
// there is never a moment with neither.
const rotateBefore = 10 * time.Minute

// Run keeps a subscription alive until ctx ends.
func Run(ctx context.Context, o Options) error {
	state := func(s string) {
		if o.OnState != nil {
			o.OnState(s)
		}
	}
	attempt := 0
	var current *conn
	for {
		if ctx.Err() != nil {
			if current != nil {
				current.close()
			}
			return ctx.Err()
		}
		if current == nil {
			state("connecting")
			c, err := o.dial(ctx)
			if err != nil {
				attempt++
				state("reconnecting")
				if !sleep(ctx, backoff(attempt)) {
					return ctx.Err()
				}
				continue
			}
			attempt = 0
			current = c
			state("live")
			if o.OnConnected != nil {
				o.OnConnected()
			}
		}

		rotate := time.Until(time.Unix(current.expiresAt, 0).Add(-rotateBefore))
		if current.expiresAt == 0 || rotate < time.Minute {
			rotate = 50 * time.Minute
		}
		select {
		case <-ctx.Done():
		case <-current.done:
			current = nil
			state("reconnecting")
		case <-time.After(rotate):
			next, err := o.dial(ctx)
			if err != nil {
				continue // keep the old one until it actually closes; the next loop retries
			}
			current.close()
			current = next
			if o.OnConnected != nil {
				o.OnConnected()
			}
		}
	}
}

type conn struct {
	ws        *websocket.Conn
	done      chan struct{}
	expiresAt int64
	cancel    context.CancelFunc
}

func (c *conn) close() {
	c.cancel()
	_ = c.ws.Close(websocket.StatusNormalClosure, "")
}

func (o Options) dial(ctx context.Context) (*conn, error) {
	tok, err := o.Mint(ctx)
	if err != nil {
		return nil, err
	}
	u, err := socketURL(tok, o.Server)
	if err != nil {
		return nil, err
	}
	dialCtx, cancelDial := context.WithTimeout(ctx, 15*time.Second)
	defer cancelDial()
	ws, _, err := websocket.Dial(dialCtx, u, nil)
	if err != nil {
		return nil, err
	}
	ws.SetReadLimit(1 << 20)
	sub, _ := json.Marshal(map[string]any{"type": "subscribe", "channels": tok.Channels})
	if err := ws.Write(dialCtx, websocket.MessageText, sub); err != nil {
		_ = ws.Close(websocket.StatusInternalError, "")
		return nil, err
	}
	// Wait for the acknowledgement before calling this connected: until then, a publish can still
	// miss us, and the caller's catch-up poll would run too early to cover it.
	for {
		_, msg, err := ws.Read(dialCtx)
		if err != nil {
			_ = ws.Close(websocket.StatusInternalError, "")
			return nil, err
		}
		var frame struct {
			Type    string `json:"type"`
			Message string `json:"message"`
		}
		_ = json.Unmarshal(msg, &frame)
		if frame.Type == "subscribed" {
			break
		}
		if frame.Type == "error" {
			_ = ws.Close(websocket.StatusPolicyViolation, "")
			return nil, errors.New("subscribe refused: " + frame.Message)
		}
	}

	readCtx, cancel := context.WithCancel(ctx)
	c := &conn{ws: ws, done: make(chan struct{}), expiresAt: tok.ExpiresAt, cancel: cancel}
	go func() {
		defer close(c.done)
		for {
			_, msg, err := ws.Read(readCtx)
			if err != nil {
				return
			}
			var ev Event
			var head struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(msg, &head) == nil && head.Type != "" {
				continue // a control frame
			}
			if json.Unmarshal(msg, &ev) == nil && ev.Channel != "" && o.OnEvent != nil {
				o.OnEvent(ev)
			}
		}
	}()
	return c, nil
}

func socketURL(tok *Token, server string) (string, error) {
	if tok.WSURL == "" {
		return "", errors.New("the channel token names no socket URL")
	}
	u, err := url.Parse(tok.WSURL)
	if err != nil {
		return "", err
	}
	if loopback.MatchString(server) {
		s, err := url.Parse(server)
		if err == nil {
			u.Host = s.Host
			u.Scheme = map[string]string{"https": "wss"}[s.Scheme]
			if u.Scheme == "" {
				u.Scheme = "ws"
			}
		}
	}
	q := u.Query()
	if q.Get("token") == "" {
		q.Set("token", tok.Token)
		u.RawQuery = q.Encode()
	}
	return u.String(), nil
}

func backoff(attempt int) time.Duration {
	d := 500 * time.Millisecond << min(attempt-1, 5)
	if d > 15*time.Second {
		d = 15 * time.Second
	}
	return d
}

func sleep(ctx context.Context, d time.Duration) bool {
	select {
	case <-ctx.Done():
		return false
	case <-time.After(d):
		return true
	}
}
