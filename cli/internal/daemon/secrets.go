package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/altlimit/dutyboard/cli/internal/board"
	"github.com/altlimit/dutyboard/cli/internal/seal"
	"github.com/altlimit/dutyboard/cli/internal/state"
)

// maxSecretChars bounds one secret's value. An API token or a header is far shorter; anything longer
// is a mistake, such as a whole file pasted into the field.
const maxSecretChars = 8192

// sealedSecrets is what the console seals to this machine: values for MCP secrets its boards name.
type sealedSecrets struct {
	Version int           `json:"v"`
	Secrets []namedSecret `json:"secrets"`
}

type namedSecret struct {
	Board  string `json:"board"`
	Server string `json:"server"`
	Name   string `json:"name"`
	Value  string `json:"value"`
}

// workSecrets stores the MCP secrets this machine's owner typed in the console. They arrive sealed to
// this machine's key, so the board that carried them could not read them, and are kept where
// `dutyboard --mcp-secrets` keeps them: the OS keyring.
func (d *Daemon) workSecrets(ctx context.Context, req board.Request) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	_ = d.api.ReportRequest(ctx, req.RequestID, "running", "")
	d.log.Printf("storing MCP secrets, as asked from the console")

	done, err := func() (string, error) {
		// Taking it also clears it from the board.
		sealed, err := d.awaitInput(ctx, req.RequestID)
		if err != nil {
			return "", errors.New("the sealed secrets never arrived — send them again")
		}
		plain, err := seal.Open(sealed)
		if err != nil {
			return "", err
		}
		d.mu.Lock()
		var links []board.BoardView
		if d.me != nil {
			links = append(links, d.me.Links...)
		}
		d.mu.Unlock()
		secrets, err := secretsToStore(links, plain)
		if err != nil {
			return "", err
		}
		for _, s := range secrets {
			if err := state.SetCredential(state.MCPSecret(s.Board, s.Server, s.Name), s.Value); err != nil {
				return "", fmt.Errorf("storing %s for %s: %w", s.Name, s.Board, err)
			}
		}
		return describeStored(secrets), nil
	}()

	if err != nil {
		d.log.Printf("MCP secrets: %v", err)
		_ = d.api.ReportRequest(ctx, req.RequestID, "failed", err.Error())
		return
	}
	d.log.Printf("%s", done)
	_ = d.api.ReportRequest(ctx, req.RequestID, "done", done)
	// Sessions started from here on have them, and the checklist says so.
	d.Reload()
}

// secretsToStore reads what the console sealed and keeps only what a board this machine works
// actually names. A value for a secret no board asks for is refused rather than stored: the keyring
// is not somewhere the console may write freely.
func secretsToStore(links []board.BoardView, plain []byte) ([]namedSecret, error) {
	var in sealedSecrets
	if err := json.Unmarshal(plain, &in); err != nil || in.Version != 1 {
		return nil, errors.New("this dutyboard cannot read what was sent — update it, then send the secrets again")
	}
	if len(in.Secrets) == 0 {
		return nil, errors.New("no secrets were sent")
	}
	wanted := map[string]bool{}
	for _, b := range links {
		if b.Profile == nil {
			continue
		}
		for _, s := range b.Profile.MCPServers {
			for _, name := range s.Secrets {
				wanted[state.MCPSecret(b.ProjectID, s.Name, name)] = true
			}
		}
	}
	var unknown []string
	for _, s := range in.Secrets {
		switch {
		case !wanted[state.MCPSecret(s.Board, s.Server, s.Name)]:
			unknown = append(unknown, s.Board+"/"+s.Server+" "+s.Name)
		case s.Value == "":
			return nil, fmt.Errorf("%s for %s/%s is empty", s.Name, s.Board, s.Server)
		case len(s.Value) > maxSecretChars || strings.ContainsAny(s.Value, "\x00\r\n"):
			return nil, fmt.Errorf("%s for %s/%s is not a single value of at most %d characters", s.Name, s.Board, s.Server, maxSecretChars)
		}
	}
	if len(unknown) > 0 {
		return nil, fmt.Errorf("no board this machine works names %s — the board's MCP servers may have changed; reload the Machines page", strings.Join(unknown, ", "))
	}
	return in.Secrets, nil
}

// describeStored says what was stored without saying any of it: names and boards only.
func describeStored(secrets []namedSecret) string {
	boards := map[string]bool{}
	for _, s := range secrets {
		boards[s.Board] = true
	}
	names := make([]string, 0, len(boards))
	for b := range boards {
		names = append(names, b)
	}
	sort.Strings(names)
	noun := "secrets"
	if len(secrets) == 1 {
		noun = "secret"
	}
	return fmt.Sprintf("stored %d MCP %s for %s", len(secrets), noun, strings.Join(names, ", "))
}
