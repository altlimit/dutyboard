## Toolchain a desktop app usually needs
- The framework and its native prerequisites: Electron/Tauri (Node, Rust toolchain, platform webview libs), .NET (SDK version from `global.json`), Qt, or a native toolchain.
- Packaging tools the project uses (electron-builder, cargo-bundle, WiX) — only for the platforms this machine can build.
- System libraries that need admin rights to install go on the board as a question with the exact command.

## Rules worth checking for
- Auto-update and IPC surfaces treated as security boundaries: validate everything crossing them.
- No blocking work on the UI thread; startup time watched.
- Platform differences handled where the project already handles them (paths, line endings, file permissions).
- Tests pass on the platforms the change touches; builds for other platforms are left to CI.
