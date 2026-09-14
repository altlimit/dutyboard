package provision

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"time"
)

// LocalOrigins are the dev server's origins, which is where a local console is served from.
func LocalOrigins() []string {
	port := os.Getenv("DUTYBOARD_PORT")
	if port == "" {
		port = "5173"
	}
	return []string{"http://localhost:" + port, "http://127.0.0.1:" + port}
}

// runLocal provisions a local emulator: its admin API, which is unauthenticated and addresses
// instances by id. There is no static hosting locally — the console is `npm run dev` — and blob and
// search instances come into being on first use, so neither is created here.
func runLocal(ctx context.Context, o Options) (*Result, error) {
	c, u := o.Client, o.UI
	n := NamesFor("dutyboard")
	if o.Instance != "" {
		n = NamesFor(o.Instance)
	}
	res := &Result{Org: "local emulator", Names: n, Version: o.Assets.Version, Created: true}

	u.Step("Emulator at %s", c.BaseURL)
	if err := waitForEmulator(ctx, c.BaseURL, 30*time.Second); err != nil {
		return nil, err
	}
	u.OK("answering")

	for _, s := range []struct{ service, name string }{{"auth", n.Auth}, {"datastore", n.Datastore}, {"channel", n.Channel}} {
		if err := c.CreateInstance(ctx, s.service, s.name); err != nil {
			return nil, fmt.Errorf("%s %q: %w", s.service, s.name, err)
		}
	}
	inv, err := c.ListInstances(ctx)
	if err != nil {
		return nil, err
	}
	id := func(service, name string) (string, error) {
		i, ok := inv.Find(service, name)
		if !ok {
			return "", fmt.Errorf("could not create %s instance %q", service, name)
		}
		return i.ID, nil
	}
	authID, err := id("auth", n.Auth)
	if err != nil {
		return nil, err
	}
	dsID, err := id("datastore", n.Datastore)
	if err != nil {
		return nil, err
	}
	chID, err := id("channel", n.Channel)
	if err != nil {
		return nil, err
	}

	origins := append(LocalOrigins(), o.Origins...)
	var signup, access map[string]any
	if err := o.Assets.JSON("signup.json", &signup); err != nil {
		return nil, err
	}
	if err := o.Assets.JSON("access.json", &access); err != nil {
		return nil, err
	}
	if err := c.PatchConfig(ctx, "auth", authID, map[string]any{
		"allowSignup":         true,
		"passwordlessEnabled": true, // the emulator prints the code in its own terminal
		"signup":              signup,
		"access":              map[string]any{"datastore:" + n.Datastore: access["datastore:dutyboard"]},
		"origins":             origins,
	}); err != nil {
		return nil, fmt.Errorf("auth config: %w", err)
	}
	u.OK("auth %s: sign-up open, passwordless on, access rules applied", n.Auth)

	if err := configureData(ctx, c, u, o.Assets, n, dsID, chID); err != nil {
		return nil, err
	}

	u.Step("Function")
	if res.APIURL, err = deployFunction(ctx, c, u, o.Assets, n); err != nil {
		return nil, err
	}
	// A functions instance comes into being on its first deploy, so its CORS list is set after.
	if err := c.SetFunctionSettings(ctx, n.Functions, origins); err != nil {
		return nil, fmt.Errorf("function CORS: %w", err)
	}
	if secrets := n.secrets(); len(secrets) > 0 {
		if err := c.SetFunctionSecrets(ctx, n.Functions, secrets); err != nil {
			return nil, fmt.Errorf("function secrets: %w", err)
		}
	}
	u.OK("CORS: %v", origins)
	res.ConsoleURL = origins[0] + "/app/"
	return res, verify(ctx, u, res)
}

func waitForEmulator(ctx context.Context, base string, within time.Duration) error {
	deadline := time.Now().Add(within)
	for {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, base+"/healthz", nil)
		if res, err := http.DefaultClient.Do(req); err == nil {
			res.Body.Close()
			if res.StatusCode == http.StatusOK {
				return nil
			}
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("no altengine emulator at %s after %s — start it with `altengine dev`", base, within)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(500 * time.Millisecond):
		}
	}
}
