# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Home Assistant MQTT button for Lock Screen using macOS's native
  `login.framework`, without AppleScript or Accessibility permission.
- Home Assistant MQTT button for Sleep Display, backed by a device-scoped
  allowlisted command handler.
- Last Command diagnostic sensor with success/error details.

### Changed

- Replaced the Bun runtime with a pinned Node.js 26.7.0 Single Executable
  Application while preserving the native `SACLockScreenImmediate` lock call
  through Node's built-in FFI.
- Migrated development and tests from Bun to npm and Vitest.

### Deprecated

### Removed

- Start Screen Saver Home Assistant command.

### Fixed

- Activate Finder and confirm that the owning application relinquishes an
  exclusive macOS display capture before invoking Lock Screen, preventing
  fullscreen games from blocking the login window while the native lock API
  reports success.
- Explicitly ad-hoc sign and verify macOS release executables before
  publishing, preventing `OS_REASON_CODESIGNING` launch failures.
- Load the existing `.env` configuration with Node's native dotenv parser,
  restoring installed agents that previously relied on Bun's implicit loading.

### Security

## [1.0.0] - 2025-01-31

### Added

- Initial release
- Battery monitoring for macOS systems
- Power source detection (AC power, battery, UPS)
- Home Assistant MQTT auto-discovery integration
- Real-time updates with configurable intervals
- Single file executable compilation
- Graceful shutdown handling
- macOS LaunchAgent service support
- Environment variable configuration with Zod validation

### Features

- Monitors battery level, charging status, and time remaining
- Detects power source changes
- Automatic device registration in Home Assistant
- Uses native macOS commands (`pmset`, `system_profiler`)
- Compiled single binary for easy distribution
- Service management for background operation

[unreleased]: https://github.com/joeflateau/hass-agent/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/joeflateau/hass-agent/releases/tag/v1.0.0
