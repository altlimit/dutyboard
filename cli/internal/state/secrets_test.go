package state

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/zalando/go-keyring"
)

// account is a person's account for a test: a keyring of its own, and a default home that is a
// temporary folder. It answers that default home.
func account(t *testing.T) string {
	t.Helper()
	keyring.MockInit()
	t.Setenv("DUTYBOARD_NO_KEYRING", "")
	t.Setenv("DUTYBOARD_HOME", "")
	base := t.TempDir()
	if runtime.GOOS == "windows" {
		t.Setenv("LOCALAPPDATA", base)
		return filepath.Join(base, "DutyBoard")
	}
	t.Setenv("HOME", base)
	return filepath.Join(base, ".dutyboard")
}

func installed(t *testing.T, home string) {
	t.Helper()
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestTheDefaultHomeKeepsItsSecretsWhereTheyAlwaysWere(t *testing.T) {
	def := account(t)
	if err := SetCredential(MachineKey, "dbm_default"); err != nil {
		t.Fatal(err)
	}
	if v, err := keyring.Get(legacyKeyring, MachineKey); err != nil || v != "dbm_default" {
		t.Fatalf("under the plain name: %q, %v", v, err)
	}
	// A service names the default home in its environment; it is the default home all the same.
	t.Setenv("DUTYBOARD_HOME", def)
	if v, err := Credential(MachineKey); err != nil || v != "dbm_default" {
		t.Fatalf("with the home named: %q, %v", v, err)
	}
}

func TestASecondHomeNeitherReadsNorRemovesTheFirstOnesKey(t *testing.T) {
	def := account(t)
	installed(t, def)
	if err := SetCredential(MachineKey, "dbm_real"); err != nil {
		t.Fatal(err)
	}

	t.Setenv("DUTYBOARD_HOME", t.TempDir())
	if v, err := Credential(MachineKey); err == nil {
		t.Fatalf("a second home read the first one's key: %q", v)
	}
	if err := SetCredential(MachineKey, "dbm_second"); err != nil {
		t.Fatal(err)
	}
	if v, _ := Credential(MachineKey); v != "dbm_second" {
		t.Fatalf("the second home reads %q, want its own", v)
	}
	// What a daemon does when its board answers 401.
	if err := DeleteCredential(MachineKey); err != nil {
		t.Fatal(err)
	}
	if _, err := Credential(MachineKey); err == nil {
		t.Fatal("the second home's key is still there")
	}

	t.Setenv("DUTYBOARD_HOME", "")
	if v, err := Credential(MachineKey); err != nil || v != "dbm_real" {
		t.Fatalf("the first home's key is now %q, %v", v, err)
	}
}

func TestAHomeThatWasAlwaysSomewhereElseGoesOnFindingItsSecrets(t *testing.T) {
	account(t) // nothing was ever set up in the default home
	// As an older dutyboard stored it, whatever the home.
	if err := keyring.Set(legacyKeyring, MachineKey, "dbm_old"); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DUTYBOARD_HOME", t.TempDir())
	if v, err := Credential(MachineKey); err != nil || v != "dbm_old" {
		t.Fatalf("after the upgrade it reads %q, %v", v, err)
	}
	if v, err := keyring.Get(keyringService(), MachineKey); err != nil || v != "dbm_old" {
		t.Fatalf("it was not moved under the home's own name: %q, %v", v, err)
	}
	// Revoked: gone under both names, or the next read would bring it back.
	if err := DeleteCredential(MachineKey); err != nil {
		t.Fatal(err)
	}
	if v, err := Credential(MachineKey); err == nil {
		t.Fatalf("a removed key came back: %q", v)
	}
}

func TestWithoutAKeyringSecretsAreInTheHomesOwnFile(t *testing.T) {
	account(t)
	home := t.TempDir()
	t.Setenv("DUTYBOARD_HOME", home)
	t.Setenv("DUTYBOARD_NO_KEYRING", "1")
	if err := SetCredential(MachineKey, "dbm_file"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(home, "credentials.json")); err != nil {
		t.Fatal(err)
	}
	if v, _ := Credential(MachineKey); v != "dbm_file" {
		t.Fatalf("read %q", v)
	}
	if _, err := keyring.Get(keyringService(), MachineKey); err == nil {
		t.Fatal("it went to the keyring as well")
	}
}
