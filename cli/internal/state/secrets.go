package state

import (
	"errors"
	"os"
	"path/filepath"
	"sync"

	"github.com/zalando/go-keyring"
)

// Credential names.
const (
	MachineKey   = "machine-key"
	AltengineKey = "altengine-key"
	// DeployKey is the altengine key the daemon deploys projects with — write on their sites and
	// nothing else — kept apart from the provisioning key, which can manage the whole deployment.
	DeployKey = "altengine-deploy-key"
)

// legacyKeyring is the keyring service every home's secrets were once kept under, and the default
// home's still are.
const legacyKeyring = "dutyboard"

// keyringService is the name this home's secrets are kept under in the OS keyring.
//
// A keyring belongs to the person, not to a folder, so one name for every home made two homes on one
// account share a machine key: a second home, pointed at another DutyBoard, read the first one's key,
// was refused with it, and — being told it was revoked — deleted it. The default home keeps the plain
// name, so nothing changes for an ordinary install; any other home gets a name of its own.
func keyringService() string {
	if IsDefaultHome() {
		return legacyKeyring
	}
	return legacyKeyring + "@" + canonical(Home())
}

// inheritsLegacy reports whether a secret kept under the plain name can only be this home's: this
// is not the default home, and nothing has ever been set up in the default one. That is a home that
// was already somewhere else before homes had keyring names of their own, and it must go on finding
// its secrets after the upgrade that gave them one.
func inheritsLegacy() bool {
	if IsDefaultHome() {
		return false
	}
	_, err := os.Stat(filepath.Join(defaultHome(), "config.json"))
	return errors.Is(err, os.ErrNotExist)
}

var fileMu sync.Mutex

// ErrNoCredential is a credential that was never stored.
var ErrNoCredential = errors.New("not stored")

// SetCredential stores a secret in the OS keyring, or in credentials.json (0600) where there is no
// keyring — a headless Linux box or WSL without a secret service, which is common for exactly the
// machines this runs on.
func SetCredential(name, value string) error {
	if os.Getenv("DUTYBOARD_NO_KEYRING") == "" {
		if err := keyring.Set(keyringService(), name, value); err == nil {
			// A stale copy in the file would outlive a rotation in the keyring.
			_ = deleteFileCredential(name)
			return nil
		}
	}
	return setFileCredential(name, value)
}

// Credential reads a stored secret.
func Credential(name string) (string, error) {
	if os.Getenv("DUTYBOARD_NO_KEYRING") == "" {
		svc := keyringService()
		if v, err := keyring.Get(svc, name); err == nil {
			return v, nil
		}
		if inheritsLegacy() {
			if v, err := keyring.Get(legacyKeyring, name); err == nil {
				_ = keyring.Set(svc, name, v) // under its own name from now on
				return v, nil
			}
		}
	}
	creds, err := fileCredentials()
	if err != nil {
		return "", err
	}
	if v, ok := creds[name]; ok {
		return v, nil
	}
	return "", ErrNoCredential
}

// DeleteCredential removes a secret from wherever it is.
func DeleteCredential(name string) error {
	_ = keyring.Delete(keyringService(), name)
	if inheritsLegacy() {
		// Or the next read would find it under the old name and bring it back.
		_ = keyring.Delete(legacyKeyring, name)
	}
	return deleteFileCredential(name)
}

func fileCredentials() (map[string]string, error) {
	creds := map[string]string{}
	err := readJSON(Path("credentials.json"), &creds)
	if errors.Is(err, os.ErrNotExist) {
		return creds, nil
	}
	return creds, err
}

func setFileCredential(name, value string) error {
	fileMu.Lock()
	defer fileMu.Unlock()
	creds, err := fileCredentials()
	if err != nil {
		return err
	}
	creds[name] = value
	return WriteJSON(Path("credentials.json"), creds, 0o600)
}

func deleteFileCredential(name string) error {
	fileMu.Lock()
	defer fileMu.Unlock()
	creds, err := fileCredentials()
	if err != nil {
		return err
	}
	if _, ok := creds[name]; !ok {
		return nil
	}
	delete(creds, name)
	return WriteJSON(Path("credentials.json"), creds, 0o600)
}

// MCPSecret is the credential name a board's MCP server's secret is kept under on this machine.
func MCPSecret(board, server, name string) string {
	return "mcp:" + board + ":" + server + ":" + name
}
