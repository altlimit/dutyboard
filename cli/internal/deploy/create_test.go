package deploy

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// fakeGH puts a gh on PATH that logs its arguments and answers as the real one does.
func fakeGH(t *testing.T, protocol, create string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the fake gh is a shell script")
	}
	dir := t.TempDir()
	log := filepath.Join(dir, "calls")
	script := `#!/bin/sh
echo "$*" >> "` + log + `"
case "$1 $2" in
  "auth status") exit 0 ;;
  "repo create") ` + create + ` ;;
  "config get") echo "` + protocol + `" ;;
esac
`
	if err := os.WriteFile(filepath.Join(dir, "gh"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return log
}

func TestCreateRepo(t *testing.T) {
	ctx := context.Background()
	log := fakeGH(t, "ssh", `echo "https://github.com/acme/todo"`)
	url, err := CreateRepo(ctx, "acme", "todo", "A todo app.", true)
	if err != nil || url != "git@github.com:acme/todo.git" {
		t.Fatalf("an ssh machine clones over ssh: %q %v", url, err)
	}
	calls, _ := os.ReadFile(log)
	if !strings.Contains(string(calls), "repo create acme/todo --private --description A todo app.") {
		t.Fatalf("gh was not asked for a private acme/todo:\n%s", calls)
	}

	fakeGH(t, "https", `echo "https://github.com/me/todo"`)
	if url, err := CreateRepo(ctx, "", "todo", "", false); err != nil || url != "https://github.com/me/todo.git" {
		t.Fatalf("with no owner, the signed-in account's, over https: %q %v", url, err)
	}

	fakeGH(t, "https", `echo "GraphQL: Name already exists on this account (createRepository)" >&2; exit 1`)
	if _, err := CreateRepo(ctx, "", "todo", "", true); err == nil || !strings.Contains(err.Error(), "already exists — choose another name") {
		t.Fatalf("a taken name says so: %v", err)
	}
}
