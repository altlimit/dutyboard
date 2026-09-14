## Finding the toolchain
- Read the repository's manifests, lockfiles, CI workflows, Dockerfiles and README to learn what it builds and tests with, and at which versions.
- Prefer the versions the project pins over the latest.

## Rules worth checking for
- Secrets never committed; inputs validated wherever the project takes them.
- Existing helpers and patterns reused before new ones are written.
- The project's own tests and checks pass before work lands.
