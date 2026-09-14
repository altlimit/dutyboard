// Package deploy is how a project's work ships after it lands: what the repository's CI does on a
// push, and watching that CI for the commit a duty produced.
package deploy

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// Detection is the daemon's reading of a repository's workflows. It is handed to the setup session
// to confirm or correct — the session can read the scripts a workflow calls, which this cannot.
type Detection struct {
	Method   string   `json:"method"` // ci, ci-dispatch, or none
	Workflow string   `json:"workflow,omitempty"`
	Branch   string   `json:"branch,omitempty"`
	Evidence []string `json:"evidence,omitempty"`
}

// deployWords are what a deploy step usually says somewhere in its name, action or command.
var deployWords = regexp.MustCompile(`(?i)\b(deploy|publish|release|altengine|gh-pages|pages|wrangler|firebase|vercel|netlify|fly(ctl)?|heroku|s3 sync|rsync|kubectl|helm|terraform apply)\b`)

type workflow struct {
	Name string                 `yaml:"name"`
	On   yaml.Node              `yaml:"on"`
	Jobs map[string]workflowJob `yaml:"jobs"`
}

type workflowJob struct {
	Name  string `yaml:"name"`
	Steps []struct {
		Name string `yaml:"name"`
		Uses string `yaml:"uses"`
		Run  string `yaml:"run"`
	} `yaml:"steps"`
}

// Detect reads repo/.github/workflows. base is the branch work lands on.
func Detect(repo, base string) Detection {
	dir := filepath.Join(repo, ".github", "workflows")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return Detection{Method: "none", Evidence: []string{"no .github/workflows"}}
	}
	var names []string
	for _, e := range entries {
		if n := e.Name(); strings.HasSuffix(n, ".yml") || strings.HasSuffix(n, ".yaml") {
			names = append(names, n)
		}
	}
	sort.Strings(names)

	var dispatch *Detection
	for _, name := range names {
		b, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			continue
		}
		var wf workflow
		if yaml.Unmarshal(b, &wf) != nil {
			continue
		}
		evidence := deploySteps(wf)
		if len(evidence) == 0 {
			continue
		}
		push, branchOK, manual := triggers(&wf.On, base)
		switch {
		case push && branchOK:
			return Detection{Method: "ci", Workflow: name, Branch: base, Evidence: append([]string{"runs on push to " + base}, evidence...)}
		case manual && dispatch == nil:
			dispatch = &Detection{Method: "ci-dispatch", Workflow: name, Branch: base, Evidence: append([]string{"runs only when dispatched"}, evidence...)}
		}
	}
	if dispatch != nil {
		return *dispatch
	}
	return Detection{Method: "none", Evidence: []string{"no workflow deploys on push or dispatch"}}
}

func deploySteps(wf workflow) []string {
	var out []string
	jobNames := make([]string, 0, len(wf.Jobs))
	for id := range wf.Jobs {
		jobNames = append(jobNames, id)
	}
	sort.Strings(jobNames)
	for _, id := range jobNames {
		job := wf.Jobs[id]
		if deployWords.MatchString(id) || deployWords.MatchString(job.Name) {
			out = append(out, "job "+id)
		}
		for _, s := range job.Steps {
			for _, text := range []string{s.Name, s.Uses, s.Run} {
				if m := deployWords.FindString(text); m != "" {
					label := s.Name
					if label == "" {
						label = firstLine(s.Uses + s.Run)
					}
					out = append(out, "step "+strings.TrimSpace(label))
					break
				}
			}
		}
	}
	if len(out) > 4 {
		out = out[:4]
	}
	return out
}

// triggers reads a workflow's `on:` in any of its three shapes — a string, a list, or a map — and
// answers whether it runs on push, whether a push to base qualifies, and whether it can be
// dispatched by hand. A commented-out `push:` is simply absent here, which is the point.
func triggers(on *yaml.Node, base string) (push, branchOK, manual bool) {
	switch on.Kind {
	case yaml.ScalarNode:
		return on.Value == "push", on.Value == "push", on.Value == "workflow_dispatch"
	case yaml.SequenceNode:
		for _, n := range on.Content {
			if n.Value == "push" {
				push, branchOK = true, true
			}
			if n.Value == "workflow_dispatch" {
				manual = true
			}
		}
		return
	case yaml.MappingNode:
		for i := 0; i+1 < len(on.Content); i += 2 {
			key, val := on.Content[i].Value, on.Content[i+1]
			switch key {
			case "workflow_dispatch":
				manual = true
			case "push":
				push = true
				branchOK = pushMatches(val, base)
			}
		}
	}
	return
}

func pushMatches(push *yaml.Node, base string) bool {
	if push.Kind != yaml.MappingNode {
		return true // `push:` with nothing under it: every branch
	}
	var branches, ignored []string
	hasTagsOnly := false
	for i := 0; i+1 < len(push.Content); i += 2 {
		key, val := push.Content[i].Value, push.Content[i+1]
		var list []string
		_ = val.Decode(&list)
		switch key {
		case "branches":
			branches = list
		case "branches-ignore":
			ignored = list
		case "tags":
			hasTagsOnly = true
		}
	}
	if branches == nil && ignored == nil {
		return !hasTagsOnly
	}
	for _, pattern := range ignored {
		if globMatch(pattern, base) {
			return false
		}
	}
	if branches == nil {
		return true
	}
	for _, pattern := range branches {
		if globMatch(pattern, base) {
			return true
		}
	}
	return false
}

func globMatch(pattern, s string) bool {
	re := "^" + strings.NewReplacer(`\*\*`, ".*", `\*`, "[^/]*").Replace(regexp.QuoteMeta(pattern)) + "$"
	ok, _ := regexp.MatchString(re, s)
	return ok
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	if len(s) > 80 {
		s = s[:80]
	}
	return s
}

// Describe is one line for a prompt.
func (d Detection) Describe() string {
	switch d.Method {
	case "ci":
		return "`" + d.Workflow + "` deploys on every push to " + d.Branch + " (" + strings.Join(d.Evidence[1:], "; ") + ")"
	case "ci-dispatch":
		return "`" + d.Workflow + "` deploys, but only when dispatched (" + strings.Join(d.Evidence[1:], "; ") + ")"
	default:
		return "no workflow that deploys was found"
	}
}
