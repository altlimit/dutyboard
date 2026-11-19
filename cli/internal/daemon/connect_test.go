package daemon

import (
	"strings"
	"testing"

	"github.com/altlimit/dutyboard/cli/internal/board"
	"github.com/altlimit/dutyboard/cli/internal/state"
	"github.com/zalando/go-keyring"
)

func deploying(method string, targets ...board.AltengineTarget) board.BoardView {
	p := &board.Profile{}
	p.Deploy.Method = method
	p.Deploy.AltengineTargets = targets
	return board.BoardView{Profile: p}
}

// Connecting asks for exactly what deploying to the boards' targets takes, and nothing for a board
// that does not deploy to altengine.
func TestDeployScopesAreTheTargets(t *testing.T) {
	scopes, targets := deployScopes([]board.BoardView{
		deploying("altengine", board.AltengineTarget{Kind: "static", Instance: "shop-web"}, board.AltengineTarget{Kind: "functions", Instance: "shop-api"}),
		deploying("altengine", board.AltengineTarget{Kind: "static", Instance: "shop-web"}, board.AltengineTarget{Instance: "either"}),
		deploying("ci", board.AltengineTarget{Kind: "static", Instance: "not-this"}),
		{ProjectID: "no-profile"},
	})
	want := "functions:full:either functions:full:shop-api static:write:either static:write:shop-web"
	if got := strings.Join(scopes, " "); got != want {
		t.Errorf("scopes = %q, want %q", got, want)
	}
	if len(targets) != 3 {
		t.Errorf("targets = %v", targets)
	}
	if s, _ := deployScopes([]board.BoardView{deploying("ci")}); len(s) != 0 {
		t.Errorf("a machine with no altengine targets asked for %v", s)
	}
}

// The deploy key must not share a device name with the provisioning key: altengine would replace
// one with the other.
func TestDeployDeviceNameIsItsOwn(t *testing.T) {
	n := deployDeviceName()
	if !strings.HasSuffix(n, " · deploys") && len(n) != 64 {
		t.Errorf("device name %q", n)
	}
	if len(n) > 64 {
		t.Errorf("device name is %d characters, over altengine's 64", len(n))
	}
}

// A provisioning key from signing in reaches only `dutyboard…` instances: it is never used to
// deploy a project. A pasted one still is, on a machine set up before deploy keys.
func TestDeployKeyIgnoresASignedInProvisioningKey(t *testing.T) {
	keyring.MockInit()
	t.Setenv("DUTYBOARD_HOME", t.TempDir())
	if err := state.SetCredential(state.AltengineKey, "ae_provisioning"); err != nil {
		t.Fatal(err)
	}
	mark := func(signedIn bool) {
		cfg, _ := state.LoadConfig()
		cfg.AltengineSignedIn = signedIn
		if err := cfg.Save(); err != nil {
			t.Fatal(err)
		}
	}
	mark(true)
	if k := deployKey(); k != "" {
		t.Errorf("a signed-in provisioning key was used to deploy: %q", k)
	}
	mark(false)
	if k := deployKey(); k != "ae_provisioning" {
		t.Errorf("a pasted provisioning key should still stand in: %q", k)
	}
	if err := state.SetCredential(state.DeployKey, "ae_deploy"); err != nil {
		t.Fatal(err)
	}
	if k := deployKey(); k != "ae_deploy" {
		t.Errorf("the deploy key should win: %q", k)
	}
}
