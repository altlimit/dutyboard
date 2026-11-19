package readiness

import (
	"testing"

	"github.com/altlimit/dutyboard/cli/internal/board"
	"github.com/altlimit/dutyboard/cli/internal/state"
	"github.com/zalando/go-keyring"
)

func altengineBoard() []board.BoardView {
	p := &board.Profile{}
	p.Deploy.Method = "altengine"
	p.Deploy.AltengineTargets = []board.AltengineTarget{{Kind: "static", Instance: "site"}}
	return []board.BoardView{{ProjectID: "shop", Profile: p}}
}

func TestDeployKeyItemOffersToConnect(t *testing.T) {
	keyring.MockInit()
	t.Setenv("DUTYBOARD_HOME", t.TempDir())
	setCfg := func(base string, signedIn bool) {
		cfg, _ := state.LoadConfig()
		cfg.Altengine, cfg.AltengineSignedIn = base, signedIn
		if err := cfg.Save(); err != nil {
			t.Fatal(err)
		}
	}

	setCfg("", false)
	it, ok := deployKeyItem(altengineBoard())
	if !ok || it.State != Todo || len(it.Actions) != 1 || it.Actions[0] != ActionSignIn {
		t.Fatalf("no key on hosted altengine: %+v", it)
	}

	// Signed in to provision: that key is not a deploy key, and it is not reported as one.
	if err := state.SetCredential(state.AltengineKey, "ae_provisioning"); err != nil {
		t.Fatal(err)
	}
	setCfg("https://api.altengine.net", true)
	if it, _ := deployKeyItem(altengineBoard()); it.State != Todo {
		t.Errorf("a signed-in provisioning key counted as a deploy key: %+v", it)
	}

	// Connected: done, and still offered, for a target added later.
	if err := state.SetCredential(state.DeployKey, "ae_deploy"); err != nil {
		t.Fatal(err)
	}
	if it, _ := deployKeyItem(altengineBoard()); it.State != OK || len(it.Actions) != 1 {
		t.Errorf("with a deploy key: %+v", it)
	}

	// The emulator has no sign-in to offer.
	setCfg("http://127.0.0.1:9191", false)
	if it, _ := deployKeyItem(altengineBoard()); len(it.Actions) != 0 {
		t.Errorf("an emulator machine offered to connect: %+v", it)
	}
}
