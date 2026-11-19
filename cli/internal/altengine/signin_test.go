package altengine

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

// RFC 7636 Appendix B: the one verifier/challenge pair everyone checks against.
func TestChallengeIsS256OfTheVerifier(t *testing.T) {
	if got := challengeOf("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"); got != "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM" {
		t.Fatalf("challenge = %s", got)
	}
	p, err := newPKCE()
	if err != nil {
		t.Fatal(err)
	}
	if len(p.verifier) < 43 || len(p.verifier) > 128 || strings.ContainsAny(p.verifier, "+/=") {
		t.Errorf("verifier %q is not 43–128 unreserved characters", p.verifier)
	}
	if p.challenge != challengeOf(p.verifier) || p.state == "" {
		t.Errorf("pkce = %+v", p)
	}
	q, _ := newPKCE()
	if q.verifier == p.verifier || q.state == p.state {
		t.Error("two sign-ins share a verifier or a state")
	}
}

// fakeConsole is altengine's authorization server, as far as the contract describes it.
type fakeConsole struct {
	t   *testing.T
	srv *httptest.Server

	mu         sync.Mutex
	challenges map[string]string // code → the challenge it was issued for
	redirects  map[string]string // code → the redirect_uri it was issued for
	grant      string            // the scope the token response reports
	polls      []string          // device token answers, in order; "" is success
	deviceErr  string            // device_authorization's error, if any
	revoked    []string
	forms      []url.Values
}

func newConsole(t *testing.T) *fakeConsole {
	f := &fakeConsole{t: t, challenges: map[string]string{}, redirects: map[string]string{}, grant: strings.Join(Scopes, " ")}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeConsole) oauth() *OAuth {
	return &OAuth{Console: f.srv.URL, HTTP: f.srv.Client(), second: time.Millisecond}
}

func oauthErr(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": code, "error_description": code + " described"})
}

func (f *fakeConsole) key(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"access_token": "ae_signed_in", "token_type": "Bearer", "scope": f.grant,
		"altengine": map[string]any{"key_id": "k1", "key_name": "DutyBoard — hakan — HAKAN-PC", "org_id": "o1", "org_name": "Hakan's org", "replaced": true},
	})
}

func (f *fakeConsole) serve(w http.ResponseWriter, r *http.Request) {
	_ = r.ParseForm()
	f.mu.Lock()
	defer f.mu.Unlock()
	f.forms = append(f.forms, r.PostForm)
	if r.Header.Get("Content-Type") != "application/x-www-form-urlencoded" && r.Method == http.MethodPost {
		f.t.Errorf("%s was not form-encoded", r.URL.Path)
	}
	switch r.URL.Path {
	case "/api/oauth/token":
		switch r.PostForm.Get("grant_type") {
		case "authorization_code":
			code := r.PostForm.Get("code")
			want, ok := f.challenges[code]
			delete(f.challenges, code) // single use
			if !ok || challengeOf(r.PostForm.Get("code_verifier")) != want || r.PostForm.Get("redirect_uri") != f.redirects[code] ||
				r.PostForm.Get("client_id") != ClientID {
				oauthErr(w, 400, "invalid_grant")
				return
			}
			f.key(w)
		case "urn:ietf:params:oauth:grant-type:device_code":
			if r.PostForm.Get("device_code") != "dev-123" {
				oauthErr(w, 400, "invalid_grant")
				return
			}
			next := ""
			if len(f.polls) > 0 {
				next, f.polls = f.polls[0], f.polls[1:]
			}
			if next != "" {
				oauthErr(w, 400, next)
				return
			}
			f.key(w)
		default:
			oauthErr(w, 400, "unsupported_grant_type")
		}
	case "/api/oauth/device_authorization":
		if f.deviceErr != "" {
			oauthErr(w, 400, f.deviceErr)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(DeviceCode{DeviceCode: "dev-123", UserCode: "ABCD-EFGH", VerificationURI: "https://console.example/device",
			VerificationURIComplete: "https://console.example/device?user_code=ABCD-EFGH", ExpiresIn: 900, Interval: 1})
	case "/api/oauth/revoke":
		f.revoked = append(f.revoked, r.PostForm.Get("token"))
	default:
		http.NotFound(w, r)
	}
}

// browser stands in for the person's browser: it reads the authorize URL, "approves" (or not) on
// the fake console, and follows the redirect back to the app's loopback listener.
func (f *fakeConsole) browser(t *testing.T, act func(authorize *url.URL, redirect string, state string)) func(string) error {
	return func(raw string) error {
		u, err := url.Parse(raw)
		if err != nil {
			return err
		}
		q := u.Query()
		if u.Path != "/api/oauth/authorize" || q.Get("response_type") != "code" || q.Get("code_challenge_method") != "S256" ||
			q.Get("client_id") != ClientID || q.Get("scope") != strings.Join(Scopes, " ") || q.Get("device_name") != "HAKAN-PC" {
			t.Errorf("authorize URL is wrong: %s", raw)
		}
		redirect := q.Get("redirect_uri")
		if !strings.HasPrefix(redirect, "http://127.0.0.1:") || !strings.HasSuffix(redirect, "/callback") {
			t.Errorf("redirect_uri %q is not a loopback callback", redirect)
		}
		go act(u, redirect, q.Get("state"))
		return nil
	}
}

func visit(t *testing.T, redirect string, q url.Values) (int, string) {
	t.Helper()
	res, err := http.Get(redirect + "?" + q.Encode())
	if err != nil {
		t.Errorf("visiting the callback: %v", err)
		return 0, ""
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(b)
}

func TestSignInExchangesTheCodeForAKey(t *testing.T) {
	f := newConsole(t)
	var wrongState int
	tok, err := f.oauth().SignIn(context.Background(), "HAKAN-PC", f.browser(t, func(u *url.URL, redirect, state string) {
		f.mu.Lock()
		f.challenges["code-1"] = u.Query().Get("code_challenge")
		f.redirects["code-1"] = redirect
		f.mu.Unlock()
		// Something else on the machine calls the port first, without the state: refused, and the
		// sign-in keeps waiting for the real redirect.
		wrongState, _ = visit(t, redirect, url.Values{"code": {"code-1"}, "state": {"not-it"}})
		status, body := visit(t, redirect, url.Values{"code": {"code-1"}, "state": {state}})
		if status != 200 || !strings.Contains(body, "Connected to Hakan&#39;s org") {
			t.Errorf("browser shown %d %q", status, body)
		}
	}))
	if err != nil {
		t.Fatal(err)
	}
	if wrongState != http.StatusBadRequest {
		t.Errorf("a callback with the wrong state answered %d", wrongState)
	}
	if tok.Key != "ae_signed_in" || tok.OrgName != "Hakan's org" || !tok.Replaced || tok.KeyName == "" {
		t.Errorf("token = %+v", tok)
	}
	if m := f.oauth().Missing(tok); len(m) != 0 {
		t.Errorf("a full grant reports missing %v", m)
	}
}

func TestSignInCancelledInTheBrowser(t *testing.T) {
	f := newConsole(t)
	start := time.Now()
	_, err := f.oauth().SignIn(context.Background(), "HAKAN-PC", f.browser(t, func(_ *url.URL, redirect, state string) {
		visit(t, redirect, url.Values{"error": {"access_denied"}, "state": {state}})
	}))
	if !errors.Is(err, ErrSignInCancelled) {
		t.Fatalf("err = %v", err)
	}
	if time.Since(start) > 5*time.Second {
		t.Error("a cancel should end the wait at once")
	}
}

func TestSignInReportsOtherErrors(t *testing.T) {
	f := newConsole(t)
	_, err := f.oauth().SignIn(context.Background(), "HAKAN-PC", f.browser(t, func(_ *url.URL, redirect, state string) {
		visit(t, redirect, url.Values{"error": {"invalid_scope"}, "error_description": {"scope 'x' is unknown"}, "state": {state}})
	}))
	if err == nil || !strings.Contains(err.Error(), "scope 'x' is unknown") {
		t.Fatalf("err = %v", err)
	}
}

func TestSignInAVerifierThatDoesNotMatchFails(t *testing.T) {
	f := newConsole(t)
	_, err := f.oauth().SignIn(context.Background(), "HAKAN-PC", f.browser(t, func(_ *url.URL, redirect, state string) {
		f.mu.Lock()
		f.challenges["code-2"] = challengeOf("some-other-verifier-entirely-xxxxxxxxxxxxxxxxxx")
		f.redirects["code-2"] = redirect
		f.mu.Unlock()
		visit(t, redirect, url.Values{"code": {"code-2"}, "state": {state}})
	}))
	var oe *OAuthError
	if !errors.As(err, &oe) || oe.Code != "invalid_grant" {
		t.Fatalf("err = %v", err)
	}
}

func TestSignInStopsWhenTheAppCancels(t *testing.T) {
	f := newConsole(t)
	ctx, cancel := context.WithCancel(context.Background())
	_, err := f.oauth().SignIn(ctx, "HAKAN-PC", func(string) error { cancel(); return nil })
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
}

func TestCheckRefusesANarrowerGrantAndRevokesIt(t *testing.T) {
	f := newConsole(t)
	o := f.oauth()
	tok := &Token{Key: "ae_narrow", OrgName: "Acme", Scope: strings.Join(Scopes[:len(Scopes)-1], " ")}
	err := o.Check(context.Background(), tok)
	var ie *InsufficientError
	if !errors.As(err, &ie) || len(ie.Missing) != 1 || ie.Missing[0] != "functions:full:dutyboard*" {
		t.Fatalf("err = %v", err)
	}
	if !strings.Contains(err.Error(), "an owner of that organization") {
		t.Errorf("the error should say who can authorize instead: %v", err)
	}
	if len(f.revoked) != 1 || f.revoked[0] != "ae_narrow" {
		t.Errorf("a key that cannot provision was left behind: %v", f.revoked)
	}
}

func TestDeviceFlowPollsUntilApproved(t *testing.T) {
	f := newConsole(t)
	f.polls = []string{"authorization_pending", "slow_down", "authorization_pending", ""}
	var shown DeviceCode
	tok, err := f.oauth().SignInDevice(context.Background(), "HAKAN-PC", func(dc DeviceCode) { shown = dc })
	if err != nil {
		t.Fatal(err)
	}
	if shown.UserCode != "ABCD-EFGH" || shown.VerificationURI == "" {
		t.Errorf("shown %+v", shown)
	}
	if tok.Key != "ae_signed_in" {
		t.Errorf("token = %+v", tok)
	}
	first := f.forms[0]
	if first.Get("client_id") != ClientID || first.Get("device_name") != "HAKAN-PC" || first.Get("scope") != strings.Join(Scopes, " ") {
		t.Errorf("device authorization form = %v", first)
	}
	if len(f.polls) != 0 {
		t.Errorf("stopped polling early: %v left", f.polls)
	}
}

func TestDeviceFlowEndings(t *testing.T) {
	for _, c := range []struct {
		answer string
		want   error
	}{
		{"expired_token", ErrDeviceCodeExpired},
		{"access_denied", ErrSignInCancelled},
	} {
		f := newConsole(t)
		f.polls = []string{"authorization_pending", c.answer}
		_, err := f.oauth().SignInDevice(context.Background(), "HAKAN-PC", func(DeviceCode) {})
		if !errors.Is(err, c.want) {
			t.Errorf("%s: err = %v", c.answer, err)
		}
	}
}

func TestDeviceFlowNotEnabledForTheApp(t *testing.T) {
	f := newConsole(t)
	f.deviceErr = "unauthorized_client"
	_, err := f.oauth().SignInDevice(context.Background(), "HAKAN-PC", func(DeviceCode) { t.Error("shown a code that cannot work") })
	if !errors.Is(err, ErrDeviceFlowUnavailable) {
		t.Fatalf("err = %v", err)
	}
}

func TestCanSignInOnlyOnHostedAltengine(t *testing.T) {
	for base, want := range map[string]bool{"": true, DefaultURL: true, DefaultURL + "/": true, "http://127.0.0.1:9191": false, "https://altengine.example": false} {
		if CanSignIn(base) != want {
			t.Errorf("CanSignIn(%q) = %v", base, !want)
		}
	}
}

// altengine answers with its own spelling of what was granted: one control token per area at the
// highest level, grants sorted. What it says must be read for what it means.
func TestMissingReadsTheGrantForWhatItMeans(t *testing.T) {
	o := &OAuth{}
	for _, c := range []struct {
		granted string
		missing string
	}{
		// What altengine actually returned for the full request: org:read folded into instances:write.
		{"instances:write auth:full:dutyboard* blob:full:dutyboard* channel:full:dutyboard* datastore:full:dutyboard* " +
			"functions:full:dutyboard* search:full:dutyboard* static:full:dutyboard* tasks:full:dutyboard*", ""},
		// A whole-service grant covers the prefix; a lower level does not.
		{"instances:read datastore:full auth:full:dutyboard* blob:full:dutyboard* channel:full:dutyboard* " +
			"functions:full:dutyboard* search:full:dutyboard* static:full:dutyboard* tasks:write:dutyboard*", "instances:write tasks:full:dutyboard*"},
		{"", strings.Join(Scopes, " ")},
	} {
		if got := strings.Join(o.Missing(&Token{Scope: c.granted}), " "); got != c.missing {
			t.Errorf("granted %q: missing %q, want %q", c.granted, got, c.missing)
		}
	}
}
