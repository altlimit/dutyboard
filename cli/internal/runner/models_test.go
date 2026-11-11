package runner

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func catalogCLI(t *testing.T, variable, script string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("shell CLI fixture")
	}
	path := filepath.Join(t.TempDir(), "cli")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv(variable, path)
}

func TestCodexCatalogHandshakeAndPagination(t *testing.T) {
	catalogCLI(t, "DUTYBOARD_CODEX", `
read -r line
case "$line" in *'"method":"initialize"'*) ;; *) exit 1;; esac
printf '%s\n' '{"id":1,"result":{}}'
read -r line
case "$line" in *'"method":"initialized"'*) ;; *) exit 2;; esac
read -r line
printf '%s\n' '{"method":"notification"}' '{"id":2,"result":{"data":[{"id":"id","model":"first","displayName":"First","supportedReasoningEfforts":[{"reasoningEffort":"high"}]},{"model":"hidden","hidden":true}],"nextCursor":"next"}}'
read -r line
case "$line" in *'"cursor":"next"'*) ;; *) exit 3;; esac
printf '%s\n' '{"id":3,"result":{"data":[{"model":"second","displayName":"Second","supportedReasoningEfforts":[{"reasoningEffort":"minimal"}]},{"model":"first"}],"nextCursor":null}}'
`)
	models, err := Models(context.Background(), "codex")
	if err != nil || len(models) != 2 {
		t.Fatalf("catalog: %#v %v", models, err)
	}
	if models[0].ID != "first" || models[0].Efforts[0] != "high" || models[1].Efforts[0] != "minimal" {
		t.Fatalf("catalog changed CLI values: %#v", models)
	}
}

func TestCatalogErrorsAndCancellation(t *testing.T) {
	catalogCLI(t, "DUTYBOARD_CODEX", `read -r line
printf '%s\n' '{"id":1,"error":{"message":"private credential detail"}}'
`)
	_, err := Models(context.Background(), "codex")
	if err == nil || strings.Contains(err.Error(), "private credential") {
		t.Fatalf("unsafe error: %v", err)
	}
	catalogCLI(t, "DUTYBOARD_CODEX", `read -r line
read -r line
`)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	started := time.Now()
	if _, err := Models(ctx, "codex"); err == nil || time.Since(started) > 2*time.Second {
		t.Fatal("unresponsive CLI was not bounded")
	}
}

func TestClaudeCatalogNoInference(t *testing.T) {
	catalogCLI(t, "DUTYBOARD_CLAUDE", `
read -r line
case "$line" in *'"subtype":"initialize"'*) ;; *) exit 1;; esac
printf '%s\n' '{"type":"control_response","response":{"subtype":"success","request_id":"models","response":{"models":[{"value":"model-from-cli","displayName":"From CLI","supportedEffortLevels":["low","max"]}]}}}'
`)
	models, err := Models(context.Background(), "claude-code")
	if err != nil || len(models) != 1 || models[0].ID != "model-from-cli" || len(models[0].Efforts) != 2 {
		t.Fatalf("catalog: %#v %v", models, err)
	}
}

func TestCursorModelList(t *testing.T) {
	models := parseCursorModels("Available models\n\n\x1b[32m  auto - Auto\x1b[0m\n> composer-2  Composer 2\nclaude-sonnet – Sonnet\nUse --model to select a model.\n")
	if len(models) != 3 || models[0].ID != "auto" || models[1].ID != "composer-2" || len(models[0].Efforts) != 0 {
		t.Fatalf("models: %#v", models)
	}
}

// Opt-in read-only check against installed CLIs; no inference or credentials printed.
func TestInstalledCatalogs(t *testing.T) {
	if os.Getenv("DUTYBOARD_TEST_CATALOGS") != "1" {
		t.Skip("opt-in installed CLI check")
	}
	for _, agent := range []string{"codex", "claude-code"} {
		t.Run(agent, func(t *testing.T) {
			models, err := Models(context.Background(), agent)
			if err != nil || len(models) == 0 {
				t.Fatalf("installed catalog: %d models, %v", len(models), err)
			}
			t.Logf("%s returned %d models", agent, len(models))
		})
	}
}
