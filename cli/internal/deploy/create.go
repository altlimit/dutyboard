package deploy

import (
	"context"
	"fmt"
	"net/url"
	"strings"
)

// CreateRepo makes an empty repository on GitHub with the machine's GitHub CLI, as owner/name — or
// under the account gh is signed in as, when owner is empty — and answers the URL to clone it by, in
// the protocol gh is set to use for git (git_protocol), so the machine's own credentials reach it.
func CreateRepo(ctx context.Context, owner, name, description string, private bool) (string, error) {
	if !Available(ctx, "") {
		return "", fmt.Errorf("%w — on this machine, run `gh auth login`", ErrNoGH)
	}
	full := name
	if owner != "" {
		full = owner + "/" + name
	}
	visibility := "--public"
	if private {
		visibility = "--private"
	}
	args := []string{"repo", "create", full, visibility}
	if description != "" {
		args = append(args, "--description", description)
	}
	out, err := gh(ctx, "", args...)
	if err != nil {
		if strings.Contains(err.Error(), "already exists") {
			return "", fmt.Errorf("a repository named %s already exists — choose another name", full)
		}
		return "", err
	}
	return cloneURL(ctx, strings.TrimSpace(string(out)))
}

// cloneURL turns the https://host/owner/name gh prints into the URL git should use for it.
func cloneURL(ctx context.Context, printed string) (string, error) {
	lines := strings.Split(printed, "\n")
	u, err := url.Parse(strings.TrimSpace(lines[len(lines)-1]))
	if err != nil || u.Host == "" || strings.Count(strings.Trim(u.Path, "/"), "/") != 1 {
		return "", fmt.Errorf("gh created the repository but printed no URL for it: %q", printed)
	}
	path := strings.Trim(u.Path, "/")
	protocol, _ := gh(ctx, "", "config", "get", "git_protocol", "-h", u.Host)
	if strings.TrimSpace(string(protocol)) == "ssh" {
		return "git@" + u.Host + ":" + path + ".git", nil
	}
	return "https://" + u.Host + "/" + path + ".git", nil
}
