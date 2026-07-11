# Project Rules

## Code Style

- Write clear, readable code with meaningful names
- Keep functions focused and small (≤30 lines preferred)
- Prefer composition over inheritance
- Document public APIs with JSDoc/TSDoc comments

## Architecture

- Follow established project patterns and conventions
- Keep modules loosely coupled with clear boundaries
- Prefer flat directory structures over deep nesting
- Use dependency injection for testability

## Testing

- Write tests for all new public behavior
- Prefer property-based tests for pure logic
- Keep tests isolated — no shared mutable state
- Name tests descriptively: "should [expected] when [condition]"

## Minimalism Ladder

Stop at the first rung that solves the problem:

1. **YAGNI** — Don't build it if not required now.
2. **stdlib** — Use standard library if it solves the need.
3. **native** — Prefer built-in language features over external code.
4. **dependency** — Use one well-known package over hand-rolling.
5. **one-line** — Express in one line if clear.

Safety Exclusion: trust-boundary validation, data-loss handling, security controls, and accessibility are NEVER subject to minimalism reduction.

## Quality

- No commented-out code in commits
- No TODO without a linked issue or upgrade path
- Resolve all linter warnings before marking complete
- Prefer explicit error handling over silent failures

## Dependencies

- Pin dependency versions; avoid open ranges
- Prefer well-maintained packages with active communities
- Audit new dependencies for size, license, and security
- One dependency per concern — avoid mega-frameworks

## Git

- Write atomic commits with clear messages
- Keep PRs focused on a single concern
- Reference issues in commit messages when applicable
