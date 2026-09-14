// Package hints is what the setup and rules duties start from for each kind of project: the
// toolchain such a project usually needs, and the rules worth checking for. A starting point the
// session confirms against the repository — never a list it installs from blindly.
package hints

import (
	"embed"
	"strings"
)

//go:embed types/*.md
var files embed.FS

// For answers the hints for a project type, or the generic ones.
func For(projectType string) string {
	b, err := files.ReadFile("types/" + projectType + ".md")
	if err != nil {
		b, _ = files.ReadFile("types/other.md")
	}
	return strings.TrimSpace(string(b))
}
