// ─── DeerFlow Pipeline Types ────────────────────────────────────
// Core type definitions for Skill_Loader, Context_Summarizer,
// Execution_Mode_Router, Sub_Agent_Context_Isolator,
// Tool_Call_Recovery_Handler, and Suggestion_Generator modules.

import type { PreservedMetadata } from '../../session/context-compressor.js';
import type { LLMMessage } from '../llm-client.js';

// Re-export for convenience
export type { PreservedMetadata, LLMMessage };

// ─── Skill_Loader ───────────────────────────────────────────────

export interface SkillFragment {
  agentId: string;
  domain: string;
  content: string;        // system prompt fragment
  tokenCost: number;      // estimated tokens
  dependencies: string[]; // agentIds that must load first
}

export interface SkillLoaderConfig {
  tokenBudgetFraction: number; // default 0.50
  contextWindowSize: number;   // from model config
}

// ─── Context_Summarizer ─────────────────────────────────────────

export interface SummaryRecord {
  id: string;
  sessionId: string;
  subTaskId: string;
  summary: string;                       // ≤200 tokens
  fullResultPath: string;                // filesystem path to JSON
  preservedMetadata: PreservedMetadata;
  createdAt: Date;
}

export interface ContextSummarizerConfig {
  maxSummaryTokens: number;       // default 200
  workspaceDir: string;
  compressionThreshold: number;   // default 0.80, synced with Context_Compressor
}

// ─── Execution_Mode_Router ──────────────────────────────────────

export type ExecutionMode = 'flash' | 'standard' | 'pro' | 'ultra' | 'loop';

export interface ModeConfig {
  mode: ExecutionMode;
  tokenBudget: number;
}

export interface ExecutionResult {
  output: string;
  mode: ExecutionMode;
  agentsUsed: string[];
  tokensUsed: number;
}

// ─── Sub_Agent_Context_Isolator ─────────────────────────────────

export type IsolationLevel = 'strict' | 'permissive';

export interface IsolatedContext {
  scopeId: string;
  agentId: string;
  systemPrompt: string;
  messages: LLMMessage[];
  tokenBudget: number;
  isolationLevel: IsolationLevel;
}

// ─── Tool_Call_Recovery_Handler ─────────────────────────────────

export interface RecoveryEvent {
  timestamp: Date;
  interruptedTools: string[];
  reason: string;
  recoveryAction: 'placeholder_injected' | 'tool_disabled';
}

export interface ToolCallRecoveryConfig {
  maxConsecutiveFailures: number; // default 3
}

// ─── Suggestion_Generator ───────────────────────────────────────

export interface Suggestion {
  id: string;
  text: string;       // human-readable suggestion
  action: string;     // pre-fill text for input field
  category: 'domain' | 'diagnostic';
}
