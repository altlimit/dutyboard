// Package prompt writes what an agent is told when it is given a duty.
//
// Two parts. The SYSTEM part is the same for every duty on a board: how a headless session works
// the board, the board's rules, and what the project is. The DUTY part is the one duty, and what
// done means for it. The loop itself is not in either — the daemon claims, runs, and checks — so
// nothing here asks the agent to poll, claim or pick its own next piece of work.
package prompt

import (
	"bytes"
	"embed"
	"strings"
	"text/template"

	"github.com/altlimit/dutyboard/cli/internal/board"
)

//go:embed templates/*.md
var files embed.FS

var tmpl = template.Must(template.New("").Funcs(template.FuncMap{
	"join": strings.Join,
}).ParseFS(files, "templates/*.md"))

// Input is everything a prompt is written from.
type Input struct {
	Duty        board.Duty
	Board       board.BoardView
	Rules       string
	RulesAt     int
	Branch      string
	Worktree    string
	Mode        string // push, pr, branch
	Resuming    bool
	Attempt     int
	ProjectRoot string // the linked folder, for setup
	Tools       string // what is installed on this machine, one line each
}

// System is the part appended to the agent's own system prompt.
func System(in Input) (string, error) { return render("system.md", in) }

// Duty is the prompt for one session.
func Duty(in Input) (string, error) {
	switch in.Duty.Kind {
	case "setup":
		return render("setup.md", in)
	case "rules":
		return render("rules.md", in)
	default:
		return render("work.md", in)
	}
}

func render(name string, in Input) (string, error) {
	var b bytes.Buffer
	if err := tmpl.ExecuteTemplate(&b, name, in); err != nil {
		return "", err
	}
	return strings.TrimSpace(b.String()), nil
}
