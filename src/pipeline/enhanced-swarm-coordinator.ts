/**
 * Enhanced Swarm Coordinator - Multica Integration
 * Extends existing swarm coordination with task lifecycle management and enhanced agent tracking
 */

import { SwarmCoordinator, SwarmMemoryPool, type SwarmEvent, type SwarmEventCallback, type SwarmResult } from './swarm-coordinator';
import { ExecutionPlan, AgentTask as OrchestratorAgentTask } from './orchestrator-planner';
import { EnhancedAgentManager, type AgentTask, type EnhancedAgentEvent } from '../agents/enhanced-agent-manager';
import { LLMClient } from './llm-client';
import { AGENT_REGISTRY } from '../agents/agent-registry';
import { PERF_FLAGS } from '../main/performance/feature-flags';
import { GCF_PRIMER } from '../serializers/gcf-encoder';
import { resolveSkillForInjection, buildSkillPromptBlock, type MatchedSkill } from './swarm-skill-injection';
import type Database from 'better-sqlite3';

// ── Enhanced Event Types ──

export type EnhancedSwarmEventType = 
  | 'task_lifecycle_start'
  | 'task_claimed'
  | 'task_progress_update'
  | 'task_blocker_reported'
  | 'skill_applied'
  | 'runtime_assigned'
  | 'workload_balanced';

export interface EnhancedSwarmEvent {
  type: SwarmEvent['type'] | EnhancedSwarmEventType;
  phase?: number;
  content?: string;
  reasoning?: string;
  agentId?: string;
  agentName?: string;
  taskId?: string;
  runtimeId?: string;
  skillId?: string;
  progress?: number;
  blocker?: string;
  token?: string;
  msgId?: string;
  done?: boolean;
  error?: boolean;
}

export type EnhancedSwarmEventCallback = (event: EnhancedSwarmEvent) => void;

// ── Enhanced Swarm Result ──

export interface EnhancedSwarmResult extends SwarmResult {
  tasks: AgentTask[];
  skillsUsed: string[];
  runtimesUsed: string[];
  totalBlockers: number;
  avgTaskDuration: number;
}

// ── Enhanced Swarm Coordinator ──

export class EnhancedSwarmCoordinator extends SwarmCoordinator {
  private enhancedAgentManager: EnhancedAgentManager;
  private db: Database.Database;
  private sessionId: string | null = null;
  private enhancedMemoryPool: SwarmMemoryPool;
  private enhancedLLMClient: LLMClient | null;
  /** Skill IDs actually injected into an agent's prompt during the current run (Requirement: accurate "Skills Used" reporting). */
  private appliedSkillIds: Set<string> = new Set();

  constructor(llmClient: LLMClient | null, db: Database.Database) {
    // Create memory pool for parent constructor
    const memoryPool = new SwarmMemoryPool();
    super(memoryPool, llmClient);
    
    this.db = db;
    this.enhancedLLMClient = llmClient;
    this.enhancedMemoryPool = memoryPool;
    this.enhancedAgentManager = new EnhancedAgentManager(db);
    
    // Listen to enhanced agent events
    this.enhancedAgentManager.on('task_created', this.handleAgentEvent.bind(this));
    this.enhancedAgentManager.on('task_claimed', this.handleAgentEvent.bind(this));
    this.enhancedAgentManager.on('task_started', this.handleAgentEvent.bind(this));
    this.enhancedAgentManager.on('task_completed', this.handleAgentEvent.bind(this));
    this.enhancedAgentManager.on('task_failed', this.handleAgentEvent.bind(this));
    this.enhancedAgentManager.on('task_blocked', this.handleAgentEvent.bind(this));
    this.enhancedAgentManager.on('skill_learned', this.handleAgentEvent.bind(this));
  }

  /**
   * Enhanced execute method that creates tasks and manages lifecycle
   */
  async executeEnhanced(
    plan: ExecutionPlan, 
    sessionId: string,
    onEvent?: EnhancedSwarmEventCallback, 
    agentLLMConfigs?: Map<string, LLMClient>
  ): Promise<EnhancedSwarmResult> {
    this.sessionId = sessionId;
    const startTime = Date.now();
    this.appliedSkillIds = new Set();

    // Create tasks from orchestrator plan
    const tasks = await this.createTasksFromPlan(plan, sessionId);
    
    onEvent?.({
      type: 'task_lifecycle_start',
      content: `Created ${tasks.length} tasks from orchestrator plan`,
      phase: 0
    });

    // Execute with enhanced lifecycle management
    const baseResult = await this.executeWithLifecycle(
      plan, 
      tasks,
      (event) => {
        // Convert base events to enhanced events
        onEvent?.(event as EnhancedSwarmEvent);
      }, 
      agentLLMConfigs
    );

    // Gather enhanced metrics
    const completedTasks = tasks.filter(t => t.status === 'completed');
    const skillsUsed = await this.getSkillsUsedInTasks(tasks.map(t => t.id));
    const runtimesUsed = [...new Set(tasks.map(t => t.runtimeId).filter((id): id is string => Boolean(id)))];
    const totalBlockers = await this.getBlockerCountForTasks(tasks.map(t => t.id));
    const avgTaskDuration = completedTasks.length > 0 
      ? completedTasks.reduce((sum, t) => sum + (t.actualHours || 0), 0) / completedTasks.length 
      : 0;

    return {
      ...baseResult,
      tasks,
      skillsUsed,
      runtimesUsed,
      totalBlockers,
      avgTaskDuration
    };
  }

  /**
   * Backward compatible execute method - delegates to original implementation
   */
  async execute(
    plan: ExecutionPlan, 
    onEvent?: SwarmEventCallback, 
    agentLLMConfigs?: Map<string, LLMClient>
  ): Promise<SwarmResult> {
    // Use original implementation for backward compatibility
    return super.execute(plan, onEvent, agentLLMConfigs);
  }

  /**
   * Create tasks from orchestrator plan
   */
  private async createTasksFromPlan(plan: ExecutionPlan, sessionId: string): Promise<AgentTask[]> {
    const tasks: AgentTask[] = [];

    for (const agentTask of plan.agents) {
      const agentDef = AGENT_REGISTRY.find(a => a.id === agentTask.id);
      const agentName = agentDef?.name || agentTask.id;

      // Assign to best available runtime
      const runtime = await this.selectBestRuntime(agentTask.id);

      const task = await this.enhancedAgentManager.createTask({
        sessionId,
        title: `${agentName}: ${agentTask.task.substring(0, 50)}...`,
        description: agentTask.task,
        assigneeId: agentTask.id,
        assigneeName: agentName,
        assigneeType: 'agent',
        priority: this.determinePriority(agentTask),
        dependsOn: agentTask.dependsOn,
        runtimeId: runtime?.id,
        metadata: {
          orchestratorTaskId: agentTask.id,
          department: agentDef?.department,
          specialty: agentDef?.specialty
        }
      });

      tasks.push(task);
    }

    return tasks;
  }

  /**
   * Execute with enhanced lifecycle management
   */
  private async executeWithLifecycle(
    plan: ExecutionPlan,
    tasks: AgentTask[],
    onEvent?: EnhancedSwarmEventCallback,
    agentLLMConfigs?: Map<string, LLMClient>
  ): Promise<SwarmResult> {
    const outputs = new Map<string, string>();
    const phases = this.createPhases(plan.agents);

    // Detect if we're using a local provider (Ollama/llama.cpp) — must run agents sequentially
    const isLocalProvider = this.enhancedLLMClient && (
      (this.enhancedLLMClient as any).config?.provider === 'ollama' ||
      (this.enhancedLLMClient as any).config?.provider === 'llamacpp' ||
      ((this.enhancedLLMClient as any).config?.baseUrl && ((this.enhancedLLMClient as any).config.baseUrl.includes('localhost') || (this.enhancedLLMClient as any).config.baseUrl.includes('127.0.0.1')))
    );

    for (const { phase, agents } of phases) {
      onEvent?.({
        type: 'phase_start',
        phase,
        content: `Phase ${phase}: executing ${agents.length} agent(s)` + (isLocalProvider ? ' (sequential — local LLM)' : ''),
      });

      if (isLocalProvider) {
        // Sequential execution for local LLMs (Ollama can only handle 1 request at a time)
        for (const agentTask of agents) {
          const task = tasks.find(t => t.metadata.orchestratorTaskId === agentTask.id);
          if (!task) continue;
          try {
            const result = await this.executeAgentWithLifecycle(agentTask, task, onEvent, agentLLMConfigs);
            if (result.response) outputs.set(result.id, result.response);
          } catch (err) {
            console.error('[EnhancedSwarm] Agent failed:', agentTask.id, err);
          }
        }
      } else {
        // Parallel execution for cloud providers
        const promises = agents.map(async (agentTask: OrchestratorAgentTask) => {
          const task = tasks.find(t => t.metadata.orchestratorTaskId === agentTask.id);
          if (!task) return { id: agentTask.id, response: '' };

          return this.executeAgentWithLifecycle(agentTask, task, onEvent, agentLLMConfigs);
        });

        // Wait for all agents in this phase
        const results = await Promise.allSettled(promises);
      
        // Process results
        for (const result of results) {
          if (result.status === 'fulfilled' && result.value.response) {
            outputs.set(result.value.id, result.value.response);
          }
        }
      }
    }

    return {
      outputs,
      consensusResults: [],
      totalPhases: phases.length,
      topology: plan.topology
    };
  }

  /**
   * Create phases from agent tasks (simplified version of assignPhases)
   */
  private createPhases(agents: OrchestratorAgentTask[]): Array<{ phase: number; agents: OrchestratorAgentTask[] }> {
    // Simple phase assignment - agents with no dependencies go first
    const phases: Array<{ phase: number; agents: OrchestratorAgentTask[] }> = [];
    const processed = new Set<string>();
    let currentPhase = 0;

    while (processed.size < agents.length) {
      const currentPhaseAgents = agents.filter(agent => 
        !processed.has(agent.id) && 
        agent.dependsOn.every(dep => processed.has(dep))
      );

      if (currentPhaseAgents.length === 0) {
        // Break circular dependencies by taking remaining agents
        const remaining = agents.filter(agent => !processed.has(agent.id));
        if (remaining.length > 0) {
          phases.push({ phase: currentPhase, agents: remaining });
          remaining.forEach(agent => processed.add(agent.id));
        }
        break;
      }

      phases.push({ phase: currentPhase, agents: currentPhaseAgents });
      currentPhaseAgents.forEach(agent => processed.add(agent.id));
      currentPhase++;
    }

    return phases;
  }

  /**
   * Execute individual agent with full lifecycle management
   */
  private async executeAgentWithLifecycle(
    agentTask: OrchestratorAgentTask,
    task: AgentTask,
    onEvent?: EnhancedSwarmEventCallback,
    agentLLMConfigs?: Map<string, LLMClient>
  ): Promise<{ id: string; response: string }> {
    const agentDef = AGENT_REGISTRY.find(a => a.id === agentTask.id);
    const agentName = agentDef?.name || agentTask.id;

    try {
      // Claim task
      const claimed = await this.enhancedAgentManager.claimTask(task.id, agentTask.id);
      if (!claimed) {
        throw new Error(`Failed to claim task ${task.id}`);
      }

      // Emit agent_start so the renderer tracks this agent as active
      onEvent?.({
        type: 'agent_start',
        agentId: agentTask.id,
        agentName,
        phase: 0,
        content: `${agentName} starting task`,
      });

      onEvent?.({
        type: 'task_claimed',
        taskId: task.id,
        agentId: agentTask.id,
        content: `${agentName} claimed task: ${task.title}`
      });

      // Start task
      await this.enhancedAgentManager.startTask(task.id, agentTask.id);

      // Resolve the skill most relevant to this task's description (real
      // keyword-overlap matching against the agent's assigned skills, not
      // just "first expert-level skill") and load its content for injection.
      const applicableSkill = resolveSkillForInjection(this.db, agentTask.id, task.description || agentTask.task || '');

      if (applicableSkill) {
        this.appliedSkillIds.add(applicableSkill.skillId);
        onEvent?.({
          type: 'skill_applied',
          taskId: task.id,
          agentId: agentTask.id,
          skillId: applicableSkill.skillId,
          content: `Applying skill: ${applicableSkill.skillName}`
        });
      }

      // Execute with progress tracking — the matched skill's content (if any)
      // is injected into the agent's system prompt inside executeAgentTask.
      const response = await this.executeAgentTask(agentTask, task, onEvent, agentLLMConfigs, applicableSkill);

      // Complete task
      await this.enhancedAgentManager.completeTask(task.id, agentTask.id, response);
      // Update in-memory task status so the summary reflects completion
      task.status = 'completed';

      // Emit agent_complete with the full response so the renderer shows it
      onEvent?.({
        type: 'agent_complete',
        agentId: agentTask.id,
        agentName,
        phase: 0,
        content: response,
        reasoning: this.enhancedMemoryPool.get(`reasoning:${agentTask.id}`) || undefined,
      });

      return { id: agentTask.id, response };

    } catch (error: any) {
      // Handle failures and blockers
      const errorMessage = error.message || 'Unknown error';
      
      // Check if this is a blocker vs a failure
      if (this.isBlocker(errorMessage)) {
        await this.enhancedAgentManager.reportBlocker(task.id, {
          blockerType: 'technical',
          title: 'Execution Blocker',
          description: errorMessage,
          severity: 'high',
          status: 'open',
          reportedByType: 'agent',
          reportedById: agentTask.id,
          reportedByName: AGENT_REGISTRY.find(a => a.id === agentTask.id)?.name || agentTask.id
        });
        task.status = 'blocked';

        onEvent?.({
          type: 'task_blocker_reported',
          taskId: task.id,
          agentId: agentTask.id,
          blocker: errorMessage,
          content: `Blocker reported: ${errorMessage}`
        });
      } else {
        await this.enhancedAgentManager.failTask(task.id, agentTask.id, errorMessage);
        task.status = 'failed';
      }

      // Emit agent_complete even on failure so the renderer shows the error
      onEvent?.({
        type: 'agent_complete',
        agentId: agentTask.id,
        agentName,
        phase: 0,
        content: `## ❌ ${agentName} Failed\n\n${errorMessage}`,
      });

      console.error('[EnhancedSwarm] Agent', agentTask.id, 'failed:', errorMessage);

      return { id: agentTask.id, response: `Error: ${errorMessage}` };
    }
  }

  /**
   * Execute the actual agent task with progress updates
   */
  private async executeAgentTask(
    agentTask: OrchestratorAgentTask,
    task: AgentTask,
    onEvent?: EnhancedSwarmEventCallback,
    agentLLMConfigs?: Map<string, LLMClient>,
    applicableSkill?: MatchedSkill | null
  ): Promise<string> {
    const agentDef = AGENT_REGISTRY.find(a => a.id === agentTask.id);
    
    const hasPerAgentConfig = agentLLMConfigs?.has(agentTask.id) || false;
    const agentLLM = agentLLMConfigs?.get(agentTask.id) || this.enhancedLLMClient;

    console.log('[EnhancedSwarm] executeAgentTask:', agentTask.id, 
      '| perAgentConfig:', hasPerAgentConfig,
      '| configMapSize:', agentLLMConfigs?.size || 0,
      '| enhancedLLMClient:', !!this.enhancedLLMClient,
      '| resolved:', !!agentLLM);

    if (!agentLLM) {
      console.error('[EnhancedSwarm] No LLM client for', agentTask.id, 
        '- agentLLMConfigs has', agentLLMConfigs?.size || 0, 'entries,',
        'enhancedLLMClient:', !!this.enhancedLLMClient);
      throw new Error(`No LLM client available for agent ${agentTask.id}. Check Settings → AI Providers.`);
    }

    console.log('[EnhancedSwarm] Executing', agentTask.id, 'with LLM client');

    // Update progress: 25% - Starting execution
    await this.enhancedAgentManager.updateTaskProgress(task.id, 25, 'Starting task execution');
    
    onEvent?.({
      type: 'task_progress_update',
      taskId: task.id,
      agentId: agentTask.id,
      progress: 25,
      content: 'Starting task execution'
    });

    // Build context with dependencies
    let contextPrefix = '';
    for (const depId of agentTask.dependsOn) {
      // Get dependency output from memory pool
      const depOutput = this.enhancedMemoryPool.get(`agent:${depId}`);
      if (depOutput) {
        contextPrefix += `\n--- Context from ${depId} ---\n${depOutput.slice(0, 2000)}\n`;
      }
    }

    // Update progress: 50% - Processing
    await this.enhancedAgentManager.updateTaskProgress(task.id, 50, 'Processing with LLM');
    
    onEvent?.({
      type: 'task_progress_update',
      taskId: task.id,
      agentId: agentTask.id,
      progress: 50,
      content: 'Processing with LLM'
    });

    // Execute with LLM — context-aware prompt construction
    const isLocal = (agentLLM as any).config?.provider === 'ollama' || 
                    (agentLLM as any).config?.provider === 'llamacpp' ||
                    ((agentLLM as any).config?.baseUrl && ((agentLLM as any).config.baseUrl.includes('localhost') || (agentLLM as any).config.baseUrl.includes('127.0.0.1')));
    const modelContextTokens = isLocal ? 4096 : 8192;
    const maxTokens = Math.min(2048, Math.floor(modelContextTokens * 0.5));
    const promptBudgetTokens = modelContextTokens - maxTokens - 300;
    const promptBudgetChars = promptBudgetTokens * 3;

    const outputFormat = '\n\n=== OUTPUT FORMAT ===\n' +
      'IMPORTANT: Format your response using markdown for readability:\n' +
      '- Use ## headers to separate sections\n' +
      '- Use bullet points for lists\n' +
      '- Use **bold** for key terms\n' +
      '- Use `inline code` for identifiers\n' +
      '- Use code blocks with language tags for code snippets\n\n' +
      'For code output, use: // file: path/filename.ext\n```lang\n// contents\n```\n' +
      'Generate COMPLETE working files with all imports. Aim for 3-10 files.\n' +
      '=== END FORMAT ===';

    let systemPrompt = (agentDef?.systemPrompt || 'You are a helpful AI assistant.') + outputFormat;

    // ── Skill injection: append the matched skill's content as reference
    // material for the agent (Requirement: agents actually use assigned
    // skills, not just report a "skill_applied" event with no effect). ──
    if (applicableSkill) {
      systemPrompt += buildSkillPromptBlock(applicableSkill);
    }

    // ── F10 GCF primer injection ──
    if (PERF_FLAGS.GCF_WIRE_FORMAT) {
      systemPrompt = GCF_PRIMER + '\n\n' + systemPrompt;
    }

    const contextSummary = this.enhancedMemoryPool.getContextSummary ? this.enhancedMemoryPool.getContextSummary() : '';
    let fullTask = (contextPrefix ? `${agentTask.task}\n\nPrior context:\n${contextPrefix}` : agentTask.task) +
      (contextSummary ? '\n\n' + contextSummary : '');

    // Truncate to fit context window
    const taskBudget = Math.floor(promptBudgetChars * 0.4);
    const systemBudget = promptBudgetChars - taskBudget;
    if (systemPrompt.length > systemBudget) {
      systemPrompt = systemPrompt.slice(0, systemBudget - 20) + '\n[truncated]';
    }
    if (fullTask.length > taskBudget) {
      fullTask = fullTask.slice(0, taskBudget - 20) + '\n[truncated]';
    }

    // Use true streaming — forward tokens as they arrive from the LLM
    const crypto = require('node:crypto');
    const streamMsgId = crypto.randomUUID();
    let streamedContent = '';
    const agentName = agentDef?.name || agentTask.id;

    // Signal stream start
    onEvent?.({
      type: 'agent_token',
      agentId: agentTask.id,
      agentName,
      msgId: streamMsgId,
      token: '',
      done: false,
    });

    await agentLLM.chatStream([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: fullTask },
    ], {
      onToken: ({ content: tokenText }) => {
        streamedContent += tokenText;
        onEvent?.({
          type: 'agent_token',
          agentId: agentTask.id,
          agentName,
          msgId: streamMsgId,
          token: tokenText,
        });
      },
      onDone: (result) => {
        onEvent?.({
          type: 'agent_token',
          agentId: agentTask.id,
          agentName,
          msgId: streamMsgId,
          done: true,
          reasoning: result.reasoning,
        });
      },
      onError: ({ message: errMsg, partialContent }) => {
        streamedContent = partialContent;
        onEvent?.({
          type: 'agent_token',
          agentId: agentTask.id,
          agentName,
          msgId: streamMsgId,
          done: true,
          error: true,
          content: errMsg,
        });
      },
    }, { temperature: 0.7, maxTokens, nLoops: (agentLLM as any)._nLoops });

    console.log('[EnhancedSwarm] LLM streamed response for', agentTask.id, ':', streamedContent.length, 'chars,', (streamedContent.match(/```/g) || []).length / 2, 'code blocks');

    // Update progress: 75% - Processing complete
    await this.enhancedAgentManager.updateTaskProgress(task.id, 75, 'LLM processing complete');
    
    onEvent?.({
      type: 'task_progress_update',
      taskId: task.id,
      agentId: agentTask.id,
      progress: 75,
      content: 'LLM processing complete'
    });

    // Store in memory pool
    this.enhancedMemoryPool.set(`agent:${agentTask.id}`, streamedContent.slice(0, 8000));

    // Update progress: 100% - Complete
    await this.enhancedAgentManager.updateTaskProgress(task.id, 100, 'Task completed successfully');
    
    onEvent?.({
      type: 'task_progress_update',
      taskId: task.id,
      agentId: agentTask.id,
      progress: 100,
      content: 'Task completed successfully'
    });

    return streamedContent;
  }

  // ── Helper Methods ──

  private async selectBestRuntime(agentId: string): Promise<{ id: string } | null> {
    const runtimes = this.enhancedAgentManager.getRuntimes();
    const activeRuntimes = runtimes.filter(r => r.status === 'active');
    
    if (activeRuntimes.length === 0) return null;
    
    // Simple load balancing - select runtime with least current load
    // In a real implementation, this would consider agent capabilities, resource usage, etc.
    return activeRuntimes[0];
  }

  private determinePriority(agentTask: OrchestratorAgentTask): 'low' | 'medium' | 'high' | 'urgent' {
    // Determine priority based on dependencies and task complexity
    if (agentTask.dependsOn.length === 0) return 'high'; // No dependencies = can start immediately
    if (agentTask.dependsOn.length > 3) return 'low'; // Many dependencies = lower priority
    return 'medium';
  }

  private isBlocker(errorMessage: string): boolean {
    // Determine if an error is a blocker vs a failure using expanded keyword matching
    const blockerKeywords = [
      'permission', 'access', 'dependency', 'resource', 'timeout', 'rate limit',
      'quota', 'exceeded', 'insufficient', 'privileges', 'unavailable', 'forbidden',
      'unauthorized', 'locked', 'busy', 'capacity', 'throttl', 'limit reached',
      'out of memory', 'disk full', 'connection refused', 'service unavailable',
    ];
    return blockerKeywords.some(keyword => errorMessage.toLowerCase().includes(keyword));
  }

  /**
   * LLM-based error classification. Determines if an error is a blocker
   * (external constraint preventing progress) vs a failure (code/logic error).
   * Falls back to keyword matching if LLM is unavailable.
   */
  async isBlockerWithLLM(errorMessage: string, llmClient?: any): Promise<boolean> {
    if (llmClient) {
      try {
        const response = await llmClient.chat([
          { role: 'system', content: 'Classify this error as either "blocker" (external constraint: permissions, rate limits, resource unavailable, quota exceeded, timeout) or "failure" (code bug, logic error, invalid input). Respond with ONLY one word: blocker or failure.' },
          { role: 'user', content: errorMessage },
        ], { temperature: 0, maxTokens: 10 });
        if (response.content && response.content.trim().toLowerCase().includes('blocker')) {
          return true;
        }
        return false;
      } catch {
        // Fall back to keyword matching
      }
    }
    return this.isBlocker(errorMessage);
  }

  private async getSkillsUsedInTasks(_taskIds: string[]): Promise<string[]> {
    // Reports skill ids actually injected into an agent's system prompt
    // during this run (populated in executeAgentTask via resolveSkillForInjection).
    return [...this.appliedSkillIds];
  }

  private async getBlockerCountForTasks(taskIds: string[]): Promise<number> {
    if (taskIds.length === 0) return 0;
    
    const placeholders = taskIds.map(() => '?').join(',');
    const result = this.db.prepare(`
      SELECT COUNT(*) as count FROM task_blockers WHERE task_id IN (${placeholders})
    `).get(...taskIds) as { count: number };
    
    return result.count;
  }

  private handleAgentEvent(event: EnhancedAgentEvent): void {
    // Handle enhanced agent events - could emit to UI, log, etc.
    console.log('[EnhancedSwarmCoordinator] Agent event:', event.type);
  }

  // ── Public API for Task Management ──

  getEnhancedAgentManager(): EnhancedAgentManager {
    return this.enhancedAgentManager;
  }

  async getTasksForSession(sessionId: string): Promise<AgentTask[]> {
    return this.enhancedAgentManager.getTasksBySession(sessionId);
  }

  async getTasksForAgent(agentId: string): Promise<AgentTask[]> {
    return this.enhancedAgentManager.getTasksByAgent(agentId);
  }

  async addTaskComment(taskId: string, authorId: string, authorName: string, content: string): Promise<string> {
    return this.enhancedAgentManager.addTaskComment(taskId, 'human', authorId, authorName, content);
  }
}