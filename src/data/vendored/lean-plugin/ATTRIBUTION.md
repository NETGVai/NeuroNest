# Lean Plugin Attribution

This directory contains vendored source from the **Lean minimalism plugin**.

## License

The Lean plugin is licensed under the **MIT License**. See the [LICENSE](./LICENSE)
file in this directory for the full license text.

## Copyright

Copyright (c) Lean Plugin Contributors

## Usage in NeuroNest

The Lean plugin source is integrated into NeuroNest as a first-class minimalism
enforcement system. The core concepts from the plugin — the five-rung Minimalism
Ladder, Lean Comments syntax, and safety exclusion policy — are adapted and
extended for the NeuroNest agent pipeline.

## Components Derived from This Source

- `src/data/bundled-catalog/skills/lean-minimalism.md` — Bundled skill document
- `src/pipeline/system-prompt-builder.ts` — Minimalism directive section builder

> Note: the former `src/loop-engine/harness/verifier-subagent.ts` (Lean Comment
> parsing and reconciliation) and `src/loop-engine/harness/debt-ledger.ts`
> (Debt Ledger storage) components were removed with the loop-engine subsystem
> (spec orphaned-code-remediation task 14.2, R10 REMOVE disposition).

## Modifications

The original plugin concepts have been adapted for NeuroNest's architecture:
- The Minimalism Ladder is injected via the system prompt builder
- Lean Comments are reconciled during verification (not at write-time)
- Safety exclusions are enforced through the verifier subagent
- Debt entries are persisted to `.neuronest/memory/lean-debt.json`
