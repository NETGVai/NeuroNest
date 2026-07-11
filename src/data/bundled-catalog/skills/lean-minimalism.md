<!--
SPDX-License-Identifier: MIT
Copyright (c) Lean Plugin Contributors
Derived from the Lean minimalism plugin, licensed under the MIT License.
See LICENSE file in the vendored source for full license text.
-->

---
id: lean-minimalism
name: Lean Minimalism
description: Enforce the five-rung Minimalism Ladder to counteract over-engineering bias and produce the simplest correct solution
source: bundled
version: 1.0.0
category: code-quality
tags: [minimalism, yagni, lean, simplicity, over-engineering]
scope: project
---

# Lean Minimalism

Enforce the five-rung Minimalism Ladder on every code-producing action. Prefer the highest rung that satisfies the requirement.

## Minimalism Ladder

For every implementation decision, descend the ladder and stop at the first rung that solves the problem:

1. **Do not build it (YAGNI)** — If the feature is not explicitly required right now, do not write it.
2. **Use standard library** — If the language's stdlib already solves it, use that.
3. **Use native language features** — If a built-in construct (generics, pattern matching, iterators) covers the need, prefer it over external code.
4. **Use a single well-known dependency** — If a widely-adopted, actively-maintained package exists, prefer one dependency over hand-rolling.
5. **Write it in one line if possible** — If the implementation can be expressed clearly in a single line or expression, do so.

## Output Rule

Code first, ≤3 lines of explanation. Every response that produces code MUST lead with the code block. Any accompanying explanation MUST NOT exceed three lines of prose.

## Safety Exclusion

The following categories are NEVER subject to minimalism reduction, regardless of ladder position:

- **Trust-boundary validation** — Input validation at system boundaries, authentication checks, authorization guards.
- **Data-loss handling** — Backup logic, transaction safety, write-ahead protections, graceful degradation on storage failure.
- **Security controls** — Encryption, secret management, rate limiting, CSRF/XSS protections, audit logging.
- **Accessibility compliance** — ARIA attributes, semantic HTML, keyboard navigation, screen-reader support.

These domains require full, robust implementations. Never simplify, stub, or reduce them in the name of minimalism.
