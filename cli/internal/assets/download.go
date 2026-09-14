package assets

import (
	"archive/tar"
	"bufio"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

// Repo is where releases are published.
const Repo = "altlimit/dutyboard"

// WebArchive is the release asset holding the layout above. It names no OS or architecture, so
// `alt install altlimit/dutyboard` — which scores assets by both — never picks it over a binary.
func WebArchive(version string) string { return fmt.Sprintf("dutyboard-web_%s.tar.gz", version) }

// Download fetches the assets for version (the latest release when version is "" or "dev") into
// cacheDir, verifies them against the release's checksums.txt, and returns the unpacked bundle.
// A version already unpacked there is used as it is.
//
// The checksum guards against a truncated or corrupted download, not against a compromised
// release: it comes from the same place as the archive. A release binary has its assets embedded
// and never takes this path.
func Download(ctx context.Context, version, cacheDir string) (*Bundle, error) {
	hc := &http.Client{Timeout: 5 * time.Minute}
	if version == "" || version == "dev" || strings.Contains(version, "-0.") {
		latest, err := latestRelease(ctx, hc)
		if err != nil {
			return nil, err
		}
		version = latest
	}
	dir := filepath.Join(cacheDir, "web", version)
	if b, err := FromDir(dir); err == nil {
		return b, nil
	}

	base := fmt.Sprintf("https://github.com/%s/releases/download/v%s/", Repo, version)
	sums, err := get(ctx, hc, base+"checksums.txt")
	if err != nil {
		return nil, fmt.Errorf("release v%s has no checksums.txt: %w", version, err)
	}
	want := ""
	sc := bufio.NewScanner(strings.NewReader(string(sums)))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) == 2 && f[1] == WebArchive(version) {
			want = f[0]
		}
	}
	if want == "" {
		return nil, fmt.Errorf("release v%s does not list %s in checksums.txt", version, WebArchive(version))
	}
	archive, err := get(ctx, hc, base+WebArchive(version))
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(archive)
	if hex.EncodeToString(sum[:]) != want {
		return nil, fmt.Errorf("%s does not match its checksum — refusing to deploy it", WebArchive(version))
	}

	tmp, err := os.MkdirTemp(cacheDir, ".web-")
	if err != nil {
		if err := os.MkdirAll(cacheDir, 0o755); err != nil {
			return nil, err
		}
		if tmp, err = os.MkdirTemp(cacheDir, ".web-"); err != nil {
			return nil, err
		}
	}
	defer os.RemoveAll(tmp)
	if err := untar(archive, tmp); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(dir), 0o755); err != nil {
		return nil, err
	}
	if err := os.Rename(tmp, dir); err != nil && !os.IsExist(err) {
		return nil, err
	}
	b, err := FromDir(dir)
	if err == nil {
		b.Source = base + WebArchive(version)
	}
	return b, err
}

func latestRelease(ctx context.Context, hc *http.Client) (string, error) {
	raw, err := get(ctx, hc, "https://api.github.com/repos/"+Repo+"/releases/latest")
	if err != nil {
		return "", fmt.Errorf("finding the latest DutyBoard release: %w", err)
	}
	var rel struct {
		TagName string `json:"tag_name"`
	}
	if err := json.Unmarshal(raw, &rel); err != nil || rel.TagName == "" {
		return "", fmt.Errorf("finding the latest DutyBoard release: no tag in the answer")
	}
	return strings.TrimPrefix(rel.TagName, "v"), nil
}

func get(ctx context.Context, hc *http.Client, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	res, err := hc.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET %s: %s", url, res.Status)
	}
	return io.ReadAll(io.LimitReader(res.Body, 64<<20))
}

// untar unpacks a gzipped tar into dir, refusing any entry that would land outside it.
func untar(archive []byte, dir string) error {
	gz, err := gzip.NewReader(strings.NewReader(string(archive)))
	if err != nil {
		return err
	}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		name := path.Clean(h.Name)
		if name == "." {
			continue // the archive's own root, which `tar -C dir .` writes first
		}
		target := filepath.Join(dir, filepath.FromSlash(name))
		if !strings.HasPrefix(target, filepath.Clean(dir)+string(os.PathSeparator)) {
			return fmt.Errorf("archive entry %q escapes the folder it unpacks into", h.Name)
		}
		switch h.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			f, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
			if err != nil {
				return err
			}
			if _, err := io.Copy(f, tr); err != nil {
				f.Close()
				return err
			}
			f.Close()
		}
	}
}
