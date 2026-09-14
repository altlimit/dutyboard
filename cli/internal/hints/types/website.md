## Toolchain a website usually needs
- The site generator or framework the repository uses (Hugo, Jekyll, Astro, Eleventy, Next.js, a custom generator) at its pinned version.
- Node and the package manager the lockfile belongs to (`package-lock.json` → npm, `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn).
- A browser for checking pages (Playwright's Chromium) and, if the project has one, its link or HTML checker.

## Rules worth checking for
- Every page builds; no broken internal links; images have alt text; headings are in order.
- Performance budget: images sized and compressed, no render-blocking scripts the page does not need.
- SEO basics the site already follows: titles, descriptions, canonical URLs.
- Nothing secret in client-side code or committed config.
