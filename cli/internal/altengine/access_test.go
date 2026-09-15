package altengine

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// fakeGrants answers the two probes the way the platform does: the grant is checked first, then the
// instance is looked up, then the probe answers for a deployment with nothing to upload, or refuses a version that is not valid.
func fakeGrants(t *testing.T, static, functions map[string]string) *Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/") // v1 <service> <instance> ...
		service, instance := parts[1], parts[2]
		grants, need, notFound := static, "write", "static instance '"+instance+"' not found"
		if service == "functions" {
			grants, need, notFound = functions, "full", "functions instance not found"
		}
		fail := func(status int, code, msg string) {
			w.WriteHeader(status)
			fmt.Fprintf(w, `{"error":{"code":%q,"message":%q}}`, code, msg)
		}
		have, exists := grants[instance]
		switch {
		case have == "" || (need == "full" && have != "full") || have == "read":
			fail(403, "PERMISSION_DENIED", fmt.Sprintf("API key lacks '%s' access to %s '%s' (has no access)", need, service, instance))
		case !exists || have == "missing":
			fail(404, "NOT_FOUND", notFound)
		case service == "static":
			fmt.Fprint(w, `{"uploads":[],"cursor":null}`) // an unknown deployment has nothing missing
		default:
			fail(400, "INVALID_ARGUMENT", "version must be a positive integer")
		}
	}))
	t.Cleanup(srv.Close)
	c := New(srv.URL, "k")
	c.Hosted = true
	return c
}

func TestDeployTarget(t *testing.T) {
	ctx := context.Background()
	c := fakeGrants(t, map[string]string{"cadence": "write", "docs": "read"}, map[string]string{"api": "full", "jobs": "write"})

	if kind, err := c.DeployTarget(ctx, "cadence"); err != nil || kind != "static" {
		t.Fatalf("a site the key may write: %q %v", kind, err)
	}
	if kind, err := c.DeployTarget(ctx, "api"); err != nil || kind != "functions" {
		t.Fatalf("a functions instance the key holds full on: %q %v", kind, err)
	}
	if _, err := c.DeployTarget(ctx, "docs"); err == nil || !strings.Contains(err.Error(), "write on static") {
		t.Fatalf("a read-only site should say what to grant: %v", err)
	}
	if _, err := c.DeployTarget(ctx, "jobs"); err == nil {
		t.Fatal("write on a functions instance is not enough to deploy there")
	}
}

func TestCanDeployChecksOneKind(t *testing.T) {
	ctx := context.Background()
	// "cadence" is both a site the key may publish and a functions instance it may not deploy to.
	c := fakeGrants(t, map[string]string{"cadence": "write"}, map[string]string{"cadence": "write", "api": "full"})
	if err := c.CanDeploy(ctx, "static", "cadence"); err != nil {
		t.Fatalf("static cadence: %v", err)
	}
	if err := c.CanDeploy(ctx, "functions", "cadence"); err == nil || !strings.Contains(err.Error(), "full on functions") {
		t.Fatalf("functions cadence should be refused with what to grant: %v", err)
	}
	if err := c.CanDeploy(ctx, "functions", "api"); err != nil {
		t.Fatalf("functions api: %v", err)
	}
	if err := c.CanDeploy(ctx, "", "api"); err != nil {
		t.Fatalf("a plain name deployable either way: %v", err)
	}
}
