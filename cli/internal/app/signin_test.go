package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/altlimit/dutyboard/cli/internal/altengine"
	"github.com/altlimit/dutyboard/cli/internal/state"
	"github.com/altlimit/dutyboard/cli/internal/ui"
	"github.com/zalando/go-keyring"
)

// consentFake is altengine's token and revoke endpoints, granting `grant`.
func consentFake(t *testing.T, grant string, revoked *[]string) *altengine.OAuth {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		switch r.URL.Path {
		case "/api/oauth/token":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token": "ae_from_signin", "token_type": "Bearer", "scope": grant,
				"altengine": map[string]any{"org_name": "Hakan's org", "key_name": "DutyBoard", "replaced": false},
			})
		case "/api/oauth/revoke":
			*revoked = append(*revoked, r.PostForm.Get("token"))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return &altengine.OAuth{Console: srv.URL, HTTP: srv.Client()}
}

// approve is a browser in which the person clicks Authorize at once.
func approve(t *testing.T) func(string) error {
	return func(link string) error {
		u, _ := url.Parse(link)
		q := u.Query()
		go func() {
			res, err := http.Get(q.Get("redirect_uri") + "?" + url.Values{"code": {"c"}, "state": {q.Get("state")}}.Encode())
			if err != nil {
				t.Errorf("callback: %v", err)
				return
			}
			res.Body.Close()
		}()
		return nil
	}
}

func TestSignInKeepsTheKeyAndSaysItCameFromSigningIn(t *testing.T) {
	keyring.MockInit() // never the real keyring of whoever runs the tests
	t.Setenv("DUTYBOARD_HOME", t.TempDir())
	t.Setenv("ALTENGINE_KEY", "")
	var revoked []string
	out := &bytes.Buffer{}
	tok, err := signIn(context.Background(), &ui.UI{Out: out}, false, consentFake(t, strings.Join(altengine.Scopes, " "), &revoked), approve(t))
	if err != nil {
		t.Fatal(err)
	}
	if k, _ := state.Credential(state.AltengineKey); k != tok.Key || k != "ae_from_signin" {
		t.Errorf("kept key = %q", k)
	}
	if cfg, _ := state.LoadConfig(); !cfg.AltengineSignedIn {
		t.Error("the kept key is not marked as coming from signing in")
	}
	if !strings.Contains(out.String(), "Hakan's org") {
		t.Errorf("the organization was not named:\n%s", out)
	}

	// The next run finds it, and knows to keep to `dutyboard…` names.
	key, typed, signedIn, stored, err := altengineKey(context.Background(), &ui.UI{Out: out}, altengine.New("", ""), Flags{})
	if err != nil || key != "ae_from_signin" || typed || !signedIn || !stored {
		t.Errorf("altengineKey = %q typed=%v signedIn=%v stored=%v err=%v", key, typed, signedIn, stored, err)
	}

	if err := ForgetAltengineKey(); err != nil {
		t.Fatal(err)
	}
	if k, _ := state.Credential(state.AltengineKey); k != "" {
		t.Errorf("forgotten key still kept: %q", k)
	}
	if cfg, _ := state.LoadConfig(); cfg.AltengineSignedIn {
		t.Error("forgetting the key left it marked as signed in")
	}
}

func TestSignInWithTooLittleAccessKeepsNothing(t *testing.T) {
	keyring.MockInit()
	t.Setenv("DUTYBOARD_HOME", t.TempDir())
	var revoked []string
	_, err := signIn(context.Background(), &ui.UI{Out: &bytes.Buffer{}}, false, consentFake(t, "org:read instances:write", &revoked), approve(t))
	if err == nil || !strings.Contains(err.Error(), "functions:full:dutyboard*") {
		t.Fatalf("err = %v", err)
	}
	if k, _ := state.Credential(state.AltengineKey); k != "" {
		t.Errorf("a key that cannot provision was kept: %q", k)
	}
	if len(revoked) != 1 {
		t.Errorf("the useless key was not revoked: %v", revoked)
	}
}

// Run with no terminal and no key — CI — it fails at once for want of a key, rather than starting a
// sign-in nobody is there to approve.
func TestNoSignInWithNobodyThere(t *testing.T) {
	keyring.MockInit()
	t.Setenv("DUTYBOARD_HOME", t.TempDir())
	t.Setenv("ALTENGINE_KEY", "")
	done := make(chan error, 1)
	go func() {
		_, _, _, _, err := altengineKey(context.Background(), &ui.UI{Out: &bytes.Buffer{}}, altengine.New("", ""), Flags{})
		done <- err
	}()
	select {
	case err := <-done:
		if !errors.Is(err, ui.ErrNoAnswer) {
			t.Errorf("err = %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a run with nobody there started waiting for a sign-in")
	}
}
