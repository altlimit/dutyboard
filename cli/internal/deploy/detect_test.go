package deploy

import (
	"os"
	"path/filepath"
	"testing"
)

func repoWith(t *testing.T, workflows map[string]string) string {
	t.Helper()
	repo := t.TempDir()
	for name, body := range workflows {
		p := filepath.Join(repo, ".github", "workflows", name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return repo
}

func TestDetect(t *testing.T) {
	cases := []struct {
		name, want, workflow string
		files                map[string]string
	}{
		{"no workflows", "none", "", nil},
		{"ci only builds", "none", "", map[string]string{"ci.yml": "on: [push, pull_request]\njobs:\n  build:\n    steps:\n      - run: npm test\n"}},
		{"deploys on push to main", "ci", "deploy.yml", map[string]string{
			"ci.yml":     "on: pull_request\njobs:\n  test:\n    steps:\n      - run: npm test\n",
			"deploy.yml": "on:\n  push:\n    branches: [main]\njobs:\n  ship:\n    steps:\n      - name: Deploy to altengine static\n        run: npm run deploy:site\n",
		}},
		// This repository's own deploy-site.yml: push is commented out, so it only dispatches.
		{"push commented out", "ci-dispatch", "deploy-site.yml", map[string]string{"deploy-site.yml": `name: deploy site

on:
  # push:
  #   branches: [main]
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: npm run deploy:site
`}},
		{"push to another branch", "ci-dispatch", "pages.yml", map[string]string{"pages.yml": "on:\n  push:\n    branches: [release/*]\n  workflow_dispatch: {}\njobs:\n  pages:\n    steps:\n      - uses: peaceiris/actions-gh-pages@v4\n"}},
		{"branches-ignore excludes main", "none", "", map[string]string{"x.yml": "on:\n  push:\n    branches-ignore: [main]\njobs:\n  deploy:\n    steps:\n      - run: ./deploy.sh\n"}},
		{"tags only", "none", "", map[string]string{"release.yml": "on:\n  push:\n    tags: ['v*']\njobs:\n  release:\n    steps:\n      - run: goreleaser release\n"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := Detect(repoWith(t, c.files), "main")
			if got.Method != c.want || got.Workflow != c.workflow {
				t.Fatalf("got %+v, want %s %s", got, c.want, c.workflow)
			}
		})
	}
}
