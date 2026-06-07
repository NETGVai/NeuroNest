/**
 * SuperAgentManager — Agent lifecycle, template management, HyperAgents integration.
 *
 * Stub implementation with in-memory state. Manages SuperAgent creation,
 * retrieval, deletion, and template import/export. Provides pre-configured
 * templates from agent-swarm registry.
 *
 * Requirements: 4.1, 4.3–4.5, 4.7–4.9, 4.12
 */

import { randomUUID } from 'node:crypto';
import type {
  AgentTemplate,
  AgentIdentity,
  ModelConfig,
  ChatChunk,
  Session,
} from '../shared/types.js';

// ─── Types ──────────────────────────────────────────────────────

export interface SuperAgent {
  id: string;
  name: string;
  template: AgentTemplate;
  identity: AgentIdentity;
  model: ModelConfig;
}

export interface PerformanceRecord {
  id: string;
  agentId: string;
  taskDescription: string;
  qualityScore: number;
  tokensUsed: number;
  durationMs: number;
  improvementVersion: number;
  createdAt: Date;
}

// ─── Pre-configured templates from agent-swarm registry ─────────

const BUILTIN_TEMPLATES: AgentTemplate[] = [
  makeTemplate("frontend-dev", "Frontend Developer", "React/Vue/Angular, UI implementation, performance optimization", "🎨"),
  makeTemplate("backend-architect", "Backend Architect", "API design, database architecture, scalability, microservices", "🏗️"),
  makeTemplate("mobile-builder", "Mobile App Builder", "iOS/Android, React Native, Flutter cross-platform apps", "📱"),
  makeTemplate("ai-engineer", "AI Engineer", "ML models, deployment, AI integration, data pipelines", "🤖"),
  makeTemplate("devops", "DevOps Automator", "CI/CD, infrastructure automation, cloud ops, monitoring", "🚀"),
  makeTemplate("rapid-prototyper", "Rapid Prototyper", "Fast POC development, MVPs, quick iteration cycles", "⚡"),
  makeTemplate("senior-dev", "Senior Developer", "Advanced patterns, complex implementations, architecture decisions", "💎"),
  makeTemplate("security-engineer", "Security Engineer", "Threat modeling, secure code review, security architecture", "🔒"),
  makeTemplate("embedded-firmware", "Embedded Firmware Engineer", "Bare-metal, RTOS, ESP32/STM32/Nordic firmware", "🔩"),
  makeTemplate("incident-commander", "Incident Response Commander", "Incident management, post-mortems, on-call readiness", "🚨"),
  makeTemplate("solidity-engineer", "Solidity Smart Contract Engineer", "EVM contracts, gas optimization, DeFi protocols", "⛓️"),
  makeTemplate("technical-writer", "Technical Writer", "Developer docs, API reference, tutorials", "📚"),
  makeTemplate("code-reviewer", "Code Reviewer", "Constructive code review, security, maintainability", "👁️"),
  makeTemplate("db-optimizer", "Database Optimizer", "Schema design, query optimization, indexing strategies", "🗄️"),
  makeTemplate("git-master", "Git Workflow Master", "Branching strategies, conventional commits, advanced Git", "🌿"),
  makeTemplate("software-architect", "Software Architect", "System design, DDD, architectural patterns, trade-off analysis", "🏛️"),
  makeTemplate("sre", "SRE", "SLOs, error budgets, observability, chaos engineering", "🛡️"),
  makeTemplate("data-engineer", "Data Engineer", "Data pipelines, lakehouse architecture, ETL/ELT", "🔧"),
  makeTemplate("ui-designer", "UI Designer", "Visual design, component libraries, design systems", "🎯"),
  makeTemplate("ux-researcher", "UX Researcher", "User testing, behavior analysis, usability research", "🔍"),
  makeTemplate("ux-architect", "UX Architect", "Technical architecture, CSS systems, implementation guidance", "🏛️"),
  makeTemplate("brand-guardian", "Brand Guardian", "Brand identity, consistency, positioning, guidelines", "🎭"),
  makeTemplate("growth-hacker", "Growth Hacker", "Rapid user acquisition, viral loops, conversion optimization", "🚀"),
  makeTemplate("content-creator", "Content Creator", "Multi-platform content, editorial calendars, copywriting", "📝"),
  makeTemplate("seo-specialist", "SEO Specialist", "Technical SEO, content strategy, link building", "🔍"),
  makeTemplate("social-strategist", "Social Media Strategist", "Cross-platform strategy, campaigns, audience growth", "🌐"),
  makeTemplate("product-manager", "Product Manager", "Full lifecycle product ownership, PRDs, roadmap planning", "🧭"),
  makeTemplate("sprint-prioritizer", "Sprint Prioritizer", "Agile planning, feature prioritization, backlog management", "🎯"),
  makeTemplate("trend-researcher", "Trend Researcher", "Market intelligence, competitive analysis, opportunity assessment", "🔍"),
  makeTemplate("feedback-synthesizer", "Feedback Synthesizer", "User feedback analysis, insights extraction, priorities", "💬"),
  makeTemplate("outbound-strategist", "Outbound Strategist", "Signal-based prospecting, multi-channel sequences", "��"),
  makeTemplate("deal-strategist", "Deal Strategist", "MEDDPICC qualification, competitive positioning, win planning", "♟️"),
  makeTemplate("sales-engineer", "Sales Engineer", "Technical demos, POC scoping, competitive battlecards", "🛠️"),
  makeTemplate("evidence-collector", "Evidence Collector", "Screenshot-based QA, visual proof, bug documentation", "📸"),
  makeTemplate("reality-checker", "Reality Checker", "Evidence-based certification, quality gates, release readiness", "🔍"),
  makeTemplate("performance-benchmarker", "Performance Benchmarker", "Performance testing, load testing, optimization", "⚡"),
  makeTemplate("api-tester", "API Tester", "API validation, integration testing, endpoint verification", "🔌"),
  makeTemplate("accessibility-auditor", "Accessibility Auditor", "WCAG auditing, assistive technology testing", "♿"),
  makeTemplate("project-shepherd", "Project Shepherd", "Cross-functional coordination, timeline management", "🐑"),
  makeTemplate("senior-pm", "Senior Project Manager", "Realistic scoping, task conversion, scope management", "👔"),
  makeTemplate("support-responder", "Support Responder", "Customer service, issue resolution, support operations", "💬"),
  makeTemplate("analytics-reporter", "Analytics Reporter", "Data analysis, dashboards, KPI tracking, insights", "📊"),
  makeTemplate("legal-compliance", "Legal Compliance Checker", "Compliance, regulations, legal review, risk management", "⚖️"),
  makeTemplate("mcp-builder", "MCP Builder", "Model Context Protocol servers, AI agent tooling", "🔌"),
  makeTemplate("doc-generator", "Document Generator", "PDF, PPTX, DOCX, XLSX generation from code", "📄"),
  makeTemplate("workflow-architect", "Workflow Architect", "Workflow discovery, mapping, and specification", "🗺️"),
  makeTemplate("game-designer", "Game Designer", "Systems design, GDD authorship, economy balancing", "🎯"),
  makeTemplate("unity-architect", "Unity Architect", "ScriptableObjects, data-driven modularity, DOTS/ECS", "🏗️"),
  makeTemplate("unreal-engineer", "Unreal Systems Engineer", "C++/Blueprint hybrid, GAS, Nanite, memory management", "⚙️"),
  makeTemplate("narratologist", "Narratologist", "Narrative theory, story structure, character arcs", "📜"),
];

function makeTemplate(id: string, name: string, role: string, icon: string = "🤖"): AgentTemplate {
  return {
    id: `builtin-${id}`,
    name,
    role,
    systemPrompt: `You are a ${name}. ${role}.\n\nYou are a specialized expert with deep domain knowledge. Provide detailed, actionable guidance in your area of expertise.`,
    domain: undefined,
    modelPreference: { providerId: 'anthropic', model: 'claude-3' },
    toolPermissions: ['*'],
    identityFiles: {
      soulMd: `# ${icon} ${name}\n\n## Core Purpose\n${role}\n\n## Personality\n- Deep expertise in your domain\n- Clear, actionable communication\n- Production-ready deliverables\n- Measurable outcomes`,
      identityMd: `# Identity\nName: ${name}\nRole: ${role}`,
      toolsMd: `# Tools\nAll tools available.`,
      claudeMd: `# Claude\nModel-specific instructions for ${name}.`,
    },
  };
}

// ─── SuperAgentManager ──────────────────────────────────────────

export class SuperAgentManager {
  private agents = new Map<string, SuperAgent>();
  private customTemplates = new Map<string, AgentTemplate>();
  private performanceRecords: PerformanceRecord[] = [];

  /**
   * Create a new SuperAgent from a template.
   * Requirements: 4.1, 4.5
   */
  createAgent(template: AgentTemplate): SuperAgent {
    const id = randomUUID();
    const agent: SuperAgent = {
      id,
      name: template.name,
      template,
      identity: {
        soul: template.identityFiles.soulMd,
        identity: template.identityFiles.identityMd,
        tools: template.identityFiles.toolsMd,
        claude: template.identityFiles.claudeMd,
      },
      model: template.modelPreference,
    };
    this.agents.set(id, agent);
    return agent;
  }

  /**
   * Get a SuperAgent by ID.
   */
  getAgent(agentId: string): SuperAgent | null {
    return this.agents.get(agentId) ?? null;
  }

  /**
   * List all active SuperAgents.
   */
  listAgents(): SuperAgent[] {
    return Array.from(this.agents.values());
  }

  /**
   * Delete a SuperAgent.
   */
  deleteAgent(agentId: string): void {
    if (!this.agents.has(agentId)) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    this.agents.delete(agentId);
  }

  /**
   * List all available templates (built-in + custom).
   * Requirements: 4.3, 4.8
   */
  listTemplates(): AgentTemplate[] {
    return [...BUILTIN_TEMPLATES, ...this.customTemplates.values()];
  }

  /**
   * Import a template from JSON string.
   * Requirements: 4.9
   */
  importTemplate(json: string): AgentTemplate {
    const parsed = JSON.parse(json) as AgentTemplate;
    if (!parsed.id || !parsed.name || !parsed.role) {
      throw new Error('Invalid template: missing required fields (id, name, role)');
    }
    this.customTemplates.set(parsed.id, parsed);
    return parsed;
  }

  /**
   * Export a template as JSON string.
   * Requirements: 4.9
   */
  exportTemplate(templateId: string): string {
    const template =
      BUILTIN_TEMPLATES.find((t) => t.id === templateId) ??
      this.customTemplates.get(templateId);
    if (!template) {
      throw new Error(`Template not found: ${templateId}`);
    }
    return JSON.stringify(template, null, 2);
  }

  /**
   * Record a performance entry for an agent.
   */
  recordPerformance(record: Omit<PerformanceRecord, 'id' | 'createdAt'>): PerformanceRecord {
    const entry: PerformanceRecord = {
      ...record,
      id: randomUUID(),
      createdAt: new Date(),
    };
    this.performanceRecords.push(entry);
    return entry;
  }

  /**
   * Get performance history for an agent.
   */
  getPerformanceHistory(agentId: string): PerformanceRecord[] {
    return this.performanceRecords.filter((r) => r.agentId === agentId);
  }
}
