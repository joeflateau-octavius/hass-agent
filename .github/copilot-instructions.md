# Copilot Instructions for Home Assistant Agent

<!-- Use this file to provide workspace-specific custom instructions to Copilot. For more details, visit https://code.visualstudio.com/docs/copilot/copilot-customization#_use-a-githubcopilotinstructionsmd-file -->

This is a TypeScript/Node.js project that creates a macOS system agent for Home Assistant integration.

## Project Overview

- **Purpose**: Monitor macOS power and battery status and send data to Home Assistant via MQTT
- **Runtime**: Node.js 26.7.0 with TypeScript
- **Target Platform**: macOS only
- **Communication**: MQTT with Home Assistant Auto Discovery
- **Build Target**: Signed Node.js Single Executable Application (SEA)

## Key Features

- Reads macOS battery level, charging status, and power source using `pmset` command
- Publishes data to Home Assistant using MQTT Discovery protocol
- Supports graceful shutdown handling
- Configurable update intervals
- Automatic device registration in Home Assistant

## Technical Constraints

- Lock Screen must continue to call `SACLockScreenImmediate` from macOS
  `login.framework` through `node:ffi`; do not replace it with AppleScript or
  Accessibility automation.
- Other macOS integration uses allowlisted native commands (`pmset`, `system_profiler`)
- MQTT client must be compatible with Home Assistant discovery format
- Must handle missing battery (desktop Macs) gracefully
- Requires executable permissions for system commands

## Code Style

- Use async/await for command execution
- Implement proper error handling for system commands
- Follow Home Assistant MQTT discovery naming conventions
- Use environment variables for configuration
- Include comprehensive logging for debugging

## Dependencies

- `mqtt`: MQTT client for Home Assistant communication
- `zod`: Schema validation for environment variables
- `@types/node`: TypeScript definitions for Node.js APIs
- Native macOS system commands (no additional dependencies)

## Environment Configuration

- Uses Zod schema validation for environment variables
- DEVICE_ID is required and must be unique
- DEVICE_NAME defaults to system hostname if not provided
- All configuration validated at startup with helpful error messages

## Development Workflow

- Always run tests after making code changes using the "Run Tests" VS Code task
- Verify all tests pass before considering changes complete
- Use `npm test` or the VS Code task to run the full test suite
- Run these once you think you are finished, not for every step/edit
