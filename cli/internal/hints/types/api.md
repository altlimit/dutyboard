## Toolchain an API or backend usually needs
- The language runtime at the pinned version, and dependencies installed from the lockfile.
- The datastore and any local services the tests expect (a database, queue or emulator the project documents — often via docker compose or a CLI).
- Migration and code-generation tools the project uses, at their pinned versions.

## Rules worth checking for
- Security: every endpoint authenticates and authorizes; inputs validated with explicit limits; queries parameterised; errors do not leak internals; secrets only from the environment.
- Data: migrations are reversible or explicitly not; no unbounded queries or writes; indexes for new query shapes.
- Reuse: existing middleware, clients and error types before new ones.
- Performance: no N+1 queries; timeouts on outbound calls; work that can be async kept off the request path.
- The full test suite passes; new endpoints get tests for their refusals, not just their success.
