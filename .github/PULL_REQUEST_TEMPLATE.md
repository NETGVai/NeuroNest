# Pull Request

## Summary

<!-- What does this PR do, and why? One or two sentences. -->

## Related Issue

<!-- Non-trivial changes should be discussed in an issue first (see CONTRIBUTING.md). -->

Closes #

## Type of Change

<!-- Check all that apply -->

- [ ] 🐛 Bug fix (non-breaking change that fixes an issue)
- [ ] ✨ New feature (non-breaking change that adds functionality)
- [ ] 💥 Breaking change (fix or feature that would change existing behavior)
- [ ] 🔒 Security hardening
- [ ] ♻️ Refactor (no functional change)
- [ ] ⚡ Performance improvement
- [ ] 🧪 Test coverage
- [ ] 📖 Documentation
- [ ] 🔧 Build / CI / tooling

## Affected Areas

<!-- Check all that apply -->

- [ ] Main process (TypeScript backend)
- [ ] Renderer (vanilla JS frontend)
- [ ] Preload / IPC bridge
- [ ] Native module (C++)
- [ ] AI pipeline (firewall, orchestrator, swarm, providers)
- [ ] Database (SQLite migrations)
- [ ] CLI (neuronest-cli)
- [ ] Build scripts / CI

## Changes

<!-- Bullet the key changes so reviewers can navigate the diff -->

-
-

## Security Impact

<!-- NeuroNest ships a 7-layer security model. Answer honestly — "none" is a fine answer. -->

- [ ] This PR does **not** touch security layers, the IPC bridge, `webPreferences`, or the native crypto module
- [ ] This PR touches security-sensitive code — **explained below**

<!-- If security-sensitive: what changed, why it's safe, and what was tested -->

## Database Migrations

- [ ] No schema changes
- [ ] Adds a new migration file (never modifies a shipped migration)

## Testing

<!-- How did you verify this change? -->

- [ ] `npm run build` passes
- [ ] `npm test` passes locally
- [ ] Added/updated unit tests
- [ ] Added property-based tests (fast-check) where input is untrusted
- [ ] Manually tested on macOS (specify chip + OS version below)

**Test environment:**

<!-- e.g., macOS 15.2, M3 Pro, Node 20.11, Anthropic provider -->

## Checklist

- [ ] My code follows the project's coding standards (no `@ts-nocheck` / `@ts-ignore` / stray `any`)
- [ ] New IPC channels (if any) are allowlisted and typed in the preload bridge
- [ ] No secrets, API keys, or tokens in code, tests, or fixtures
- [ ] I performed a self-review of my own diff
- [ ] I updated documentation where behavior changed
- [ ] Commit messages follow Conventional Commits
- [ ] This PR is focused on a single logical change

## Screenshots / Recordings

<!-- For UI changes, include before/after. Redact any personal or proprietary content. -->

## Additional Notes

<!-- Anything reviewers should know: tradeoffs, follow-up work, open questions -->