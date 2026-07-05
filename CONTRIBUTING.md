# Contributing to NeuroNest

Thank you for your interest in contributing to NeuroNest — the agent-first IDE built for production. Whether you're fixing a bug, adding a feature, improving documentation, or hardening security, this guide will help you get started.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Ways to Contribute](#ways-to-contribute)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Development Workflow](#development-workflow)
- [Coding Standards](#coding-standards)
- [Testing](#testing)
- [Security Contributions](#security-contributions)
- [Commit Conventions](#commit-conventions)
- [Pull Request Process](#pull-request-process)

## Code of Conduct

This project is governed by the [NeuroNest Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to uphold it.

## Ways to Contribute

- **Bug reports** — Found something broken? Open an issue using the bug report template.
- **Feature requests** — Have an idea for a new agent capability, provider integration, or UX improvement? Open a feature request.
- **Code contributions** — Bug fixes, new features, performance improvements, refactors.
- **Documentation** — Improvements to docs, README, inline code comments, or architecture references.
- **Testing** — Expanding test coverage (Vitest + fast-check property-based tests) is one of the highest-impact contributions you can make.
- **Security research** — See [Security Contributions](#security-contributions) below. **Do not open public issues for vulnerabilities.**

## Development Setup

### Prerequisites

- **macOS 11.0+** (Windows/Linux support is in progress; development currently targets macOS)
- **Node.js 20+**
- **npm** (ships with Node)
- **Xcode Command Line Tools** — required to compile the native C++ addon (`xcode-select --install`)
- **Docker Desktop** (optional) — required only if you're working on the Docker sandbox execution features
- At least one LLM provider API key (OpenAI, Anthropic, Google Gemini, etc.) or a local model via Ollama / llama.cpp for runtime testing

### Getting Started

```bash
# 1. Fork the repository, then clone your fork
git clone https://github.com/<your-username>/NeuroNest.git
cd NeuroNest

# 2. Install dependencies (this also builds the native module)
npm install

# 3. Compile the TypeScript main process
npm run build

# 4. Launch in development mode
npm run dev
```

If the native module fails to build, verify Xcode CLT is installed and that your Node version matches the Electron 33 ABI (`node -v` should report 20.x).

## Project Structure

```
NeuroNest/
├── src/                    # Application source
│   ├── main/               # Electron main process (TypeScript, Node.js backend)
│   ├── renderer/           # Renderer process (vanilla JS frontend)
│   └── preload/            # Typed IPC bridge (~200 allowlisted channels)
├── native/                 # C++ addon (Node-API, macOS CommonCrypto)
├── packages/neuronest-cli/ # CLI package
├── scripts/                # Build & release scripts
├── build/                  # Build configuration and resources
└── assets/                 # Icons and static assets
```

Key architectural rules to respect:

1. **Main/renderer separation is strict.** All communication between the renderer and main process goes through the typed IPC bridge. Never add direct Node.js access to the renderer or weaken `webPreferences` security settings.
2. **New IPC channels must be allowlisted** in the preload bridge and typed. Unregistered channels will be rejected.
3. **Database changes require a migration.** SQLite schema changes go through a new numbered migration file — never modify an existing migration that has shipped.
4. **The AI pipeline has a defined order** (Brainstorm → Firewall → ZERA Optimizer → Orchestrator Planner → Execution Mode Router → Swarm Coordinator → LLM Client → Action Security Analyzer → Event Stream). New pipeline stages need maintainer discussion before implementation — open an issue first.
5. **Security layers are independent by design.** A change to one layer (e.g., the Firewall Engine) must not create a dependency on another layer (e.g., the Action Analyzer).

## Development Workflow

1. **Check existing issues** before starting work. For anything non-trivial, open an issue first so we can discuss the approach — this avoids wasted effort on PRs that conflict with the roadmap.
2. **Create a branch** from `main` using the naming convention:
   - `feat/<short-description>` for features
   - `fix/<short-description>` for bug fixes
   - `docs/<short-description>` for documentation
   - `security/<short-description>` for security hardening (non-vulnerability)
3. **Keep changes focused.** One logical change per PR. A PR that fixes a bug, refactors a module, and reformats whitespace is three PRs.
4. **Write or update tests** for your change.
5. **Open a pull request** using the PR template.

## Coding Standards

### TypeScript (main process)

- Strict mode is expected. **Do not add `@ts-nocheck`, `@ts-ignore`, or `any` escapes** — if the types are fighting you, that's usually a design signal.
- Prefer explicit return types on exported functions.
- Use dependency injection where practical; avoid new singletons.
- Handle errors explicitly — no silent `catch {}` blocks. Failures in agent/swarm code should surface through the event stream.

### JavaScript (renderer)

- The renderer is vanilla JS by design — no frameworks.
- Keep modules small and focused. Avoid adding to large existing files when a new module is cleaner; the renderer is being incrementally decomposed, so new code should not deepen the monolith.
- All privileged operations go through the preload bridge. Never bypass it.

### C++ (native module)

- Follow existing Node-API patterns in `native/`.
- Any change to cryptographic code requires an explicit explanation in the PR description of what changed and why it is safe.

### General

- No secrets, API keys, or tokens in code, tests, fixtures, or commit history — the firewall's secrets scanner will flag them, and so will review.
- Match the formatting of surrounding code. If the repo config defines a formatter/linter, run it before committing.

## Testing

NeuroNest uses **Vitest** with **fast-check** for property-based testing.

```bash
# Run the full test suite
npm test

# Run a specific test file
npx vitest run path/to/file.test.ts

# Watch mode during development
npx vitest
```

Guidelines:

- Bug fixes should include a regression test that fails without the fix.
- New features need unit tests; features touching the AI pipeline, IPC bridge, or security layers need integration-level coverage.
- Property-based tests (fast-check) are strongly encouraged for parsers, sanitizers, firewall rules, and anything that processes untrusted input.
- Tests must not require live LLM API keys — mock provider responses.

## Security Contributions

NeuroNest ships a 7-layer defense-in-depth security model, and we take security contributions seriously.

- **Vulnerabilities:** Do **not** open a public issue. Report privately via [GitHub Security Advisories](https://github.com/NETGVai/NeuroNest/security/advisories/new) or email **security@netgv.ai**. We aim to acknowledge reports within 72 hours.
- **Hardening PRs** (non-vulnerability improvements to the firewall, action analyzer, sandbox, etc.) are welcome through the normal PR process, but please open an issue first to discuss scope.
- Contributions that intentionally weaken security controls (disabling web security, widening IPC allowlists without justification, bypassing the firewall pipeline) will be rejected.

## Commit Conventions

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<optional scope>): <description>

feat(swarm): add consensus-based output merging for parallel agents
fix(ipc): reject unallowlisted channels in preload bridge
docs(readme): clarify macOS Intel build requirements
test(firewall): add property-based tests for prompt injection detection
chore(deps): bump better-sqlite3 to latest
```

Types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `chore`, `security`, `build`, `ci`.

## Pull Request Process

1. Ensure `npm run build` and `npm test` pass locally.
2. Fill out the PR template completely — including the security impact section.
3. Link the related issue (`Closes #123`).
4. A maintainer will review your PR. Expect requests for changes; this is normal and collaborative.
5. Once approved, a maintainer will merge. We generally squash-merge to keep history clean.

### Review expectations

- Small, focused PRs get reviewed faster.
- PRs touching security layers, the IPC bridge, or the native module receive extra scrutiny.
- Stale PRs with unresolved review comments for 30+ days may be closed (you're welcome to reopen when ready).

## License

By contributing to NeuroNest, you agree that your contributions will be licensed under the [MIT License](LICENSE) that covers the project.

---

Questions? Open a [Discussion](https://github.com/NETGVai/NeuroNest/discussions) — we're happy to help you get started.