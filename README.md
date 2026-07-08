<h1 align="center">🧠 NeuroNest</h1>

<p align="center">
  <strong>The AI Coding SuperAgent</strong>
</p>

<p align="center">
  117 specialized AI agents. 13 departments. One desktop app.<br/>
  Ship software faster with swarm intelligence, not just autocomplete.
</p>

<p align="center">
  <a href="https://neuronest.cc">Website</a> &middot;
  <a href="https://neuronest.cc/docs">Documentation</a> &middot;
  <a href="https://neuronest.cc/download">Download</a> &middot;
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-000?style=flat-square&logo=electron" alt="Platforms" />
  <img src="https://img.shields.io/badge/version-0.1.1-blue?style=flat-square" alt="Version" />
  <img src="https://img.shields.io/badge/agents-117-purple?style=flat-square" alt="Agents" />
  <img src="https://img.shields.io/badge/providers-11-green?style=flat-square" alt="Providers" />
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-BUSL--1.1-yellow?style=flat-square" alt="License: BUSL-1.1" /></a>

</p>

---

## What is NeuroNest?

NeuroNest is a desktop AI development environment that goes beyond code completion. Instead of a single copilot, you get an entire engineering organization that collaborates through swarm orchestration to tackle complex software tasks.

Ask it to build a feature. It plans the architecture, assigns specialists, executes in parallel, reviews the output, and delivers tested results.

---

## Key Features

### 117 Specialized AI Agents

Not one generic assistant. A full engineering team across 13 departments: Engineering, Security, Data, DevOps, Design, QA, Product, Research, Mobile, AI/ML, Infrastructure, Blockchain, and a central Orchestrator. Each agent has focused expertise, domain-specific prompts, and scoped tool permissions.

### Swarm Orchestration

Describe a task. NeuroNest decomposes it into subtasks, assigns the right specialists, executes agents in parallel phases, merges outputs through consensus, and delivers a unified result. Shared memory lets agents build on each other's work.

### 11 LLM Providers

Connect any combination of cloud and local models:

**Cloud:** OpenAI, Anthropic, Google Gemini, DeepSeek, Grok (xAI), Mistral, NVIDIA NIM, Groq

**Local:** Ollama, llama.cpp, OpenMythos

Switch providers per agent. Get a second opinion by querying two models on the same prompt and comparing results.

### Knowledge Graphs

Visualize your codebase as an interactive network. NeuroNest scans your project, extracts functions, classes, imports, and dependencies, then builds a graph with community detection, god node analysis, and surprising connection discovery. Click any node to see its connections, source file, and role in the architecture.

### 6 Messaging Channels

NeuroNest receives and responds to messages from WhatsApp, Telegram, Discord, Slack, Email, and GitHub. Incoming messages flow through the AI pipeline and responses are sent back to the originating platform. Your agents are reachable everywhere.

### Integrated Code Editor

Monaco-powered editor with syntax highlighting, multi-tab support, split views, minimap, breadcrumb navigation, and project file tree. Edit code without leaving the app.

### Runtime Debugger

Detect your project's tech stack, install dependencies, and run services with live log streaming and a browser preview panel. Supports Node.js, Python, Go, Rust, and static HTML.

### Docker Sandbox

Optional secure execution environment with read-only filesystem, memory limits, CPU constraints, and network isolation. Run untrusted code safely in Docker containers.

### Project Learning Memory

NeuroNest learns patterns, preferences, and pitfalls specific to each project. Conventions like "this project uses Zod for validation" or "tests go in tests/ not \_\_tests\_\_/" are remembered across sessions and injected into future prompts. Knowledge compounds over time and decays gracefully to stay current.

### Brainstorm Mode

When you describe a feature, NeuroNest asks 3-5 clarifying questions before writing any code. Forces design thinking before implementation. Generates a design summary from the Q&A that feeds into the development pipeline.

### Crash Recovery

Session state is auto-saved every 30 seconds: decisions made, remaining work, failed approaches, active agents. If the app crashes or you restart, you can resume exactly where you left off.

### Skills System

198 skills with 2,275 agent-skill assignments. Bundled catalog, design templates, custom skills, and workspace-specific skills. Skills are auto-assigned to agents by keyword matching and reinforced through usage tracking.

---

## Security

NeuroNest implements a 7-layer defense-in-depth security model. Each layer operates independently.

| Layer | Protection |
|-------|-----------|
| Firewall Engine | 4-tier scanning: sanitization, prompt injection detection, secrets scanning, policy enforcement |
| Enhanced Firewall | Hybrid regex + semantic analysis with sophistication assessment and PII redaction |
| Action Analyzer | Pre-execution risk classification for shell commands and file operations |
| Runtime Protection | Anti-tamper, anti-debug, file integrity verification (production builds) |
| Secure Communication | HTTPS enforcement, certificate pinning, request signing, replay protection |
| Native Module | Compiled C++ addon for cryptographic operations |
| Edit Lock | Directory-scoped file edit restrictions during debugging |

Policy presets: Permissive, Balanced, Strict, Enterprise. Per-agent and per-project policy overrides. Full configuration UI in the dashboard.

See [Security Architecture](https://neuronest.cc/security) for details.

---

## Architecture

NeuroNest is built on Electron with a clean separation between the main process (Node.js backend) and renderer process (vanilla JS frontend). Communication flows through a typed IPC bridge with ~200 allowlisted channels.

The AI pipeline processes messages through: Brainstorm Mode, Firewall, ZERA Optimizer, Orchestrator Planner, Execution Mode Router, Swarm Coordinator, LLM Client, Action Security Analyzer, and Event Stream.

Data is persisted in SQLite (WAL mode) with 10 migration files covering sessions, messages, skills, agent tasks, cost records, security scans, long-term memory, and more.

See [Architecture Reference](https://neuronest.cc/docs) for the full system design.

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

1. Download the appropriate version for your architecture
2. Drag NeuroNest to Applications (macOS), run the installer (Windows), or make the AppImage executable (Linux)
3. Launch and enter your invitation code
4. Add an AI provider in Settings (OpenAI, Anthropic, or any supported provider)
5. Start chatting — the agents take it from there

---

## Plans

| | Community | Professional | Enterprise |
|---|-----------|-------------|-----------|
| Price | Free | $29/month | Contact Sales |
| AI Agents | 117 | 117 | 117 |
| Swarm Orchestration | Yes | Yes | Yes |
| Multi-Model Support | Yes | Yes | Yes |
| Knowledge Graphs | Yes | Yes | Yes |
| All Channels | Yes | Yes | Yes |
| Cloud Sync | - | Yes | Yes |
| Team Collaboration | - | Yes | Yes |
| Priority Model Access | - | Yes | Yes |
| Advanced Analytics | - | Yes | Yes |
| Custom Deployment | - | - | Yes |
| SSO / RBAC | - | - | Yes |
| Dedicated Support | - | - | Yes |

---

## Documentation

| Document | Description |
|----------|------------|
| [Architecture](https://neuronest.cc/docs) | System design, pipeline flow, component reference |
| [Security](https://neuronest.cc/security) | 7-layer security model, firewall tiers, threat model |
| [Online Docs](https://neuronest.cc/docs) | Full documentation site |

---

## Tech Stack

- **Runtime:** Electron 33, Node.js 20+
- **Language:** TypeScript (main process), Vanilla JS (renderer)
- **Database:** SQLite via better-sqlite3 (WAL mode)
- **Editor:** Monaco Editor
- **Graphs:** Cytoscape.js
- **Auth:** WebAuthn / Passkeys (local HTTPS)
- **Payments:** Stripe
- **Native:** C++ addon via Node-API (macOS CommonCrypto)
- **Testing:** Vitest + fast-check (property-based)

---
[![License: BUSL-1.1](https://img.shields.io/badge/License-BUSL--1.1-blue.svg)](LICENSE)

<p align="center">
  Built by <a href="https://neuronest.cc">NeuroNest</a>
</p>