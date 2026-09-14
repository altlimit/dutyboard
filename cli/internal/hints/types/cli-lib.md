## Toolchain a CLI or library usually needs
- The language toolchain at the version the project supports (and its minimum supported version, if CI tests it).
- The linters and formatters the project runs in CI, at their pinned versions.

## Rules worth checking for
- Public API and command-line flags are compatibility promises: changing one is a decision for a person.
- Errors are returned or reported with context, never swallowed; exit codes mean something.
- No new dependency without a reason the brief supports.
- Tests and linters pass; examples in docs still work.
