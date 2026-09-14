package deploy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

// Run is one GitHub Actions run.
type Run struct {
	ID         int64  `json:"databaseId"`
	Status     string `json:"status"`
	Conclusion string `json:"conclusion"`
	URL        string `json:"url"`
	HeadSha    string `json:"headSha"`
	Event      string `json:"event"`
}

// ErrNoGH is a machine without the GitHub CLI signed in: CI is not watched, and the duty says so.
var ErrNoGH = errors.New("the GitHub CLI (gh) is not installed or not signed in on this machine")

func gh(ctx context.Context, repo string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "gh", args...)
	cmd.Dir = repo
	cmd.Env = append(os.Environ(), "GH_PROMPT_DISABLED=1", "NO_COLOR=1")
	out, err := cmd.Output()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			return out, fmt.Errorf("gh %s: %s", strings.Join(args, " "), strings.TrimSpace(string(ee.Stderr)))
		}
		return out, err
	}
	return out, nil
}

// Available reports whether gh can talk to GitHub from repo.
func Available(ctx context.Context, repo string) bool {
	if _, err := exec.LookPath("gh"); err != nil {
		return false
	}
	_, err := gh(ctx, repo, "auth", "status")
	return err == nil
}

// Dispatch starts a workflow that only runs when dispatched, on ref.
func Dispatch(ctx context.Context, repo, workflow, ref string) error {
	_, err := gh(ctx, repo, "workflow", "run", workflow, "--ref", ref)
	return err
}

// Watch waits for the run of workflow for commit to finish, or for within to pass. A dispatched
// run is found by its event and its head commit, since it is not triggered by the commit itself.
func Watch(ctx context.Context, repo, workflow, commit string, dispatched bool, within time.Duration) (*Run, error) {
	deadline := time.Now().Add(within)
	for {
		args := []string{"run", "list", "--workflow", workflow, "--commit", commit, "--limit", "5", "--json", "databaseId,status,conclusion,url,headSha,event"}
		if dispatched {
			args = append(args, "--event", "workflow_dispatch")
		}
		out, err := gh(ctx, repo, args...)
		if err != nil {
			return nil, err
		}
		var runs []Run
		if err := json.Unmarshal(out, &runs); err != nil {
			return nil, err
		}
		if len(runs) > 0 && runs[0].Status == "completed" {
			return &runs[0], nil
		}
		if time.Now().After(deadline) {
			if len(runs) > 0 {
				return &runs[0], fmt.Errorf("the run was still %s after %s", runs[0].Status, within)
			}
			return nil, fmt.Errorf("no %s run appeared for %.12s within %s", workflow, commit, within)
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(20 * time.Second):
		}
	}
}

// FailedLog is the tail of a run's failing steps' logs.
func FailedLog(ctx context.Context, repo string, id int64, max int) string {
	out, _ := gh(ctx, repo, "run", "view", fmt.Sprint(id), "--log-failed")
	s := string(out)
	if len(s) > max {
		s = "…" + s[len(s)-max:]
	}
	return s
}
