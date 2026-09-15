package state

import (
	"errors"
	"os"
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

const keyringService = "dutyboard"

var fileMu sync.Mutex

// ErrNoCredential is a credential that was never stored.
var ErrNoCredential = errors.New("not stored")

// SetCredential stores a secret in the OS keyring, or in credentials.json (0600) where there is no
// keyring — a headless Linux box or WSL without a secret service, which is common for exactly the
// machines this runs on.
func SetCredential(name, value string) error {
	if os.Getenv("DUTYBOARD_NO_KEYRING") == "" {
		if err := keyring.Set(keyringService, name, value); err == nil {
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
		if v, err := keyring.Get(keyringService, name); err == nil {
			return v, nil
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
	_ = keyring.Delete(keyringService, name)
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
