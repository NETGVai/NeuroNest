# Changelog

All notable changes to NeuroNest will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This changelog is automatically generated from [changesets](https://github.com/changesets/changesets).
Each pull request with user-facing changes must include a changeset entry.

## [Unreleased]

## [0.1.586] - 2025-01-15

### Added

- Audit remediation: fail-closed security controls, sanitized environment, honest sandbox execution
- Loop Engine: bounded, verification-gated iterative execution with harness layer
- Agent registry: 118 specialized AI agents across 14 departments
- Swarm orchestration with 5 execution modes (flash/standard/pro/ultra/loop)
- Firewall rule correctness: word-boundary keyword matching, fork-bomb detection
- Data integrity: migration contiguity guard, unified data directory accessor
- Channel correctness: single status event constant, port validation, loopback-by-default
- Agent tool-permission checks: default-deny with explicit profiles
- CI drift guards for agent counts, migration contiguity, and IPC allowlist parity
- Property-based test suite (fast-check) covering all security invariants

### Fixed

- TypeScript configuration: incompatible module/moduleResolution pairing (TS5095)
- Action Security Analyzer: replaced allow-all default with fail-closed analyzer
- Firewall engine: broken pol-01 fork-bomb pattern, substring keyword matching
- Docker sandbox: no-op stubs no longer report false success in production builds
- Environment leakage: executeTerminal no longer passes full process.env

### Changed

- Agent count reconciled to 118 (derived from registry, CI-guarded)
- CHANGELOG wired to changeset versioning

## [0.1.0] - 2024-01-01

### Added

- Initial release of NeuroNest — AI Coding SuperAgent
- Electron-based IDE with integrated AI coding assistance
- Voice interaction via ONNX TTS engine
- Multi-model LLM support (OpenAI-compatible providers)
- Swarm-based multi-agent task execution
- Built-in terminal, Monaco editor, and project graph
- Cross-platform support (macOS, Windows, Linux)
- `@neuronest/cli` package for headless agent and MCP server
- Secure secret storage with Electron SafeStorage
- Auto-update via electron-updater
