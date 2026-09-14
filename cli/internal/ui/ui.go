// Package ui is the terminal half of the program: progress lines and the few questions it asks.
//
// Questions are only asked of a person. When stdin is not a terminal — a service, a pipe, CI —
// every question takes its default, or fails if it has none, rather than blocking forever on input
// that is never coming.
package ui

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"

	"golang.org/x/term"
)

// ErrNoAnswer is a question that needed a person when there was none.
var ErrNoAnswer = errors.New("this needs an answer, and nobody is at the terminal to give one")

// UI writes progress and asks questions.
type UI struct {
	Out         io.Writer
	Interactive bool
	in          *bufio.Reader
	color       bool
}

// New is a UI on the process's own stdin and stdout.
func New() *UI {
	return &UI{
		Out:         os.Stdout,
		Interactive: term.IsTerminal(int(os.Stdin.Fd())),
		in:          bufio.NewReader(os.Stdin),
		color:       term.IsTerminal(int(os.Stdout.Fd())),
	}
}

func (u *UI) bold(s string) string {
	if !u.color {
		return s
	}
	return "\033[1m" + s + "\033[0m"
}

func (u *UI) dim(s string) string {
	if !u.color {
		return s
	}
	return "\033[2m" + s + "\033[0m"
}

// Step starts a stage of work.
func (u *UI) Step(format string, a ...any) {
	fmt.Fprintf(u.Out, "\n%s %s\n", u.bold("==>"), u.bold(fmt.Sprintf(format, a...)))
}

// Say is one line of progress.
func (u *UI) Say(format string, a ...any) { fmt.Fprintf(u.Out, "    %s\n", fmt.Sprintf(format, a...)) }

// Note is a line worth having and not worth reading first.
func (u *UI) Note(format string, a ...any) {
	fmt.Fprintf(u.Out, "    %s\n", u.dim(fmt.Sprintf(format, a...)))
}

// OK marks something done.
func (u *UI) OK(format string, a ...any) { fmt.Fprintf(u.Out, "  ✓ %s\n", fmt.Sprintf(format, a...)) }

// Warn is something wrong that did not stop the work.
func (u *UI) Warn(format string, a ...any) {
	fmt.Fprintf(u.Out, "  ! %s\n", fmt.Sprintf(format, a...))
}

func (u *UI) readLine() (string, error) {
	line, err := u.in.ReadString('\n')
	if err != nil && line == "" {
		return "", err
	}
	return strings.TrimSpace(line), nil
}

// Ask asks for a line of text; empty takes def.
func (u *UI) Ask(question, def string) (string, error) {
	if !u.Interactive {
		if def == "" {
			return "", fmt.Errorf("%w: %s", ErrNoAnswer, question)
		}
		return def, nil
	}
	hint := ""
	if def != "" {
		hint = " " + u.dim("["+def+"]")
	}
	fmt.Fprintf(u.Out, "%s%s: ", question, hint)
	line, err := u.readLine()
	if err != nil {
		return "", err
	}
	if line == "" {
		return def, nil
	}
	return line, nil
}

// Secret asks for a value without echoing it.
func (u *UI) Secret(question string) (string, error) {
	if !u.Interactive {
		return "", fmt.Errorf("%w: %s", ErrNoAnswer, question)
	}
	fmt.Fprintf(u.Out, "%s: ", question)
	b, err := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Fprintln(u.Out)
	return strings.TrimSpace(string(b)), err
}

// Confirm asks yes or no.
func (u *UI) Confirm(question string, def bool) (bool, error) {
	if !u.Interactive {
		return def, nil
	}
	hint := "[y/N]"
	if def {
		hint = "[Y/n]"
	}
	fmt.Fprintf(u.Out, "%s %s ", question, hint)
	line, err := u.readLine()
	if err != nil {
		return false, err
	}
	switch strings.ToLower(line) {
	case "":
		return def, nil
	case "y", "yes":
		return true, nil
	default:
		return false, nil
	}
}

// Choose asks for one of options by number; empty takes def (0-based).
func (u *UI) Choose(question string, options []string, def int) (int, error) {
	if !u.Interactive {
		if def < 0 {
			return 0, fmt.Errorf("%w: %s", ErrNoAnswer, question)
		}
		return def, nil
	}
	fmt.Fprintln(u.Out, question)
	for i, o := range options {
		fmt.Fprintf(u.Out, "  %d) %s\n", i+1, o)
	}
	for {
		hint := ""
		if def >= 0 {
			hint = " " + u.dim("["+strconv.Itoa(def+1)+"]")
		}
		fmt.Fprintf(u.Out, ">%s ", hint)
		line, err := u.readLine()
		if err != nil {
			return 0, err
		}
		if line == "" && def >= 0 {
			return def, nil
		}
		if n, err := strconv.Atoi(line); err == nil && n >= 1 && n <= len(options) {
			return n - 1, nil
		}
		fmt.Fprintf(u.Out, "  pick a number from 1 to %d\n", len(options))
	}
}
