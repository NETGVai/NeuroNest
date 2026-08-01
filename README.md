<h1 align="center">🧠 NeuroNest</h1>

<p align="center">
  <strong>The AI Coding SuperAgent</strong>
</p>

<p align="center">
  300+ specialized AI agents. 22+ divisions. One desktop app.<br/>
  Ship software faster with swarm intelligence, not just autocomplete.
</p>

<p align="center">
  <a href="https://neuronest.cc">Website</a> &middot;
  <a href="https://neuronest.cc/docs">Documentation</a> &middot;
  <a href="https://neuronest.cc/download">Download</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-000?style=flat-square&logo=electron" alt="Platforms" />
  <img src="https://img.shields.io/badge/version-0.1.670-blue?style=flat-square" alt="Version" />
  <img src="https://img.shields.io/badge/agents-300%2B-purple?style=flat-square" alt="Agents" />
  <img src="https://img.shields.io/badge/divisions-22%2B-orange?style=flat-square" alt="Divisions" />
  <img src="https://img.shields.io/badge/providers-11-green?style=flat-square" alt="Providers" />
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-BUSL--1.1-yellow?style=flat-square" alt="License: BUSL-1.1" /></a>
</p>

---

## What is NeuroNest?

NeuroNest is a desktop AI development environment that goes beyond code completion. Instead of a single copilot, you get an entire engineering organization — 300+ specialist agents across 22+ divisions — that collaborates through swarm orchestration to tackle complex software tasks.

Ask it to build a feature. It plans the architecture, assigns specialists, selects the optimal execution mode, runs agents in parallel, verifies results with an adversarial reviewer, and delivers tested code with an immutable receipt.

---

## Key Features

### 300+ Specialized AI Agents

A full engineering team across 22+ divisions: Engineering, Design, Marketing, Product, Project Management, Testing, Support, Specialized, Consensus, Infrastructure, Optimization, Research, Software Delivery, NeuroNest Orchestration, Sales, Paid Media, Spatial Computing, Finance, Game Development, Academic, GIS, Healthcare, Security, DevOps, and Data Science. Each agent has focused expertise, domain-specific system prompts, and scoped tool permissions.

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

Bounded, verification-gated iterative execution that makes NeuroNest dramatically more efficient at building and repairing projects. Define a goal, verification checks, and stop conditions — NeuroNest loops autonomously until all checks pass or limits are hit.

**How it works:**

```
  Goal: "Fix all TypeScript errors"
  ┌──────────────────────────────────────────────────────┐
  │ Pass 1: Agent fixes 12 errors → tsc reports 5 remain │
  │ Pass 2: Agent fixes 4 errors  → tsc reports 1 remain │
  │ Pass 3: Agent fixes last error → tsc exits 0 ✓       │
  └──────────────────────────────────────────────────────┘
  Result: SUCCEEDED (3 passes, $0.42, 2m 18s)
```

**Built-in loops** (ready to use with zero configuration):

| Loop | Verification | Goal |
|------|-------------|------|
| **Type-clean** | `tsc --noEmit` exits 0 | Fix all TypeScript type errors |
| **Test-repair** | `vitest --run` exits 0 | Fix all failing tests without breaking passing ones |
| **Docs-current** | `npm run docs:check` exits 0 | Fix documentation link rot and format issues |

**Custom loops** — define your own with any shell command as verification:
```json
{
  "goal": "Achieve 90% test coverage",
  "verify": [{ "type": "command", "command": "npx vitest --coverage --threshold 90", "expectedExitCode": 0 }],
  "stop": { "maxPasses": 10, "maxCostUsd": 3.0, "maxWallClockMin": 20 }
}
```

**Core features:**

- **11-state deterministic state machine** — IDLE → PLANNING_PASS → EXECUTING_PASS → VERIFYING → APPLYING_FEEDBACK → terminal states (SUCCEEDED / STALLED / BLOCKED / LIMIT_EXHAUSTED / NO_OP / AWAITING_APPROVAL). Guaranteed termination via max passes, cost budget, and wall-clock timeout.
- **Adversarial verifier subagent** — Fresh-context reviewer dispatched after each pass that detects 11 fake-done shortcut patterns: test deletion, `@ts-ignore` insertion, assertion weakening, `skip()` annotations, commenting out code, reducing coverage thresholds, removing lint rules, empty catch blocks, and more.
- **Immutable receipts** — Every run produces a tamper-evident receipt (JSON + Markdown export) recording each pass's actions, verification results, cost, file changes, and progress hashes. Fully auditable and reproducible.
- **Crash recovery** — Checkpointed after every completed pass. Kill the app mid-loop, restart, and resume from the last completed pass within seconds.
- **Stall detection** — Progress hashes computed per pass detect when the agent is looping without making meaningful changes. Transitions to STALLED after N identical hashes.
- **Approval boundaries** — Configure pass numbers where the loop pauses for human review (e.g., pause at pass 5 before proceeding to more expensive operations).

**Harness layer** (infrastructure that makes loops reliable):

- **Permission Pattern Engine** — Declarative allow/deny rules enabling zero-prompt unattended operation
- **Context Budget** — Per-pass token budget enforcement with truncation ordering (memory first, then PLAN.md)
- **Memory Vault** — Persistent cross-pass context with LRU eviction
- **Progress Hash** — Deterministic content hash per pass for stall detection
- **Hook Engine** — Pre/post tool-use hooks for instrumentation and safety gates
- **MCP Scoping** — Workspace-scoped MCP server configuration per loop
- **Skill Loading** — Auto-assign relevant skills to the loop agent based on goal
- **Goal/Plan Manager** — GOAL.md + PLAN.md generation and maintenance across passes

**Stop conditions** (any hit terminates the loop gracefully):

| Condition | Default | Purpose |
|-----------|---------|---------|
| Max passes | 10 | Hard ceiling prevents runaway loops |
| Max cost | $2.00 | Budget protection |
| Max wall-clock | 15 min | Time bound |
| No-progress passes | 3 | Detect stalls (identical progress hashes) |
| Approval boundaries | none | Human checkpoints at specified passes |

**Security enforcement:**

- All loop passes run through the full 13-layer security stack
- Scope constraints restrict allowed file paths and tools per loop
- Security policy per loop (standard/strict/enterprise)
- Cost tracking per pass with cumulative budget enforcement

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

133 bundled skills with dynamic auto-assignment to all 300+ agents. Bundled catalog, design templates, custom skills, workspace-specific skills, and skill packs. Skills are auto-assigned at startup based on keyword matching between skill tags and agent department/specialty, and reinforced through usage tracking. Includes a skill learner that extracts new skills from successful executions.

### Brainstorm Mode

When you describe a feature, NeuroNest asks 3–5 clarifying questions before writing any code. Forces design thinking before implementation. Generates a design summary that feeds into the development pipeline.

### Project Learning Memory

Learns patterns, preferences, and pitfalls specific to each project. Conventions are remembered across sessions and injected into future prompts. Knowledge compounds over time and decays gracefully to stay current.

### Crash Recovery & Checkpoints

Session state is auto-saved every 30 seconds. Loop runs persist after each pass. Partial passes are cleaned up on restart. Resume exactly where you left off after any interruption.

### Agent Catalog

NeuroNest's agent catalog aggregates 300+ specialized agents from multiple sources, including the agency-agents repository (230+ external agents) merged with the original 118 NeuroNest agents. Duplicate detection and quality-based resolution ensures only the best version of each specialist survives.

| Division | Agents | Specialty |
|----------|--------|-----------|
| Engineering | 16+ | Frontend, backend, fullstack, mobile, systems, ML, DevEx |
| Design | 8+ | UI/UX, visual design, design systems, prototyping |
| Marketing | 8+ | Content, SEO, social media, brand strategy, copywriting |
| Product | 6+ | Product management, strategy, analytics, roadmapping |
| Project Management | 6+ | Agile, scrum, resource planning, delivery coordination |
| Testing | 8+ | QA, test automation, performance, security testing |
| Support | 6+ | Customer success, technical support, documentation |
| Infrastructure | 10+ | Cloud, networking, monitoring, capacity planning |
| Security | 10+ | AppSec, cloud security, compliance, incident response |
| DevOps | 10+ | CI/CD, container orchestration, IaC, SRE |
| Research | 6+ | AI/ML research, data analysis, literature review |
| Sales | 8+ | Sales engineering, pipeline management, demo preparation |
| Finance | 6+ | Financial analysis, budgeting, forecasting, compliance |
| Healthcare | 6+ | Health informatics, clinical workflows, HIPAA compliance |
| Game Development | 8+ | Game design, engine programming, asset pipelines |
| Academic | 6+ | Research methodology, paper writing, peer review |
| GIS | 4+ | Geospatial analysis, mapping, spatial data engineering |
| Spatial Computing | 4+ | AR/VR development, 3D rendering, spatial UX |
| Paid Media | 6+ | PPC, programmatic advertising, media buying |
| Data Science | 8+ | Statistics, ML modeling, data engineering, visualization |
| Software Delivery | 8+ | Release management, deployment, observability |
| Optimization | 4+ | Performance tuning, cost optimization, efficiency |

**Catalog features:**
- Quality-based duplicate resolution (4-dimension scoring: prompt specificity, deliverable structure, workflow completeness, domain depth)
- Version snapshots with one-click rollback (last 10 versions retained)
- Automatic tool permission assignment based on division profiles
- Backward-compatible — all original agents preserved with rollback capability

### DevOps Safety

The DevOps Safety Layer provides hardened infrastructure operation capabilities for agent-driven DevOps tasks. Inspired by production-grade safety patterns, it ensures agents cannot accidentally (or maliciously) harm your infrastructure.

**Argv-Only Execution:**
```
✓ Commands executed as argv arrays (shell=false)
✗ Shell metacharacters blocked: | ; && || ` $() > < &
✗ Interpreter invocations blocked: bash, sh, zsh, cmd, powershell, python -c, node -e
✓ Secrets resolved via {{secret:NAME}} patterns → environment variables
✓ Output scrubbed of API keys, JWTs, and high-entropy tokens
```

**Fail-Closed Policy Engine:**
- Default-deny for all unrecognized tools, unlisted targets, and unmapped agents
- Rule precedence: explicit deny → capability grant override → environment rules → base rules
- Internal errors always result in denial (never fail-open)
- Every decision logged to the tamper-evident audit chain

**Capability Grant System:**
- Time-limited, scope-bound permissions for dangerous operations
- Proposer/approver separation enforced (same identity cannot propose and approve)
- Automatic revocation on lifetime expiry or execution count exhaustion
- Mandatory dry-run option for destructive operations

**Budget Controls:**
- Per-run USD cost limits with automatic termination on breach
- Daily stop-loss threshold rejecting new runs until next UTC day
- Real-time cost accumulation with per-model pricing tables
- All terminations recorded in the audit chain

**Audit Chain:**
- SHA-256-linked event sequence (tamper-evident hash chain)
- Every tool invocation recorded: timestamp, agent, tool, args (redacted), result, duration, cost
- Structural integrity verification with broken-link detection
- Secrets and high-entropy tokens automatically redacted before storage

### Security Postures

Configure the enforcement level for agent operations based on your risk tolerance. Security postures are configurable at workspace and project level, with project settings able to only tighten (never loosen) workspace settings.

| Posture | Behavior | Best For |
|---------|----------|----------|
| **Strict** | All tool calls require explicit human approval before execution | Production environments, sensitive operations |
| **Auto** | Risk classifier screens operations; only escalates high-risk calls above threshold | Day-to-day development with safety guardrails |
| **Autonomous** | No approval pauses except for policy engine denials | Trusted environments, batch processing |

**Key behaviors:**
- Posture changes apply immediately to all subsequent tool calls (no restart required)
- Project-level posture can only be equal to or stricter than workspace level
- Strictness ordering: strict > auto > autonomous
- Auto mode uses a configurable risk threshold (0-1) for the escalation classifier

### Background Workers

Schedule agent tasks to run automatically without manual invocation. Background workers handle routine operations like CI monitoring, drift detection, log summarization, and recurring maintenance.

**Cron Scheduling:**
```json
{
  "agentId": "infrastructure-monitor",
  "trigger": { "type": "cron", "expression": "0 */6 * * *" },
  "name": "Infrastructure drift check every 6 hours"
}
```

**File-Watch Triggers:**
```json
{
  "agentId": "test-runner",
  "trigger": { "type": "watch", "patterns": ["src/**/*.ts"], "debounceMs": 1000 },
  "name": "Run tests on source file changes"
}
```

**Safety guarantees:**
- All background tasks respect the active Security Posture
- Budget Manager limits enforced during background execution
- Single-instance guarantee prevents concurrent execution of the same task
- Failed tasks retry with exponential backoff (max 3 retries)
- All failures recorded in the Audit Chain
- Task status API exposes last run, next run, and current state

### Operations Dashboard

A unified real-time monitoring view for governing agent behavior across all subsystems.

| Panel | Displays |
|-------|----------|
| **Active Runs** | Agent identity, status, elapsed time, accumulated cost |
| **Approval Queue** | Pending capability grants with requesting agent, target, time remaining |
| **Cost Chart** | Per-model spend progression with daily stop-loss threshold line |
| **Policy Log** | Recent allow/deny/escalate decisions with matched rule and correlation ID |

**Capabilities:**
- Approve or deny pending capability grants directly from the dashboard (processed within 2 seconds)
- Real-time updates within 3 seconds of any state change (new run, cost update, approval resolution)
- Push-based event subscription for live data streaming
- Correlation IDs link policy decisions to their originating agent runs

### Knowledge Base & Training Pipeline

NeuroNest includes an optional knowledge base system with a multi-phase training pipeline for fine-tuning models on project-specific data.

| Phase | Component | Description |
|-------|-----------|-------------|
| 1 | KB System | Document ingestion, chunking, embedding, and semantic retrieval |
| 2 | Unsloth Bridge | Efficient fine-tuning adapter connecting to the Unsloth framework |
| 3 | Training Pipeline | Full training orchestration with dataset preparation and checkpointing |
| 4 | Advanced Training | Multi-stage training with curriculum learning and evaluation |
| 5 | Enterprise Training | GGUF export, quantization, and enterprise deployment packaging |

**Features:**
- Semantic retrieval integrated into the GCF prompt enrichment pipeline
- Reciprocal Rank Fusion merges KB results with code search results
- Feature-gated phases (each phase independently toggleable)
- Phase dependency enforcement (Phase 3 requires Phase 2, etc.)
- Zero overhead when disabled — no-op implementation with no runtime cost

---

## Advanced Features

The following capabilities extend NeuroNest beyond core orchestration. Each is independently feature-gated and can be enabled in Settings.

### Code Intelligence

- **Inline Autocomplete** — Ghost-text suggestions via Fill-in-the-Middle (FIM) inference. Tab to accept, Escape to dismiss. Uses the fastest/cheapest model tier. Contextual skip logic suppresses suggestions inside strings and imports.
- **Semantic Code Search** — AST-based tree-sitter chunking + vector embeddings (LanceDB). Natural language queries find relevant code by meaning, not just filenames. Incremental re-indexing on file save.
- **LSP Integration** — Language Server Protocol tools (`lsp_diagnostics`, `lsp_references`, `lsp_definition`, `lsp_symbols`) giving agents compiler-grade intelligence.

### Input & Context

- **Context @-Mentions** — Reference `@file:`, `@folder:`, `@url:`, `@git-diff`, `@problems`, `@terminal`, or `@selection` in chat. Autocomplete suggestions appear as you type. Resolved content is injected into agent context with token budgets.
- **Speech-to-Text** — Microphone capture with local Whisper ONNX or cloud transcription (OpenAI/Google). Push-to-talk and continuous dictation modes. Completes the voice loop with existing TTS output.
- **Prompt Enhancement** — Short/vague prompts are automatically rewritten into detailed specs before execution. Show-and-confirm UI. Preserves intent while adding specificity.

### Git & Workflow

- **Smart Commit Messages** — LLM-generated conventional commits (`type(scope): description`) from staged changes. Detects feat/fix/refactor/docs/test/chore automatically.
- **Git Worktree Isolation** — Each agent task in Ultra mode runs in its own worktree. No conflicts between parallel agents. Merge, create PR, or discard when done.
- **Diff Viewer with Turn-Level Revert** — See exactly what changed per agent turn. Revert a single file or an entire turn without affecting subsequent changes. Three-way merge logic for safety.
- **Checkpoint Visual Timeline** — Horizontal scrollable timeline of auto-created checkpoints. One-click restore. Star important checkpoints to prevent pruning.

### Review & Security

- **Automated Code Review Pipeline** — Multi-agent review (security, performance, style) running in parallel. Produces scored findings with inline comments. Optional GitHub PR posting.
- **Network Sandbox** — Intercepts all outbound HTTP/HTTPS from agent tools. 3 policy presets (permissive, standard, strict). Per-project overrides via `.neuronest/network-policy.json`.
- **Cost Controls** — Per-session budget enforcement with real-time ticker. Warning at 80%, automatic model downgrade at 90%, abort at 100%. Subagent costs propagate to parent.

### Runtime & Processes

- **Background Process Manager** — Start named processes (dev servers, watchers) that survive chat turns. Port conflict detection, auto-stop on exit, last-1000-line log capture.
- **Interactive Terminal** — PTY-based agent terminal with full ANSI emulation. Agents observe output and respond to prompts. Credential injection via vault (never types passwords directly).
- **Subagent Task Spawning** — Any agent can dynamically spawn focused subagents for decomposed work. Permission inheritance, 3-level nesting limit, scoped context.

### Ecosystem & Extensibility

- **Plugin System** — Third-party extensions via `neuronest-plugin.json` manifests. Register agents, providers, tools, panels, or commands. Sandboxed execution with firewall-gated inputs.
- **MCP Marketplace** — Browse, search, and one-click install MCP servers. Auto-detects relevant MCPs from your project's tech stack. Daily catalog sync from registry.
- **Notebook Integration** — Jupyter-compatible `.ipynb` notebooks with kernel management (Python, JavaScript, R). Create, edit, and execute cells. Inline output display.
- **Session Export & Import** — Export sessions as compressed JSON archives with sensitive data scrubbing (API keys, tokens, credentials). Import and optionally replay in new context. Shareable links with expiration.

### Platform & Enterprise

- **Headless CLI** — `neuronest run "<task>"` for CI/CD pipelines. Flags: `--auto`, `--mode`, `--json`, `--max-cost`, `--provider`, `--model`. Structured JSON event output. Published as `@neuronest/cli`.
- **Cloud Agent** — Always-on remote agent deployed via Docker. REST API, webhook triggers (HMAC-verified), cron schedules, Slack/Discord/GitHub integrations. Multi-tenant isolation.
- **Adoption Dashboard** — Team analytics: active users, sessions/day, tasks completed, estimated time saved, cost per task, per-agent effectiveness. CSV/JSON export. Configurable retention.
- **Internationalization (i18n)** — Full locale management with ICU MessageFormat. 9 languages shipped (English, Chinese, Japanese, Korean, German, Spanish, French, Portuguese-BR, Russian). Runtime switching without restart.

### Global Context Framework (GCF)

A comprehensive context management system that enriches agent prompts with project knowledge. GCF operates transparently between user input and LLM calls, ensuring agents always have relevant context without manual @-mentions.

**Components:**

| Component | Role |
|-----------|------|
| AST Analyzer | Parses source files into typed syntax trees for structural understanding |
| Semantic Search Index | Vector embeddings over code chunks for meaning-based retrieval |
| Incremental Context Engine | Tracks file changes and updates context incrementally (no full re-index) |
| Edit History Tracker | Records recent edits to bias context toward active working areas |
| Prompt Enrichment Pipeline | Assembles relevant context snippets into agent prompts before LLM calls |
| Response Validator | Validates LLM responses against project structure and known symbols |
| Context Window Optimizer | Packs maximum relevant context within model token limits |

**Agent Integration:**
- Automatically enriches prompts before every LLM call with relevant code, types, and project conventions
- Validates responses after LLM calls — flags hallucinated imports, non-existent files, and type mismatches
- Graceful degradation with double-fault protection — if GCF fails, the pipeline continues normally without enrichment
- Drift detection monitors for context drift between concurrent agents and reconciles shared state

### Event Log

Append-only event log providing a unified source of truth for agent state.

- **Schema-validated payloads** — All events pass Zod schema validation before persistence
- **Per-source rate limiting** — Sliding-window rate limiter (100 events/second default) prevents runaway emitters
- **Feature-gated rollout** — Shadow mode validates event integrity without affecting existing state management
- **Replay-friendly** — Ordered, immutable entries support full session reconstruction for debugging

---

## Security

NeuroNest implements a 13-layer defense-in-depth security model. Each layer operates independently.

| Layer | Protection |
|-------|-----------|
| Firewall Engine | 4-tier scanning: sanitization, prompt injection detection, secrets scanning, policy enforcement |
| Enhanced Firewall | Hybrid regex + semantic analysis with sophistication assessment and PII redaction |
| Action Security Analyzer | Pre-execution risk classification (LOW/MEDIUM/HIGH) for shell commands and file operations |
| Permission Pattern Engine | Declarative allow/deny patterns enabling zero-prompt unattended operation during loops |
| Runtime Protection | Anti-tamper, anti-debug, file integrity verification (production builds) |
| Secure Communication | HTTPS enforcement, certificate pinning, request signing, replay protection |
| Edit Lock Manager | Directory-scoped file edit restrictions with glob pattern enforcement |
| Network Sandbox | Policy-based network access control — domain/IP/port allow/deny rules with 3 presets (permissive, standard, strict) |
| Path Traversal Guard | Validates all file paths against project root, blocks symlink escapes and `..` traversal |
| Shell Injection Prevention | All subprocess execution uses `execFile` with argument arrays (no shell interpretation) |
| Dynamic Import Validation | Module imports restricted to an allowlist of permitted packages |
| SQL Injection Prevention | Table name allowlist + parameterized queries for all database access |
| CSP Nonce-Based Script Control | Per-session cryptographic nonces replace `unsafe-inline` in Content-Security-Policy |

Policy presets: Standard, Strict, Enterprise. Per-agent and per-project policy overrides. Security policies can only be tightened (standard → strict → enterprise), never loosened. Full configuration UI in the dashboard.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                        Renderer (Vanilla JS)                         │
│  Chat UI · Monaco Editor · Knowledge Graphs · Loop Run Panel         │
│  Harness Health Widget · LoopSpec Editor · File Tree                 │
└────────────────────────────────┬─────────────────────────────────────┘
                                 │ IPC Bridge (~200+ channels, type-safe handlers)
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
│  ┌─────────────────────────────────────────────────────────────-─┐   │
│  │ Global Context Framework (GCF)                                │   │
│  │ AST Analyzer · Semantic Search · Incremental Engine           │   │
│  │ Prompt Enrichment · Response Validator · Edit History         │   │
│  │ Context Window Optimizer · Drift Reconciler                   │   │
│  └─────────────────────────────────────────────────────────────-─┘   │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────-┐   │
│  │ Infrastructure                                                │   │
│  │ SQLite (WAL, 58 migrations) · Event Bus · Checkpoint Service  │   │
│  │ Cost Tracking · Feature Gate System · Cron Scheduler          │   │
│  │ Firewall · Action Analyzer · Credential Vault · Graph Manager │   │
│  │ PathGuard · SafeExec · Import Validator                       │   │
│  └─────────────────────────────────────────────────────────────-─┘   │
└──────────────────────────────────────────────────────────────────────┘
```

**Key data flows:**
- User message → Brainstorm (optional) → Firewall scan → ZERA optimization → Mode selection → Orchestrator plan → Swarm execution → Response
- Loop mode: LoopSpec → Runner state machine → Pass execution → Verification → Feedback → Receipt
- Provider resolution: Registry lookup → Priority selection → Rate-limit fallback → Failover chain
- GCF enrichment: User message → GCF Prompt Enrichment → Enriched context → LLM → GCF Response Validation → User

**Persistence:** SQLite with 58 migrations covering sessions, messages, skills, agent tasks, cost records, security scans, long-term memory, loop specs, loop runs, loop passes, condensation logs, semantic indexes, worktree sessions, code reviews, network policies, session exports, adoption metrics, and more.

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
| AI Agents | 300+ | 300+ | 300+ |
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
| [Security](https://neuronest.cc/security) | 13-layer security model, firewall tiers, threat model |
| [Online Docs](https://neuronest.cc/docs) | Full documentation site |

---

## Tech Stack

- **Runtime:** Electron 43, Node.js 22+
- **Language:** TypeScript (main process), Vanilla JS (renderer)
- **Database:** SQLite via better-sqlite3 (WAL mode, 58 migrations)
- **Editor:** Monaco Editor
- **Graphs:** Cytoscape.js
- **Voice:** ONNX Runtime (Supertonic TTS + Whisper STT, on-device)
- **Auth:** WebAuthn / Passkeys (local HTTPS)
- **Payments:** Stripe
- **Native:** C++ addon via Node-API (macOS CommonCrypto)
- **Testing:** Vitest + fast-check (property-based)
- **Validation:** Zod (IPC schemas, LoopSpec, config)
- **Embeddings:** LanceDB (vector search for semantic code indexing)
- **Terminal:** node-pty (interactive PTY for agent terminal sessions)
- **Security:** PathGuard, SafeExec, Import Validator, SQL Allowlist, CSP Nonce
- **Context:** Global Context Framework (AST analysis, semantic search, prompt enrichment)
- **i18n:** ICU MessageFormat (20+ locales)

---

## Configuration

All performance and feature flags are controllable via environment variables:

- **Naming convention:** `NEURONEST_<FLAG_NAME>=true|false` (e.g., `NEURONEST_ASYNC_COMMANDS=false`)
- **35+ independently toggleable feature flags** for safe incremental rollout
- **`.env` file support** for local development (auto-loaded at startup)

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## Security

See [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## License

NeuroNest is licensed under the [Business Source License 1.1](LICENSE). See [LICENSE.BUSL](LICENSE.BUSL) for the full legal text.

---

<p align="center">
  Built by <a href="https://neuronest.cc">NeuroNest</a> · © 2024-2026 Network Guardian Inc.
</p>
