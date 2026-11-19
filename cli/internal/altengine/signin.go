package altengine

// "Sign in with altengine": OAuth for a native app, so a person never makes or pastes a key.
//
// The browser flow is the authorization code grant with PKCE and a loopback redirect (RFC 6749,
// RFC 7636, RFC 8252); a machine with no browser uses the device grant (RFC 8628). Either way what
// comes back is an ordinary `ae_…` API key, with no expiry, holding exactly what the person approved
// — so everything downstream (provisioning, upgrades) uses it as it would a pasted key.
//
// The contract is https://www.altengine.net/docs/sign-in-with-altengine/. Two parts of it shape
// this file:
//
//   - DutyBoard is not registered with altengine. Its client_id is the URL of a metadata document
//     served from dutyboard.com (site/src/altengine-client.json), which lists the loopback redirect.
//   - The key altengine issues for one app, person, organization and device_name is REPLACED when
//     the same machine signs in again. So device_name must be stable per machine, or every sign-in
//     would leave another key behind in the organization's key list.

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// ClientID is DutyBoard's client_id: the exact URL of its client metadata document. Not the apex
// domain — dutyboard.com redirects to www, and altengine does not follow redirects.
const ClientID = "https://www.dutyboard.com/altengine-client.json"

// ConsoleURL is hosted altengine's console, where the OAuth endpoints live.
const ConsoleURL = "https://console.altengine.net"

// NamePrefix is the start of every instance name a signed-in key can see or create. The scopes
// below ask for nothing outside it, so a key from signing in cannot touch anything else in the
// organization — and cannot even list it.
const NamePrefix = "dutyboard"

// Scopes is what DutyBoard asks for: listing and configuring instances (the control operations go
// through MCP, which these two make reachable), and full control of the instances named
// `dutyboard…` — full, because only full may create one. The function DutyBoard deploys is granted
// a subset of these, which is all altengine lets a key hand on.
var Scopes = []string{
	"org:read",
	"instances:write",
	"datastore:full:" + NamePrefix + "*",
	"auth:full:" + NamePrefix + "*",
	"channel:full:" + NamePrefix + "*",
	"blob:full:" + NamePrefix + "*",
	"search:full:" + NamePrefix + "*",
	"static:full:" + NamePrefix + "*",
	"tasks:full:" + NamePrefix + "*",
	"functions:full:" + NamePrefix + "*",
}

// SignInTimeout is how long a sign-in waits for the person. The code it ends in is good for ten
// minutes; a browser tab left open longer than that is a sign-in nobody is coming back to.
const SignInTimeout = 10 * time.Minute

var (
	// ErrSignInCancelled is the person declining on altengine's consent screen.
	ErrSignInCancelled = errors.New("sign-in was cancelled in the browser")
	// ErrDeviceFlowUnavailable is altengine not offering the device flow to DutyBoard (yet): it is
	// enabled per app by altengine's staff.
	ErrDeviceFlowUnavailable = errors.New("altengine does not offer sign-in without a browser to DutyBoard yet")
	// ErrDeviceCodeExpired is nobody approving the code in time.
	ErrDeviceCodeExpired = errors.New("the sign-in code expired before it was approved")
)

// CanSignIn reports whether an altengine at baseURL offers "Sign in with altengine": hosted only.
// The emulator has no OAuth, and takes any key anyway.
func CanSignIn(baseURL string) bool {
	if baseURL == "" {
		return true
	}
	return strings.TrimRight(baseURL, "/") == DefaultURL
}

// OAuth talks to altengine's authorization server. The zero value is hosted altengine as DutyBoard.
type OAuth struct {
	Console  string // default ConsoleURL
	ClientID string // default ClientID
	Scopes   []string
	HTTP     *http.Client
	// second is the unit the device flow's interval and slow_down are counted in. A test shrinks it.
	second time.Duration
}

func (o *OAuth) console() string {
	if o.Console != "" {
		return strings.TrimRight(o.Console, "/")
	}
	return ConsoleURL
}

func (o *OAuth) clientID() string {
	if o.ClientID != "" {
		return o.ClientID
	}
	return ClientID
}

func (o *OAuth) scopes() []string {
	if o.Scopes != nil {
		return o.Scopes
	}
	return Scopes
}

func (o *OAuth) http() *http.Client {
	if o.HTTP != nil {
		return o.HTTP
	}
	return &http.Client{Timeout: 30 * time.Second}
}

// Token is what signing in produces.
type Token struct {
	Key      string // the ae_… API key
	Scope    string // what was GRANTED, which the person's role can make narrower than asked
	KeyID    string
	KeyName  string
	OrgID    string
	OrgName  string
	Replaced bool // this machine's earlier key was replaced, not a new one added
}

// Missing is every scope asked for that the grant does not include.
func (o *OAuth) Missing(t *Token) []string {
	have := map[string]bool{}
	for _, s := range strings.Fields(t.Scope) {
		have[s] = true
	}
	var out []string
	for _, s := range o.scopes() {
		if !have[s] {
			out = append(out, s)
		}
	}
	return out
}

// InsufficientError is a grant that leaves out what provisioning needs.
type InsufficientError struct {
	OrgName string
	Missing []string
}

func (e *InsufficientError) Error() string {
	return fmt.Sprintf("altengine granted DutyBoard less than it needs in %s — missing %s. Your role there cannot grant it; "+
		"an owner of that organization can sign in instead, or paste a key", e.OrgName, strings.Join(e.Missing, ", "))
}

// Check refuses a token that cannot provision, and revokes it so it is not left in the
// organization's key list doing nothing.
func (o *OAuth) Check(ctx context.Context, t *Token) error {
	missing := o.Missing(t)
	if len(missing) == 0 {
		return nil
	}
	_ = o.Revoke(ctx, t.Key)
	return &InsufficientError{OrgName: t.OrgName, Missing: missing}
}

// pkce is one verifier and its S256 challenge, and the state that ties the callback to this run.
type pkce struct{ verifier, challenge, state string }

func newPKCE() (pkce, error) {
	v, err := random(32)
	if err != nil {
		return pkce{}, err
	}
	st, err := random(16)
	if err != nil {
		return pkce{}, err
	}
	return pkce{verifier: v, challenge: challengeOf(v), state: st}, nil
}

func challengeOf(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func random(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// DeviceName is this machine's name as altengine shows it on the consent screen and in the key's
// name. Stable on purpose: signing in again on this machine replaces its key rather than adding one.
func DeviceName() string {
	h, err := os.Hostname()
	if err != nil || strings.TrimSpace(h) == "" {
		return "this computer"
	}
	h = strings.TrimSpace(h)
	if len(h) > 64 {
		h = h[:64]
	}
	return h
}

// SignIn runs the browser flow: a one-off listener on a loopback port, the consent page opened with
// `open`, and the code it sends back exchanged for a key. It returns when the person approves or
// cancels, ctx is cancelled, or SignInTimeout passes.
func (o *OAuth) SignIn(ctx context.Context, deviceName string, open func(string) error) (*Token, error) {
	p, err := newPKCE()
	if err != nil {
		return nil, err
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("listening for the sign-in: %w", err)
	}
	redirect := fmt.Sprintf("http://127.0.0.1:%d/callback", ln.Addr().(*net.TCPAddr).Port)

	ctx, cancel := context.WithTimeout(ctx, SignInTimeout)
	defer cancel()

	type result struct {
		t   *Token
		err error
	}
	done := make(chan result, 1)
	finish := func(r result) {
		select {
		case done <- r:
		default:
		}
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/callback", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		// Anything on this machine can reach this port. A request without this run's state did
		// not come from altengine's redirect: refuse it and keep waiting for the one that will.
		if q.Get("state") != p.state {
			page(w, http.StatusBadRequest, "This sign-in link is not the one DutyBoard is waiting for.")
			return
		}
		if e := q.Get("error"); e != "" {
			if e == "access_denied" {
				page(w, http.StatusOK, "Sign-in cancelled. You can close this tab.")
				finish(result{err: ErrSignInCancelled})
				return
			}
			desc := q.Get("error_description")
			if desc == "" {
				desc = e
			}
			page(w, http.StatusBadRequest, "altengine could not sign you in: "+desc)
			finish(result{err: fmt.Errorf("altengine: %s", desc)})
			return
		}
		code := q.Get("code")
		if code == "" {
			page(w, http.StatusBadRequest, "altengine sent no code back.")
			finish(result{err: errors.New("altengine sent no code back")})
			return
		}
		t, err := o.token(r.Context(), url.Values{
			"grant_type":    {"authorization_code"},
			"code":          {code},
			"client_id":     {o.clientID()},
			"redirect_uri":  {redirect},
			"code_verifier": {p.verifier},
		})
		if err != nil {
			page(w, http.StatusBadGateway, "DutyBoard could not finish signing in: "+err.Error())
			finish(result{err: err})
			return
		}
		page(w, http.StatusOK, "Connected to "+t.OrgName+". You can close this tab and go back to DutyBoard.")
		finish(result{t: t})
	})
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = srv.Serve(ln) }()
	defer func() {
		// Let the page that says "connected" reach the browser before the listener goes.
		sctx, scancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer scancel()
		_ = srv.Shutdown(sctx)
	}()

	q := url.Values{
		"response_type":         {"code"},
		"client_id":             {o.clientID()},
		"redirect_uri":          {redirect},
		"code_challenge":        {p.challenge},
		"code_challenge_method": {"S256"},
		"state":                 {p.state},
		"scope":                 {strings.Join(o.scopes(), " ")},
		"device_name":           {deviceName},
	}
	if err := open(o.console() + "/api/oauth/authorize?" + q.Encode()); err != nil {
		return nil, fmt.Errorf("opening the browser: %w", err)
	}

	select {
	case r := <-done:
		return r.t, r.err
	case <-ctx.Done():
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return nil, errors.New("nobody finished signing in within 10 minutes")
		}
		return nil, ctx.Err()
	}
}

// DeviceCode is what a person needs to approve a device sign-in somewhere else.
type DeviceCode struct {
	DeviceCode              string `json:"device_code"`
	UserCode                string `json:"user_code"`
	VerificationURI         string `json:"verification_uri"`
	VerificationURIComplete string `json:"verification_uri_complete"`
	ExpiresIn               int    `json:"expires_in"`
	Interval                int    `json:"interval"`
}

// SignInDevice runs the device flow for a machine with no browser: `show` is told the code to enter
// and where, then this polls until the person approves, cancels, or the code expires.
func (o *OAuth) SignInDevice(ctx context.Context, deviceName string, show func(DeviceCode)) (*Token, error) {
	var dc DeviceCode
	if err := o.post(ctx, "/api/oauth/device_authorization", url.Values{
		"client_id":   {o.clientID()},
		"scope":       {strings.Join(o.scopes(), " ")},
		"device_name": {deviceName},
	}, &dc); err != nil {
		var oe *OAuthError
		if errors.As(err, &oe) && oe.Code == "unauthorized_client" {
			return nil, ErrDeviceFlowUnavailable
		}
		return nil, err
	}
	show(dc)

	unit := o.second
	if unit == 0 {
		unit = time.Second
	}
	interval := time.Duration(dc.Interval) * unit
	if interval <= 0 {
		interval = 5 * unit
	}
	expires := time.Duration(dc.ExpiresIn) * unit
	if expires <= 0 {
		expires = 900 * unit
	}
	ctx, cancel := context.WithTimeout(ctx, expires)
	defer cancel()
	for {
		select {
		case <-ctx.Done():
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				return nil, ErrDeviceCodeExpired
			}
			return nil, ctx.Err()
		case <-time.After(interval):
		}
		t, err := o.token(ctx, url.Values{
			"grant_type":  {"urn:ietf:params:oauth:grant-type:device_code"},
			"device_code": {dc.DeviceCode},
			"client_id":   {o.clientID()},
		})
		if err == nil {
			return t, nil
		}
		var oe *OAuthError
		if !errors.As(err, &oe) {
			return nil, err
		}
		switch oe.Code {
		case "authorization_pending":
		case "slow_down":
			interval += 5 * unit
		case "access_denied":
			return nil, ErrSignInCancelled
		case "expired_token":
			return nil, ErrDeviceCodeExpired
		default:
			return nil, err
		}
	}
}

// Revoke signs a key out: altengine deletes it. Only the app it was issued to may do this, and it
// always answers 200, so there is nothing to report but a network failure.
func (o *OAuth) Revoke(ctx context.Context, key string) error {
	return o.post(ctx, "/api/oauth/revoke", url.Values{"token": {key}, "client_id": {o.clientID()}}, nil)
}

// OAuthError is an error response from the authorization server (RFC 6749 §5.2).
type OAuthError struct {
	Status      int
	Code        string `json:"error"`
	Description string `json:"error_description"`
}

func (e *OAuthError) Error() string {
	if e.Description != "" {
		return fmt.Sprintf("altengine: %s (%s)", e.Description, e.Code)
	}
	return fmt.Sprintf("altengine: %s (HTTP %d)", e.Code, e.Status)
}

func (o *OAuth) token(ctx context.Context, form url.Values) (*Token, error) {
	var out struct {
		AccessToken string `json:"access_token"`
		TokenType   string `json:"token_type"`
		Scope       string `json:"scope"`
		Altengine   struct {
			KeyID    string `json:"key_id"`
			KeyName  string `json:"key_name"`
			OrgID    string `json:"org_id"`
			OrgName  string `json:"org_name"`
			Replaced bool   `json:"replaced"`
		} `json:"altengine"`
	}
	if err := o.post(ctx, "/api/oauth/token", form, &out); err != nil {
		return nil, err
	}
	if out.AccessToken == "" {
		return nil, errors.New("altengine answered the sign-in with no key")
	}
	return &Token{
		Key: out.AccessToken, Scope: out.Scope,
		KeyID: out.Altengine.KeyID, KeyName: out.Altengine.KeyName,
		OrgID: out.Altengine.OrgID, OrgName: out.Altengine.OrgName, Replaced: out.Altengine.Replaced,
	}, nil
}

// post sends a form to the authorization server and decodes a 2xx answer into out.
func (o *OAuth) post(ctx context.Context, path string, form url.Values, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, o.console()+path, strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	res, err := o.http().Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode/100 != 2 {
		oe := &OAuthError{Status: res.StatusCode}
		if json.Unmarshal(body, oe) != nil || oe.Code == "" {
			oe.Code = strings.TrimSpace(string(body))
			if len(oe.Code) > 200 {
				oe.Code = oe.Code[:200]
			}
		}
		return oe
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("altengine answered %s with something that is not JSON: %w", path, err)
	}
	return nil
}

// page is what the browser tab shows when altengine sends it back here.
func page(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	fmt.Fprintf(w, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`+
		`<title>DutyBoard</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;`+
		`background:#f6f7f9;color:#1b1f24}@media(prefers-color-scheme:dark){body{background:#111317;color:#e6e8eb}}`+
		`main{max-width:28rem;padding:2rem;text-align:center}</style></head><body><main><h1>DutyBoard</h1><p>%s</p></main></body></html>`,
		html.EscapeString(message))
}
