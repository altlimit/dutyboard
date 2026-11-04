package setup

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestParse(t *testing.T) {
	for _, c := range []struct {
		name, out, url, code string
	}{
		{
			"gh",
			"! First copy your one-time code: 1A2B-3C4D\nOpen this URL to continue in your web browser: https://github.com/login/device\n",
			"https://github.com/login/device", "1A2B-3C4D",
		},
		{
			"codex",
			"\x1b[1mFollow these steps to sign in with ChatGPT using device code authorization:\x1b[0m\n\n1. Open this link in your browser and sign in to your account\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94mWXYZ-12345\x1b[0m\n",
			"https://auth.openai.com/codex/device", "WXYZ-12345",
		},
		{
			"claude",
			"Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c&state=AB12-CD34xyz\nPaste code here if prompted > ",
			"https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c&state=AB12-CD34xyz", "",
		},
		{
			"cursor",
			"Open this link to sign in: https://cursor.com/loginDeepControl?challenge=abc.\n",
			"https://cursor.com/loginDeepControl?challenge=abc", "",
		},
		{"nothing yet", "Starting…\n", "", ""},
	} {
		p := Parse(c.out)
		if p.URL != c.url || p.Code != c.code {
			t.Errorf("%s: got %q %q, want %q %q", c.name, p.URL, p.Code, c.url, c.code)
		}
	}
}

func TestGHAsset(t *testing.T) {
	for _, c := range []struct{ goos, goarch, want string }{
		{"linux", "amd64", "gh_2.62.0_linux_amd64.tar.gz"},
		{"darwin", "arm64", "gh_2.62.0_macOS_arm64.zip"},
		{"windows", "amd64", "gh_2.62.0_windows_amd64.zip"},
	} {
		got, err := ghAsset("v2.62.0", c.goos, c.goarch)
		if err != nil || got != c.want {
			t.Errorf("%s/%s: got %q %v, want %q", c.goos, c.goarch, got, err, c.want)
		}
	}
	if _, err := ghAsset("v2.62.0", "plan9", "amd64"); err == nil {
		t.Error("an OS with no release should be refused")
	}
}

func TestCheckSumAndExtract(t *testing.T) {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for name, body := range map[string]string{"gh_1.0.0_linux_amd64/LICENSE": "mit", "gh_1.0.0_linux_amd64/bin/gh": "#!binary"} {
		_ = tw.WriteHeader(&tar.Header{Name: name, Mode: 0o755, Size: int64(len(body)), Typeflag: tar.TypeReg})
		_, _ = tw.Write([]byte(body))
	}
	_ = tw.Close()
	_ = gz.Close()
	archive := buf.Bytes()
	sum := sha256.Sum256(archive)
	sums := []byte(hex.EncodeToString(sum[:]) + "  gh_1.0.0_linux_amd64.tar.gz\nffff  other.zip\n")

	if err := checkSum(archive, sums, "gh_1.0.0_linux_amd64.tar.gz"); err != nil {
		t.Fatalf("a matching checksum: %v", err)
	}
	if err := checkSum(append(archive, 0), sums, "gh_1.0.0_linux_amd64.tar.gz"); err == nil {
		t.Fatal("a changed archive must not pass")
	}
	if err := checkSum(archive, sums, "missing.tar.gz"); err == nil {
		t.Fatal("an archive not in the list must not pass")
	}
	got, err := extract(archive, "gh_1.0.0_linux_amd64.tar.gz", "bin/gh")
	if err != nil || string(got) != "#!binary" {
		t.Fatalf("extract: %q %v", got, err)
	}
}

// A sign-in that needs a value pasted back, as Claude's does: the link is shown, the value reaches the
// command's stdin, and a wrong one fails.
func TestSignInWithPastedCode(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses a shell script")
	}
	dir := t.TempDir()
	fake := filepath.Join(dir, "claude")
	script := `#!/bin/sh
echo "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true"
printf "Paste code here if prompted > "
read code
[ "$code" = "good-code#state" ] && echo "Login successful." && exit 0
echo "Invalid code" >&2
exit 1
`
	if err := os.WriteFile(fake, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DUTYBOARD_CLAUDE", fake)

	for _, c := range []struct {
		pasted string
		ok     bool
	}{{"good-code#state", true}, {"bad", false}} {
		var mu sync.Mutex
		var shown []Prompt
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		err := SignIn(ctx, "claude-code",
			func(p Prompt) { mu.Lock(); shown = append(shown, p); mu.Unlock() },
			func(context.Context) (string, error) { return "  " + c.pasted + "\n", nil })
		cancel()
		if (err == nil) != c.ok {
			t.Errorf("pasting %q: err = %v, want ok=%v", c.pasted, err, c.ok)
		}
		mu.Lock()
		last := Prompt{}
		if len(shown) > 0 {
			last = shown[len(shown)-1]
		}
		mu.Unlock()
		if !strings.HasPrefix(last.URL, "https://claude.com/") || !last.NeedsInput {
			t.Errorf("pasting %q: the person was shown %+v", c.pasted, last)
		}
	}
}
