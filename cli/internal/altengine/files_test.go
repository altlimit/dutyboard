package altengine

import (
	"testing"
	"testing/fstest"
)

func TestFilesUnderExceptLeavesOutMatches(t *testing.T) {
	fsys := fstest.MapFS{
		"index.html":           {Data: []byte("<html>")},
		"index.wasm":           {Data: []byte("wasm")},
		"index.wasm.gz":        {Data: []byte("gz")},
		"icon.png.import":      {Data: []byte("import")},
		"debug/trace.txt":      {Data: []byte("trace")},
		"assets/deep/a.gz":     {Data: []byte("gz")},
		"assets/deep/keep.txt": {Data: []byte("keep")},
	}
	files, err := FilesUnderExcept(fsys, ".", "", []string{"*.gz", "*.import", "debug/*"})
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, f := range files {
		got = append(got, f.Path)
	}
	want := []string{"/assets/deep/keep.txt", "/index.html", "/index.wasm"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
	if _, err := FilesUnderExcept(fsys, ".", "", []string{"[bad"}); err == nil {
		t.Fatal("a malformed pattern was accepted")
	}
}
