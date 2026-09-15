package daemon

import (
	"strings"
	"testing"
)

func TestCloneHintSaysHowToFixCredentials(t *testing.T) {
	cases := map[string]string{
		"fatal: could not read Username for 'https://github.com': terminal prompts disabled": "gh auth setup-git",
		"Host key verification failed.":                                   "ssh-keyscan github.com",
		"git@github.com: Permission denied (publickey).":                  "deploy keys",
		"remote: Repository not found.":                                   "URL is wrong",
		"fatal: unable to access 'https://x/': Could not resolve host: x": "",
	}
	for out, want := range cases {
		got := cloneHint("git@github.com:altlimit/musictheory.git", out)
		if want == "" && got != "" || want != "" && !strings.Contains(got, want) {
			t.Errorf("hint for %q = %q, want it to mention %q", out, got, want)
		}
	}
}
