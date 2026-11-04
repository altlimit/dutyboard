package setup

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// InstallTimeout is how long an install may take.
const InstallTimeout = 10 * time.Minute

// Install puts tool on this machine, as this user — no admin, no package manager — and answers the
// folder its command is in, which the daemon puts on its PATH and every session's. toolsDir is the
// machine's tools folder, for the tools installed from a download.
//
// Claude Code and Cursor are installed with their own installers, which put them in ~/.local/bin.
// The GitHub CLI is its release archive for this machine, checked against the release's checksums.
// Codex is its npm package, installed into the tools folder, so it needs Node.
func Install(ctx context.Context, tool, toolsDir string, log io.Writer) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, InstallTimeout)
	defer cancel()
	home, _ := os.UserHomeDir()
	switch tool {
	case "claude-code":
		if runtime.GOOS == "windows" {
			return filepath.Join(home, ".local", "bin"), run(ctx, log, "powershell", "-NoProfile", "-Command", "irm https://claude.ai/install.ps1 | iex")
		}
		return filepath.Join(home, ".local", "bin"), run(ctx, log, "bash", "-c", "curl -fsSL https://claude.ai/install.sh | bash")
	case "cursor":
		if runtime.GOOS == "windows" {
			return "", fmt.Errorf("Cursor's agent CLI: %w — install it yourself", ErrUnsupported)
		}
		return filepath.Join(home, ".local", "bin"), run(ctx, log, "bash", "-c", "curl https://cursor.com/install -fsS | bash")
	case "codex":
		npm, err := exec.LookPath("npm")
		if err != nil {
			return "", fmt.Errorf("Codex is installed with npm, and this machine has no Node — install Node, or Codex itself")
		}
		prefix := filepath.Join(toolsDir, "codex")
		if err := run(ctx, log, npm, "install", "--global", "--prefix", prefix, "@openai/codex@latest"); err != nil {
			return "", err
		}
		if runtime.GOOS == "windows" {
			return prefix, nil // npm's global layout on Windows puts the commands in the prefix itself
		}
		return filepath.Join(prefix, "bin"), nil
	case "gh":
		return installGH(ctx, toolsDir, log)
	}
	return "", fmt.Errorf("this dutyboard cannot install %q", tool)
}

func run(ctx context.Context, log io.Writer, name string, args ...string) error {
	cmd := exec.CommandContext(ctx, name, args...)
	var out bytes.Buffer
	w := io.Writer(&out)
	if log != nil {
		w = io.MultiWriter(&out, log)
	}
	cmd.Stdout, cmd.Stderr = w, w
	cmd.Env = append(os.Environ(), noBrowser...)
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s: %s", filepath.Base(name), lastLines(out.String(), 2, err))
	}
	return nil
}

// ghAsset is the GitHub CLI's release archive for this machine: gh_2.62.0_linux_amd64.tar.gz,
// gh_2.62.0_macOS_arm64.zip, gh_2.62.0_windows_amd64.zip.
func ghAsset(version, goos, goarch string) (string, error) {
	switch goarch {
	case "amd64", "arm64", "386":
	default:
		return "", fmt.Errorf("the GitHub CLI has no release for %s: %w", goarch, ErrUnsupported)
	}
	v := strings.TrimPrefix(version, "v")
	switch goos {
	case "linux":
		return fmt.Sprintf("gh_%s_linux_%s.tar.gz", v, goarch), nil
	case "darwin":
		return fmt.Sprintf("gh_%s_macOS_%s.zip", v, goarch), nil
	case "windows":
		return fmt.Sprintf("gh_%s_windows_%s.zip", v, goarch), nil
	}
	return "", fmt.Errorf("the GitHub CLI: %w", ErrUnsupported)
}

func installGH(ctx context.Context, toolsDir string, log io.Writer) (string, error) {
	var rel struct {
		Tag    string `json:"tag_name"`
		Assets []struct {
			Name string `json:"name"`
			URL  string `json:"browser_download_url"`
		} `json:"assets"`
	}
	body, err := fetch(ctx, "https://api.github.com/repos/cli/cli/releases/latest", 1<<20)
	if err != nil {
		return "", err
	}
	if err := json.Unmarshal(body, &rel); err != nil || rel.Tag == "" {
		return "", fmt.Errorf("reading the GitHub CLI's latest release: %v", err)
	}
	name, err := ghAsset(rel.Tag, runtime.GOOS, runtime.GOARCH)
	if err != nil {
		return "", err
	}
	var archiveURL, sumsURL string
	for _, a := range rel.Assets {
		switch {
		case a.Name == name:
			archiveURL = a.URL
		case strings.HasSuffix(a.Name, "_checksums.txt"):
			sumsURL = a.URL
		}
	}
	if archiveURL == "" || sumsURL == "" {
		return "", fmt.Errorf("the GitHub CLI's release %s has no %s, or no checksums", rel.Tag, name)
	}
	if log != nil {
		fmt.Fprintf(log, "downloading %s\n", archiveURL)
	}
	archive, err := fetch(ctx, archiveURL, 200<<20)
	if err != nil {
		return "", err
	}
	sums, err := fetch(ctx, sumsURL, 1<<20)
	if err != nil {
		return "", err
	}
	if err := checkSum(archive, sums, name); err != nil {
		return "", err
	}
	exe := "gh"
	if runtime.GOOS == "windows" {
		exe = "gh.exe"
	}
	bin := filepath.Join(toolsDir, "gh", strings.TrimPrefix(rel.Tag, "v"), "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		return "", err
	}
	data, err := extract(archive, name, "bin/"+exe)
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(bin, exe), data, 0o755); err != nil {
		return "", err
	}
	return bin, nil
}

func fetch(ctx context.Context, url string, max int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s: %s", url, res.Status)
	}
	return io.ReadAll(io.LimitReader(res.Body, max))
}

// checkSum finds name's line in a sha256sum-style list and checks data against it.
func checkSum(data, sums []byte, name string) error {
	got := sha256.Sum256(data)
	for _, line := range strings.Split(string(sums), "\n") {
		f := strings.Fields(line)
		if len(f) == 2 && strings.TrimPrefix(f[1], "*") == name {
			if !strings.EqualFold(f[0], hex.EncodeToString(got[:])) {
				return fmt.Errorf("%s does not match its published checksum", name)
			}
			return nil
		}
	}
	return fmt.Errorf("%s is not in the release's checksums", name)
}

// extract is the file in an archive whose path ends in suffix (gh_2.62.0_linux_amd64/bin/gh).
func extract(archive []byte, name, suffix string) ([]byte, error) {
	if strings.HasSuffix(name, ".zip") {
		zr, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
		if err != nil {
			return nil, err
		}
		for _, f := range zr.File {
			if strings.HasSuffix(f.Name, "/"+suffix) || f.Name == suffix {
				rc, err := f.Open()
				if err != nil {
					return nil, err
				}
				defer rc.Close()
				return io.ReadAll(io.LimitReader(rc, 200<<20))
			}
		}
		return nil, fmt.Errorf("%s has no %s", name, suffix)
	}
	gz, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return nil, err
	}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return nil, fmt.Errorf("%s has no %s", name, suffix)
		}
		if err != nil {
			return nil, err
		}
		if h.Typeflag == tar.TypeReg && (strings.HasSuffix(h.Name, "/"+suffix) || h.Name == suffix) {
			return io.ReadAll(io.LimitReader(tr, 200<<20))
		}
	}
}
