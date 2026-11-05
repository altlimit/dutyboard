package daemon

import (
	"context"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/altlimit/dutyboard/cli/internal/board"
)

// A board of one-off tasks has no repository. Each of its duties is worked in a folder of its own:
//
//	<worktrees>/<board>/<duty>/in/    the files people attached to the duty, fetched before it starts
//	<worktrees>/<board>/<duty>/out/   what the session makes, put on the duty when it completes
//
// Nothing is committed or integrated; the folder goes when the duty is done.
//
// A board that runs an account through its MCP servers is worked the same way, and also keeps a folder
// between duties — <root>/<board>/local/ — for what its sessions build on from one duty to the next:
// the sources of the files they publish, notes on where things stand. It is this machine's only; what
// another machine needs goes into the account itself.

// inputWait is how long a duty waits for files the person filing it was still attaching. Past it, the
// session starts with what arrived, and is told what is missing.
var inputWait = 10 * time.Minute

const inputPoll = 3 * time.Second

// keptFolder makes, and answers, the folder a board run through its MCP servers keeps between duties.
func (d *Daemon) keptFolder(boardID string) (string, error) {
	dir := d.localDir(boardID)
	return dir, os.MkdirAll(dir, 0o755)
}

// filesFolder answers the duty's folder and its in/ and out/.
func (d *Daemon) filesFolder(run *Run) (dir, in, out string) {
	dir = d.wt.Path(run.Board, run.DutyID)
	return dir, filepath.Join(dir, "in"), filepath.Join(dir, "out")
}

// prepareFiles makes the duty's folder, fetches into in/ every file a person attached that is not there
// yet, and answers the folder, whether it was made now, and what in/ holds. It waits first for files
// still on their way, so a duty claimed seconds after it was filed does not start without its input.
func (d *Daemon) prepareFiles(ctx context.Context, run *Run, duty *board.Duty) (dir string, created bool, inputs []string, missing int, err error) {
	dir, in, out := d.filesFolder(run)
	if _, statErr := os.Stat(dir); os.IsNotExist(statErr) {
		created = true
	}
	for _, p := range []string{in, out} {
		if err := os.MkdirAll(p, 0o755); err != nil {
			return "", false, nil, 0, err
		}
	}

	var ready []board.Attachment
	deadline := time.Now().Add(inputWait)
	for {
		all, err := d.api.Attachments(ctx, run.Board, run.DutyID)
		if err != nil {
			return "", false, nil, 0, fmt.Errorf("listing the duty's files: %w", err)
		}
		ready, missing = ready[:0], duty.ExpectFiles
		pending := false
		for _, a := range all {
			if a.AuthorType == "agent" {
				continue // what a session made, or a session log: not input
			}
			if a.Pending {
				pending = true
				continue
			}
			ready = append(ready, a)
		}
		missing -= len(ready)
		if (!pending && missing <= 0) || time.Now().After(deadline) {
			break
		}
		run.set("working", "waiting for its files to finish uploading")
		d.report(ctx, run.Board)
		select {
		case <-ctx.Done():
			return "", false, nil, 0, ctx.Err()
		case <-time.After(inputPoll):
		}
	}

	have := map[string]int64{}
	if entries, err := os.ReadDir(in); err == nil {
		for _, e := range entries {
			if info, err := e.Info(); err == nil && e.Type().IsRegular() {
				have[e.Name()] = info.Size()
			}
		}
	}
	for _, a := range ready {
		name, fetched := fileNameFor(have, safeFileName(a.Name), a.Size)
		if fetched {
			continue
		}
		if err := d.api.Download(ctx, a, filepath.Join(in, name)); err != nil {
			return "", false, nil, 0, err
		}
		have[name] = a.Size
	}
	for name := range have {
		inputs = append(inputs, name)
	}
	sort.Strings(inputs)
	if missing < 0 {
		missing = 0
	}
	return dir, created, inputs, missing, nil
}

// attachOutputs puts every file in the duty's out/ on the duty, skipping what an earlier call already
// attached, and answers their names.
func (d *Daemon) attachOutputs(ctx context.Context, run *Run) ([]string, error) {
	_, _, out := d.filesFolder(run)
	var files []string
	err := filepath.WalkDir(out, func(p string, e fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if strings.HasPrefix(e.Name(), ".") && p != out {
			if e.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if e.Type().IsRegular() {
			files = append(files, p)
		}
		return nil
	})
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	if len(files) == 0 {
		return nil, nil
	}
	existing, err := d.api.Attachments(ctx, run.Board, run.DutyID)
	if err != nil {
		return nil, fmt.Errorf("listing the duty's files: %w", err)
	}
	attached := map[string][]board.Attachment{}
	for _, a := range existing {
		if a.AuthorType == "agent" {
			attached[a.Name] = append(attached[a.Name], a)
		}
	}
	var names []string
	for _, p := range files {
		rel, _ := filepath.Rel(out, p)
		name := filepath.ToSlash(rel)
		info, err := os.Stat(p)
		if err != nil {
			return names, err
		}
		if before := attached[name]; len(before) != 1 || before[0].Size != info.Size() {
			if err := d.api.AttachFile(ctx, run.Board, run.DutyID, run.Agent, name, p); err != nil {
				return names, fmt.Errorf("attaching %s: %w", name, err)
			}
			// The file changed since an earlier session attached it: the new one replaces it, so the duty
			// holds one copy of each file — the one the outcome describes.
			for _, a := range before {
				if err := d.api.DeleteAttachment(ctx, run.Board, a.ID); err != nil {
					d.log.Printf("%s: removing the earlier %s from %s: %v", run.Board, name, run.DutyID, err)
				}
			}
		}
		names = append(names, name)
	}
	return names, nil
}

// safeFileName is an attachment's name as a file in one folder: no path, nothing a shell or Windows
// reads as something else.
func safeFileName(name string) string {
	// path, not filepath: on Windows filepath.Base takes "a:" in "a:b.txt" for a drive and drops it.
	name = path.Base(strings.ReplaceAll(name, "\\", "/"))
	name = strings.Map(func(r rune) rune {
		if r < 32 || strings.ContainsRune(`<>:"/\|?*`, r) {
			return '_'
		}
		return r
	}, name)
	if name == "" || name == "." || name == ".." {
		return "file"
	}
	return name
}

// fileNameFor is the name an attachment has in a folder holding have: name, or name with a number
// before its extension when a different file already has it. fetched says a file of its size is
// already there under one of those names — fetched before, by an earlier session.
func fileNameFor(have map[string]int64, name string, size int64) (string, bool) {
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	candidate := name
	for i := 2; ; i++ {
		had, taken := have[candidate]
		if !taken {
			return candidate, false
		}
		if had == size {
			return candidate, true
		}
		candidate = fmt.Sprintf("%s (%d)%s", stem, i, ext)
	}
}
