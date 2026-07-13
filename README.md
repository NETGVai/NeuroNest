<h1 align="center">🧠 NeuroNest</h1>

<p align="center">
  <strong>The AI Coding SuperAgent</strong>
</p>

<p align="center">
  118 specialized AI agents. 14 departments. One desktop app.<br/>
  Ship software faster with swarm intelligence, not just autocomplete.
</p>

<p align="center">
  <a href="https://neuronest.cc">Website</a> &middot;
  <a href="https://neuronest.cc/docs">Documentation</a> &middot;
  <a href="https://neuronest.cc/download">Download</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-000?style=flat-square&logo=electron" alt="Platforms" />
  <img src="https://img.shields.io/badge/version-0.1.586-blue?style=flat-square" alt="Version" />
  <img src="https://img.shields.io/badge/agents-118-purple?style=flat-square" alt="Agents" />
  <img src="https://img.shields.io/badge/providers-11-green?style=flat-square" alt="Providers" />
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-BUSL--1.1-yellow?style=flat-square" alt="License: BUSL-1.1" /></a>
</p>

---

## What is NeuroNest?

NeuroNest is a desktop AI development environment that goes beyond code completion. Instead of a single copilot, you get an entire engineering organization — 118 specialist agents across 14 departments — that collaborates through swarm orchestration to tackle complex software tasks.

Ask it to build a feature. It plans the architecture, assigns specialists, selects the optimal execution mode, runs agents in parallel, verifies results with an adversarial reviewer, and delivers tested code with an immutable receipt.

---

## Key Features

### 118 Specialized AI Agents

A full engineering team across 14 departments: Engineering, Design, Marketing, Product, Project Management, Testing, Support, Specialized, Consensus, Infrastructure, Optimization, Research, Software Delivery, and NeuroNest Orchestration. Each agent has focused expertise, domain-specific system prompts, and scoped tool permissions.

### Swarm Orchestration with 5 Execution Modes

NeuroNest dynamically selects the optimal execution strategy based on task complexity:

| Mode | Agents | Strategy | Best For |
|------|--------|----------|----------|
| **Flash** | 1 | Single best-fit agent | Simple edits, renames, quick fixes |
| **Standard** | ≤3 | Focused team, sequential | Moderate tasks, bug fixes |
| **Pro** | All planned | Sequential multi-agent | Feature implementation |
| **Ultra** | All planned | Parallel decomposition | Large-scale refactoring |
| **Loop** | Iterative | Bounded verification-gated passes | Fix-all-errors, test repair |

Mode selection is automatic (based on agent scoring) or manually overridable via settings.

### Loop Engine

Bounded, verification-gated iterative execution. Define a goal, verification checks, and stop conditions — NeuroNest loops until the checks pass or limits are hit. Built-in loops: Type-clean (tsc), Test-repair (vitest), Docs-current (link-check). Features include:

- 11-state deterministic state machine with guaranteed termination
- Independent verifier subagent that catches 11 fake-done shortcut patterns
- Immutable receipts for every run (auditable, reproducible)
- Crash recovery with checkpoint persistence
- Cross-platform scheduler (macOS launchd, Linux systemd, Windows Task Scheduler)

### 11 LLM Providers with Formal Registry

Connect any combination of cloud and local models through the priority-based Provider Registry:

**Cloud:** OpenAI, Anthropic, Google Gemini, DeepSeek, Grok (xAI), Mistral, NVIDIA NIM, Groq

**Local:** Ollama, llama.cpp, OpenMythos

Provider management features:
- Priority-based routing with automatic rate-limit fallback
- Hot-swap between providers without restart
- Per-provider usage tracking (tokens, cost) persisted to SQLite
- Task-type classification with intelligent model selection
- Exponential backoff failover with provider chain exhaustion handling

### Context Compression (V2)

Four-block prompt assembly that prevents context rot in long conversations:

1. **Stable prefix** — system prompt + agent definition + skills (byte-stable, cacheable)
2. **Condensed summary** — LLM-summarized older events (≤600 tokens)
3. **Recent events** — last K messages kept verbatim
4. **Current task** — active work description

Triggers automatically at 60% of model context window. Uses the cheapest model for condensation. Achieves ~2x reduction in per-turn API costs with full audit logging.

### Knowledge Graphs

Visualize your codebase as an interactive network. NeuroNest scans your project, extracts functions, classes, imports, and dependencies, then builds a graph with community detection, god node analysis, and surprising connection discovery. Click any node to see its connections, source file, and role in the architecture.

### 6 Messaging Channels

Receive and respond to messages from WhatsApp, Telegram, Discord, Slack, Email, and GitHub. Incoming messages flow through the full AI pipeline (with configurable smart vs full mode) and responses are sent back to the originating platform.

### On-Device Voice Synthesis

ONNX-based text-to-speech via the Supertonic engine. Runs entirely on-device with no cloud API calls. Summarizes agent responses and reads them aloud with natural intonation. Multiple voice styles (5 male, 5 female) with configurable speed.

### Integrated Code Editor

Monaco-powered editor with syntax highlighting, multi-tab support, split views, minimap, breadcrumb navigation, and project file tree. Edit code without leaving the app.

### Runtime Debugger

Detect your project's tech stack, install dependencies, and run services with live log streaming and a browser preview panel. Supports Node.js, Python, Go, Rust, and static HTML.

### Skills System

198 skills with 2,275 agent-skill assignments. Bundled catalog, design templates, custom skills, workspace-specific skills, and skill packs. Skills are auto-assigned to agents by keyword matching and reinforced through usage tracking. Includes a skill learner that extracts new skills from successful executions.

### Brainstorm Mode

When you describe a feature, NeuroNest asks 3–5 clarifying questions before writing any code. Forces design thinking before implementation. Generates a design summary that feeds into the development pipeline.

### Project Learning Memory

Learns patterns, preferences, and pitfalls specific to each project. Conventions are remembered across sessions and injected into future prompts. Knowledge compounds over time and decays gracefully to stay current.

### Crash Recovery & Checkpoints

Session state is auto-saved every 30 seconds. Loop runs persist after each pass. Partial passes are cleaned up on restart. Resume exactly where you left off after any interruption.

---

## Security

NeuroNest implements a 7-layer defense-in-depth security model. Each layer operates independently.

| Layer | Protection |
|-------|-----------|
| Firewall Engine | 4-tier scanning: sanitization, prompt injection detection, secrets scanning, policy enforcement |
| Enhanced Firewall | Hybrid regex + semantic analysis with sophistication assessment and PII redaction |
| Action Security Analyzer | Pre-execution risk classification (LOW/MEDIUM/HIGH) for shell commands and file operations |
| Permission Pattern Engine | Declarative allow/deny patterns enabling zero-prompt unattended operation during loops |
| Runtime Protection | Anti-tamper, anti-debug, file integrity verification (production builds) |
| Secure Communication | HTTPS enforcement, certificate pinning, request signing, replay protection |
| Edit Lock Manager | Directory-scoped file edit restrictions with glob pattern enforcement |

Policy presets: Standard, Strict, Enterprise. Per-agent and per-project policy overrides. Security policies can only be tightened (standard → strict → enterprise), never loosened. Full configuration UI in the dashboard.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                        Renderer (Vanilla JS)                         │
│  Chat UI · Monaco Editor · Knowledge Graphs · Loop Run Panel         │
│  Harness Health Widget · LoopSpec Editor · File Tree                 │
└────────────────────────────────┬─────────────────────────────────────┘
                                 │ IPC Bridge (~400 channels, Zod-validated)
┌────────────────────────────────▼─────────────────────────────────────┐
│                      Main Process (Node.js)                          │
│                                                                      │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────────────┐    │
│  │ Brainstorm  │→ │ ZERA         │→ │ Execution Mode Router     │    │
│  │ Mode        │  │ Optimizer    │  │ (flash/standard/pro/ultra)│    │
│  └─────────────┘  └──────────────┘  └─────────────┬─────────────┘    │
│                                                   │                  │
│  ┌─────────────────────────────────────────────────▼──────────────┐  │
│  │              Orchestrator Planner                              │  │
│  │  Agent scoring · Phase dependency graph · Topology selection   │  │
│  └─────────────────────────────────┬──────────────────────────────┘  │
│                                    │                                 │
│  ┌─────────────────────────────────▼──────────────────────────────┐  │
│  │              Swarm Coordinator                                 │  │
│  │  Parallel phases · Agent handoffs · Consensus detection        │  │
│  │  GCF wire format · Shared memory · Result envelopes            │  │
│  └─────────────────────────────────┬──────────────────────────────┘  │
│                                    │                                 │
│  ┌────────────┐  ┌────────────────▼───────────────┐  ┌───────────┐   │
│  │ Loop       │  │ Agent Loop Controller          │  │ Provider  │   │
│  │ Engine     │  │ Iterative tool-use (LLM→tool→  │  │ Registry  │   │
│  │ (bounded   │  │ result→LLM) with 30+ optional  │  │ Priority  │   │
│  │ iterative) │  │ subsystems (feature-gated)     │  │ routing + │   │
│  └────────────┘  └────────────────────────────────┘  │ failover  │   │
│                                                      └───────────┘   │
│  ┌─────────────────────────────────────────────────────────────-─┐   │
│  │ Harness Layer                                                 │   │
│  │ Permission Patterns · Standing Context · Memory Vault         │   │
│  │ Deterministic Hooks · Verifier Subagent · MCP Scoping         │   │
│  │ GOAL.md/PLAN.md · Progress Hash · Context Budget · Skills     │   │
│  └─────────────────────────────────────────────────────────────-─┘   │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────-┐   │
│  │ Infrastructure                                                │   │
│  │ SQLite (WAL, 42 migrations) · Event Bus · Checkpoint Service  │   │
│  │ Cost Tracking · Feature Gate System · Cron Scheduler          │   │
│  │ Firewall · Action Analyzer · Credential Vault · Graph Manager │   │
│  └─────────────────────────────────────────────────────────────-─┘   │
└──────────────────────────────────────────────────────────────────────┘
```

**Key data flows:**
- User message → Brainstorm (optional) → Firewall scan → ZERA optimization → Mode selection → Orchestrator plan → Swarm execution → Response
- Loop mode: LoopSpec → Runner state machine → Pass execution → Verification → Feedback → Receipt
- Provider resolution: Registry lookup → Priority selection → Rate-limit fallback → Failover chain

**Persistence:** SQLite with 42 migrations covering sessions, messages, skills, agent tasks, cost records, security scans, long-term memory, loop specs, loop runs, loop passes, condensation logs, and more.

---

## Download

| Platform | Download |
|----------|----------|
| macOS | [NeuroNest-LATEST-mac-universal.dmg](https://neuronest.cc/download) |
| Windows | [NeuroNest-Setup-LATEST-win-x64.exe](https://neuronest.cc/download) |
| Linux | [NeuroNest-LATEST-linux-x64.AppImage](https://neuronest.cc/download) |
| Linux | [NeuroNest-LATEST-linux-x64.deb](https://neuronest.cc/download) |
| Linux | [NeuroNest-LATEST-linux-x64.rpm](https://neuronest.cc/download) |
| Linux | [NeuroNest-LATEST-linux-arm64.AppImage](https://neuronest.cc/download) |
| Linux | [NeuroNest-LATEST-linux-arm64.deb](https://neuronest.cc/download) |

**Requirements:** macOS 11.0+, Windows 10+, or Linux (Ubuntu 20.04+ / Fedora 36+).

---

## Getting Started

1. Download the appropriate version for your platform
2. Drag NeuroNest to Applications (macOS), run the installer (Windows), or make the AppImage executable (Linux)
3. Launch and enter your invitation code
4. Add an AI provider in Settings (OpenAI, Anthropic, or any supported provider)
5. Start chatting — the agents take it from there

---

## Plans

| | Community | Professional | Enterprise |
|---|-----------|-------------|-----------|
| Price | Free | $29/month | Contact Sales |
| AI Agents | 118 | 118 | 118 |
| Swarm Orchestration | ✓ | ✓ | ✓ |
| Loop Engine | ✓ | ✓ | ✓ |
| Multi-Model Support | ✓ | ✓ | ✓ |
| Knowledge Graphs | ✓ | ✓ | ✓ |
| All Channels | ✓ | ✓ | ✓ |
| On-Device Voice | ✓ | ✓ | ✓ |
| Cloud Sync | - | ✓ | ✓ |
| Team Collaboration | - | ✓ | ✓ |
| Priority Model Access | - | ✓ | ✓ |
| Advanced Analytics | - | ✓ | ✓ |
| Scheduled Loops | - | ✓ | ✓ |
| Custom Deployment | - | - | ✓ |
| SSO / RBAC | - | - | ✓ |
| Dedicated Support | - | - | ✓ |

---

## Documentation

| Document | Description |
|----------|------------|
| [Architecture](https://neuronest.cc/docs) | System design, pipeline flow, component reference |
| [Security](https://neuronest.cc/security) | 7-layer security model, firewall tiers, threat model |
| [Online Docs](https://neuronest.cc/docs) | Full documentation site |

---

## Tech Stack

- **Runtime:** Electron 43, Node.js 22+
- **Language:** TypeScript (main process), Vanilla JS (renderer)
- **Database:** SQLite via better-sqlite3 (WAL mode, 42 migrations)
- **Editor:** Monaco Editor
- **Graphs:** Cytoscape.js
- **Voice:** ONNX Runtime (Supertonic TTS, on-device)
- **Auth:** WebAuthn / Passkeys (local HTTPS)
- **Payments:** Stripe
- **Native:** C++ addon via Node-API (macOS CommonCrypto)
- **Testing:** Vitest + fast-check (property-based)
- **Validation:** Zod (IPC schemas, LoopSpec, config)

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## Security

See [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## License

NeuroNest is licensed under the [Business Source License 1.1](LICENSE). See [LICENSE.BUSL](LICENSE.BUSL) for the full legal text.

---

<p align="center">
  Built by <a href="https://neuronest.cc">NeuroNest</a> · © 2024-2025 Network Guardian Inc.
</p>
