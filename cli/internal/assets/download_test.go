package assets

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func tarball(t *testing.T, entries map[string]string, dirs ...string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, d := range dirs {
		if err := tw.WriteHeader(&tar.Header{Name: d, Typeflag: tar.TypeDir, Mode: 0o755}); err != nil {
			t.Fatal(err)
		}
	}
	for name, body := range entries {
		if err := tw.WriteHeader(&tar.Header{Name: name, Typeflag: tar.TypeReg, Mode: 0o644, Size: int64(len(body))}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	tw.Close()
	gz.Close()
	return buf.Bytes()
}

// The release archive is made with `tar -C web .`, which writes a "./" root entry and "./"-prefixed
// names. Both have to unpack into a layout FromDir accepts.
func TestUntarReleaseLayout(t *testing.T) {
	dir := t.TempDir()
	archive := tarball(t, map[string]string{
		"./VERSION":            "2.1.0\n",
		"./function/bundle.js": "export default {}",
		"./console/index.html": "<!doctype html>",
	}, "./", "./function/", "./console/")
	if err := untar(archive, dir); err != nil {
		t.Fatal(err)
	}
	b, err := FromDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if b.Version != "2.1.0" {
		t.Fatalf("version = %q", b.Version)
	}
}

func TestUntarRefusesEntriesOutsideItsFolder(t *testing.T) {
	dir := t.TempDir()
	err := untar(tarball(t, map[string]string{"../escaped.txt": "no"}), dir)
	if err == nil || !strings.Contains(err.Error(), "escapes") {
		t.Fatalf("expected a refusal, got %v", err)
	}
	if _, statErr := os.Stat(filepath.Join(filepath.Dir(dir), "escaped.txt")); statErr == nil {
		t.Fatal("the entry was written outside the folder")
	}
}
