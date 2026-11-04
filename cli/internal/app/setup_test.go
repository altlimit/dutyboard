package app

import "testing"

func TestVersionLess(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want bool
	}{
		{"2.19.2", "2.20.0", true},
		{"2.9.0", "2.10.0", true},
		{"v2.20.1", "2.20.1", false},
		{"2.20.1", "2.20.0", false},
		{"2.20", "2.20.1", true},
		{"2.20.1-rc1", "2.20.1", false},
		{"dev", "2.20.0", false},
		{"2.20.0", "dev", false},
		{"", "2.20.0", false},
	} {
		if got := versionLess(c.a, c.b); got != c.want {
			t.Errorf("versionLess(%q, %q) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}
