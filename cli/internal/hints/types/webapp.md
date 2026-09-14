## Toolchain a web app usually needs
- The runtime at the version the project pins (`.nvmrc`, `engines`, `.tool-versions`, `go.mod`, `pyproject.toml`).
- The package manager the lockfile belongs to, and the dependencies installed from the lockfile (`npm ci`, not `npm install`).
- Whatever the tests need locally: a database or emulator the project documents, and a browser for end-to-end tests.

## Rules worth checking for
- Security: input validated at the server boundary; authorization checked on every endpoint, not just in the UI; no secrets in client bundles or logs; dependencies not added without need.
- Reuse: shared components, API clients and validation live in one place — find them before writing new ones.
- Performance: no N+1 queries, pagination on lists, bundle size watched, work kept off the request path where the project already does so.
- Every change runs the full test suite; UI changes are checked in a browser.
