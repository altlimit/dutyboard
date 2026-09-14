## Toolchain a game usually needs
- The engine at the exact version the project names: Godot (`project.godot` → `config/features`), Unity (`ProjectSettings/ProjectVersion.txt`), Unreal (`.uproject` → `EngineAssociation`), Bevy/Rust (`Cargo.toml`), Phaser/web (`package.json`).
- Export templates for every target the project exports (web, desktop, mobile) — without them a headless export fails late.
- A headless way to run the engine for tests and exports (`godot --headless`, Unity `-batchmode`).
- The test framework the project uses (GUT, gdUnit4, Unity Test Framework) and any browser test runner for web builds (Playwright).

## Rules worth checking for
- Every scene and script loads headless without errors; a compile check runs before integrating.
- Frame time: no allocation or node lookups in per-frame code paths; reuse objects; cache node references.
- Assets: import settings are committed, generated caches (`.godot/`, `Library/`) never are.
- Visual changes are verified by looking at a screenshot, not assumed.
- Accessibility and input: every action works with keyboard and touch where the project targets them.
