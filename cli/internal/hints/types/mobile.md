## Toolchain a mobile app usually needs
- The framework SDK at the project's version: Flutter (`pubspec.yaml` → `environment`), React Native (`package.json`), native Android (Gradle wrapper, `compileSdk`) or iOS (Xcode version, CocoaPods/SPM).
- Android SDK command-line tools, the platform and build-tools versions the project names, and a JDK. Accepting SDK licences needs a person — ask.
- iOS builds need macOS with Xcode; on other machines, say so on the board rather than attempting them.

## Rules worth checking for
- No secrets or API keys in the app bundle; signing keys never committed.
- Main-thread work kept minimal; lists virtualised; images sized for the device.
- Permissions requested only when needed, with the project's own copy.
- Unit and widget/UI tests pass for every platform the change touches.
