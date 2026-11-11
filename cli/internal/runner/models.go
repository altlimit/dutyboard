package runner

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

// Model comes from the installed CLI, including only effort levels it advertises.
// A catalog is not a guarantee of remaining quota or account entitlement.
type Model struct {
	ID      string   `json:"id"`
	Label   string   `json:"label"`
	Efforts []string `json:"efforts"`
}

// Models never submits a prompt or starts an inference turn. Discovery is isolated
// from the project's working directory, time bounded, and reaped on every exit.
func Models(ctx context.Context, agent string) ([]Model, error) {
	ctx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	switch agent {
	case "codex":
		return codexModels(ctx)
	case "claude-code":
		return claudeModels(ctx)
	case "cursor":
		cmd := exec.CommandContext(ctx, cursorBinary(), "--list-models")
		cmd.WaitDelay = time.Second
		cmd.Env = append(os.Environ(), "NO_COLOR=1", "TERM=dumb")
		cmd.Dir = os.TempDir()
		var b strings.Builder
		cmd.Stdout = &limited{w: &b, n: 256 << 10}
		if err := cmd.Run(); err != nil {
			return nil, fmt.Errorf("Cursor model discovery failed; check sign-in and update the CLI")
		}
		models := parseCursorModels(b.String())
		if len(models) == 0 {
			return nil, fmt.Errorf("Cursor returned no recognizable models; update the CLI and check again")
		}
		return models, nil
	}
	return nil, fmt.Errorf("unknown agent %q", agent)
}

func catalogProcess(ctx context.Context, bin string, args ...string) (*json.Encoder, *bufio.Scanner, func(), error) {
	dir, err := os.MkdirTemp("", "dutyboard-models-")
	if err != nil {
		return nil, nil, nil, err
	}
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Dir = dir
	cmd.WaitDelay = time.Second
	in, err := cmd.StdinPipe()
	if err != nil {
		os.RemoveAll(dir)
		return nil, nil, nil, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		in.Close()
		os.RemoveAll(dir)
		return nil, nil, nil, err
	}
	cmd.Stderr = io.Discard
	if err = cmd.Start(); err != nil {
		in.Close()
		out.Close()
		os.RemoveAll(dir)
		return nil, nil, nil, err
	}
	done := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			_ = out.Close()
		case <-done:
		}
	}()
	cleanup := func() { close(done); in.Close(); _ = cmd.Process.Kill(); _ = cmd.Wait(); os.RemoveAll(dir) }
	scan := bufio.NewScanner(out)
	scan.Buffer(make([]byte, 4096), 2<<20)
	return json.NewEncoder(in), scan, cleanup, nil
}

func codexModels(ctx context.Context) ([]Model, error) {
	enc, scan, close, err := catalogProcess(ctx, codexBinary(), "app-server")
	if err != nil {
		return nil, err
	}
	defer close()
	call := func(id int, method string, params any, result any) error {
		if err := enc.Encode(map[string]any{"id": id, "method": method, "params": params}); err != nil {
			return err
		}
		for scan.Scan() {
			var msg struct {
				ID     *int            `json:"id"`
				Result json.RawMessage `json:"result"`
				Error  json.RawMessage `json:"error"`
			}
			if json.Unmarshal(scan.Bytes(), &msg) != nil || msg.ID == nil || *msg.ID != id {
				continue
			}
			if len(msg.Error) > 0 && string(msg.Error) != "null" {
				return fmt.Errorf("Codex rejected %s; check sign-in and update the CLI", method)
			}
			return json.Unmarshal(msg.Result, result)
		}
		return fmt.Errorf("Codex model discovery ended before %s returned", method)
	}
	var init json.RawMessage
	if err := call(1, "initialize", map[string]any{"clientInfo": map[string]string{"name": "dutyboard", "version": "1.0.0"}}, &init); err != nil {
		return nil, err
	}
	if err := enc.Encode(map[string]any{"method": "initialized", "params": map[string]any{}}); err != nil {
		return nil, err
	}
	models := []Model{}
	cursor := ""
	seen := map[string]bool{}
	for page := 0; page < 10; page++ {
		params := map[string]any{"limit": 100, "includeHidden": false}
		if cursor != "" {
			params["cursor"] = cursor
		}
		var reply struct {
			Data []struct {
				Model       string `json:"model"`
				ID          string `json:"id"`
				DisplayName string `json:"displayName"`
				Hidden      bool   `json:"hidden"`
				Efforts     []struct {
					Value string `json:"reasoningEffort"`
				} `json:"supportedReasoningEfforts"`
			} `json:"data"`
			NextCursor *string `json:"nextCursor"`
		}
		if err := call(page+2, "model/list", params, &reply); err != nil {
			return nil, err
		}
		for _, m := range reply.Data {
			if m.Model == "" {
				m.Model = m.ID
			}
			if m.Hidden || m.Model == "" || seen[m.Model] {
				continue
			}
			seen[m.Model] = true
			model := Model{ID: m.Model, Label: m.DisplayName, Efforts: []string{}}
			for _, e := range m.Efforts {
				model.Efforts = append(model.Efforts, e.Value)
			}
			models = append(models, model)
			if len(models) == 200 {
				return models, nil
			}
		}
		if reply.NextCursor == nil || *reply.NextCursor == "" {
			return models, nil
		}
		if *reply.NextCursor == cursor {
			return nil, fmt.Errorf("Codex repeated its model page cursor")
		}
		cursor = *reply.NextCursor
	}
	return nil, fmt.Errorf("Codex returned too many model pages")
}

func claudeModels(ctx context.Context) ([]Model, error) {
	enc, scan, close, err := catalogProcess(ctx, claudeBinary(), "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--strict-mcp-config", "--mcp-config", `{"mcpServers":{}}`)
	if err != nil {
		return nil, err
	}
	defer close()
	if err := enc.Encode(map[string]any{"type": "control_request", "request_id": "models", "request": map[string]string{"subtype": "initialize"}}); err != nil {
		return nil, err
	}
	for scan.Scan() {
		var msg struct {
			Type     string `json:"type"`
			Response struct {
				RequestID string `json:"request_id"`
				Subtype   string `json:"subtype"`
				Response  struct {
					Models []struct {
						Value       string   `json:"value"`
						DisplayName string   `json:"displayName"`
						Efforts     []string `json:"supportedEffortLevels"`
					} `json:"models"`
				} `json:"response"`
			} `json:"response"`
		}
		if json.Unmarshal(scan.Bytes(), &msg) != nil || msg.Type != "control_response" || msg.Response.RequestID != "models" {
			continue
		}
		if msg.Response.Subtype != "success" {
			break
		}
		models := []Model{}
		seen := map[string]bool{}
		for _, m := range msg.Response.Response.Models {
			if m.Value == "" || seen[m.Value] {
				continue
			}
			seen[m.Value] = true
			models = append(models, Model{ID: m.Value, Label: m.DisplayName, Efforts: m.Efforts})
			if len(models) == 200 {
				break
			}
		}
		return models, nil
	}
	return nil, fmt.Errorf("Claude Code model discovery failed; check sign-in and update the CLI")
}

var ansiEscape = regexp.MustCompile(`\x1b\[[0-9;]*[A-Za-z]`)
var cursorModelLine = regexp.MustCompile(`^\s*(?:[>*•]\s*)?([A-Za-z0-9][A-Za-z0-9._:/-]*)\s+(?:-\s+|–\s+|—\s+|\s+)(.+?)\s*$`)

func parseCursorModels(output string) []Model {
	models := []Model{}
	seen := map[string]bool{}
	for _, line := range strings.Split(ansiEscape.ReplaceAllString(output, ""), "\n") {
		m := cursorModelLine.FindStringSubmatch(line)
		if m == nil || seen[m[1]] {
			continue
		}
		seen[m[1]] = true
		models = append(models, Model{ID: m[1], Label: m[2], Efforts: []string{}})
		if len(models) == 200 {
			break
		}
	}
	return models
}
