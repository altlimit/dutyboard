package daemon

import "testing"

func TestFileNames(t *testing.T) {
	for in, want := range map[string]string{
		"menu.pdf": "menu.pdf", "../../etc/passwd": "passwd", `C:\Users\me\scan.png`: "scan.png", "a:b?.txt": "a_b_.txt", "..": "file",
	} {
		if got := safeFileName(in); got != want {
			t.Errorf("safeFileName(%q) = %q, want %q", in, got, want)
		}
	}
	have := map[string]int64{"menu.pdf": 10}
	if name, fetched := fileNameFor(have, "menu.pdf", 10); name != "menu.pdf" || !fetched {
		t.Errorf("the same file is not fetched again: %q %v", name, fetched)
	}
	if name, fetched := fileNameFor(have, "menu.pdf", 20); name != "menu (2).pdf" || fetched {
		t.Errorf("another file of the same name goes beside it: %q %v", name, fetched)
	}
	have["menu (2).pdf"] = 20
	if name, fetched := fileNameFor(have, "menu.pdf", 20); name != "menu (2).pdf" || !fetched {
		t.Errorf("and is found there next time: %q %v", name, fetched)
	}
}
