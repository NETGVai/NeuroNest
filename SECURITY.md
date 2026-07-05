# Security Policy

NeuroNest is an agent-first IDE: it runs autonomous AI agents that read, write, and execute code on your machine. We treat the security of that boundary as a first-class engineering concern, and we welcome good-faith security research.

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |
| < 0.1.0 | :x:                |

Only the latest minor release receives security patches. Always run the most recent version — the auto-updater delivers signed builds.

## Reporting a Vulnerability

**Do NOT open a public GitHub issue, discussion, or pull request for security vulnerabilities.**

### How to Report

Report privately through either channel:

1. **Preferred:** [GitHub Private Vulnerability Reporting](https://github.com/NETGVai/NeuroNest/security/advisories/new) — this keeps the report, discussion, and any CVE assignment in one place.
2. **Email:** security@neuronest.cc

Please include:

- A description of the vulnerability and the affected component (main process, renderer, preload/IPC, native module, CLI, agent pipeline, sandbox, etc.)
- Steps to reproduce, ideally with a minimal proof of concept
- The NeuroNest version, macOS version, and configuration (security policy preset, sandbox on/off, providers in use) where you reproduced it
- Your assessment of impact
- A suggested fix, if you have one

### What to Expect

- **Acknowledgment** within 48 hours.
- **Triage and severity assessment** within 7 days, including whether we accept the report and a target remediation window.
- **Remediation targets** (from triage, not guarantees — complex fixes may take longer, and we will keep you updated):

| Severity | Target remediation | Examples |
| -------- | ------------------ | -------- |
| Critical | 14 days | Remote code execution outside intended agent execution paths, credential/API-key exfiltration, security firewall bypass enabling unauthorized destructive actions |
| High | 30 days | Docker sandbox escape, IPC allowlist bypass granting renderer privileged access, encryption-at-rest weaknesses in key storage |
| Medium | 60 days | Information disclosure, CSP bypass, privilege escalation within the app |
| Low | 90 days | Minor leaks, hardening gaps, non-exploitable weaknesses |

- **Coordinated disclosure:** We ask that you give us up to 90 days before public disclosure. We will coordinate timing with you and will not consider a report "resolved" without your input.
- **Credit:** With your permission, we credit reporters in release notes and the advisory. Anonymity is respected on request.
- **Bounty:** We do not currently run a paid bug bounty program.

### Safe Harbor

We will not pursue legal action against researchers who: act in good faith, avoid privacy violations and data destruction, do not access data beyond what is needed to demonstrate the issue, test only against their own installations, and report through the channels above. Good-faith research conducted under this policy is considered authorized.

## Threat Model & Security Architecture

NeuroNest's security posture spans three distinct boundaries. Understanding them helps scope reports correctly.

### 1. The AI/agent boundary

Autonomous agents process untrusted input (repository contents, web results, messages from connected channels) and can execute actions on the host. Defenses include:

- **Prompt firewall:** inbound prompts and agent context are screened for injection patterns and secrets before reaching model providers.
- **Action security analysis:** agent-proposed actions (file writes, shell commands, network calls) are evaluated against the active security policy before execution.
- **Security policy presets:** user-selectable policies constrain what agents may do without explicit approval.
- **Docker sandbox (optional):** agent code execution can be isolated in containers rather than run on the host.

**Reportable:** bypassing the firewall or action analyzer to make agents perform destructive/exfiltrating actions the active policy should have blocked; injection payloads that escalate agent privileges; sandbox escapes.
**Not reportable:** an LLM producing incorrect, low-quality, or undesirable output within the permissions the user granted it — that is model behavior, not a security boundary failure.

### 2. The Electron process boundary

- **Process isolation:** renderer processes run with context isolation enabled and Node integration disabled; all privileged operations flow through a typed preload bridge with an explicit channel allowlist.
- **IPC validation:** messages crossing the bridge are restricted to registered channels and validated before dispatch.
- **Content Security Policy:** enforced via session response headers.
- **Navigation control:** external navigation and window creation from renderer content are blocked.

**Reportable:** renderer-to-main privilege escalation, allowlist bypass, obtaining Node.js primitives from renderer context, CSP or navigation-control bypasses with security impact.

### 3. Secrets and data at rest

- **API keys and channel tokens** (LLM providers, WhatsApp/Telegram/Discord/Slack/email/GitHub integrations) are encrypted at rest using Electron `safeStorage`, backed by the macOS Keychain.
- **Native cryptography:** the bundled native module uses Apple CommonCrypto (AES-256) rather than JavaScript crypto implementations.
- **Local-first data:** project memory, knowledge graphs, and session data live in a local SQLite database; NeuroNest does not proxy your code through NeuroNest-operated servers. Code and context are sent only to the LLM providers you configure.

**Reportable:** plaintext credential persistence, key material recoverable without OS-level user authentication, weaknesses in the native crypto module, unintended data transmission to any party other than user-configured providers.

### Supply chain & release integrity

- Release binaries are code-signed and notarized for macOS.
- Dependencies are version-pinned and monitored for known vulnerabilities.
- Updates are delivered through the signed release channel.

**Reportable:** update-mechanism weaknesses (downgrade, unsigned payload acceptance), build pipeline compromise vectors.

## Scope

### In scope

- The NeuroNest Electron application: main process, renderer, preload/IPC bridge
- The native C++ module (crypto and system integration)
- The `@neuronest/cli` package
- The agent pipeline: prompt firewall, action security analyzer, swarm orchestration, execution modes
- Docker sandbox isolation
- Secret/credential storage and handling, including messaging-channel tokens
- Auto-update, build, and release infrastructure
- The neuronest.cc website **only** where it affects application security (e.g., download integrity)

### Out of scope

- Third-party LLM provider APIs and infrastructure (report to the provider)
- Vulnerabilities in third-party dependencies with no NeuroNest-specific exploit path (report upstream; do tell us if NeuroNest's usage makes it exploitable)
- Attacks requiring physical access to an unlocked device
- Social engineering of NeuroNest maintainers or users
- Denial of service via resource exhaustion (including API-quota exhaustion through agent loops)
- Outcomes of user-granted permissions: if a user selects a permissive security policy and approves an action, the resulting behavior is not a vulnerability
- Model hallucinations, jailbreaks affecting only output content, or provider-side content-policy bypasses

## Security Best Practices for Users

- Prefer the Docker sandbox for agent code execution on untrusted or unfamiliar repositories.
- Use the most restrictive security policy preset your workflow allows; require approval for destructive actions.
- Treat connected messaging channels as untrusted input surfaces — anyone who can message a connected channel can attempt prompt injection.
- Scope provider API keys minimally and rotate them if you suspect exposure.
- Keep NeuroNest updated; only the latest minor version receives patches.

---

*This policy may be updated as NeuroNest evolves. Material changes will be noted in release notes.*