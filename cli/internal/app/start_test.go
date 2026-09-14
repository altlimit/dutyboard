package app

import "testing"

func TestSameRepo(t *testing.T) {
	same := [][2]string{
		{"git@github.com:altlimit/cadence.git", "https://github.com/altlimit/cadence"},
		{"https://github.com/Altlimit/Cadence.git", "ssh://git@github.com/altlimit/cadence"},
	}
	for _, p := range same {
		if !sameRepo(p[0], p[1]) {
			t.Errorf("%s and %s are the same repository", p[0], p[1])
		}
	}
	if sameRepo("git@github.com:altlimit/cadence.git", "git@github.com:altlimit/dutyboard.git") {
		t.Error("different repositories matched")
	}
	if sameRepo("", "") {
		t.Error("no URL matches nothing")
	}
}
