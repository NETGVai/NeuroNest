/**
 * Enhanced Agent Manager - Multica Integration
 * Extends existing agent management with lifecycle tracking, skills, and runtime management
 */

import type Database from 'better-sqlite3';
import { AGENT_REGISTRY, type AgentDefinition } from './agent-registry';
import { EventEmitter } from 'events';

// ── Enhanced Types ──

export interface AgentTask {
  id: string;
  sessionId: string;
  title: string;
  description?: string;
  assigneeType: 'human' | 'agent';
  assigneeId: string;
  assigneeName: string;
  status: 'queued' | 'claimed' | 'in_progress' | 'completed' | 'failed' | 'blocked';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  labels: string[];
  estimatedHours?: number;
  actualHours?: number;
  progressPercentage: number;
  runtimeId?: string;
  parentTaskId?: string;
  dependsOn: string[];
  
  // Lifecycle timestamps
  queuedAt: Date;
  claimedAt?: Date;
  startedAt?: Date;
  completedAt?: Date;
  failedAt?: Date;
  
  metadata: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

export interface TaskComment {
  id: string;
  taskId: string;
  authorType: 'human' | 'agent';
  authorId: string;
  authorName: string;
  content: string;
  commentType: 'comment' | 'blocker' | 'progress_update' | 'status_change';
  metadata: Record<string, any>;
  createdAt: Date;
}

export interface TaskBlocker {
  id: string;
  taskId: string;
  blockerType: 'dependency' | 'resource' | 'permission' | 'technical' | 'external';
  title: string;
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  status: 'open' | 'in_progress' | 'resolved' | 'wont_fix';
  reportedByType: 'human' | 'agent';
  reportedById: string;
  reportedByName: string;
  resolvedByType?: 'human' | 'agent';
  resolvedById?: string;
  resolvedByName?: string;
  resolutionNotes?: string;
  createdAt: Date;
  resolvedAt?: Date;
}

export interface AgentRuntime {
  id: string;
  name: string;
  type: 'local' | 'cloud' | 'hybrid';
  status: 'active' | 'inactive' | 'error' | 'maintenance';
  capabilities: string[];
  resources: {
    cpu: number;
    memory: number;
    disk: number;
    gpu?: number;
  };
  config: Record<string, any>;
  lastHeartbeat?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentSkillAssignment {
  agentId: string;
  skillId: string;
  proficiencyLevel: 'beginner' | 'intermediate' | 'advanced' | 'expert';
  successRate: number;
  totalExecutions: number;
  successfulExecutions: number;
  avgExecutionTimeMs: number;
  lastUsedAt?: Date;
  learnedAt: Date;
}

export interface AgentWorkload {
  agentId: string;
  runtimeId?: string;
  currentTasks: number;
  maxConcurrentTasks: number;
  avgTaskDurationMs: number;
  successRate: number;
  lastTaskCompletedAt?: Date;
  status: 'available' | 'busy' | 'overloaded' | 'offline';
  updatedAt: Date;
}

// ── Events ──

export type EnhancedAgentEvent = 
  | { type: 'task_created'; task: AgentTask }
  | { type: 'task_claimed'; task: AgentTask; agentId: string }
  | { type: 'task_started'; task: AgentTask; agentId: string }
  | { type: 'task_progress'; task: AgentTask; progress: number }
  | { type: 'task_completed'; task: AgentTask; result: any }
  | { type: 'task_failed'; task: AgentTask; error: string }
  | { type: 'task_blocked'; task: AgentTask; blocker: TaskBlocker }
  | { type: 'skill_learned'; agentId: string; skillId: string }
  | { type: 'runtime_status_changed'; runtime: AgentRuntime };

// ── Enhanced Agent Manager ──

export class EnhancedAgentManager extends EventEmitter {
  private db: Database.Database;

  constructor(db: Database.Database) {
    super();
    this.db = db;
    this.initializeDefaultWorkloads();
  }

  // ── Task Management ──

  async createTask(taskData: Partial<AgentTask> & { 
    sessionId: string; 
    title: string; 
    assigneeId: string; 
    assigneeName: string; 
  }): Promise<AgentTask> {
    const id = this.generateId();
    const now = new Date();
    
    const task: AgentTask = {
      id,
      sessionId: taskData.sessionId,
      title: taskData.title,
      description: taskData.description,
      assigneeType: taskData.assigneeType || 'agent',
      assigneeId: taskData.assigneeId,
      assigneeName: taskData.assigneeName,
      status: 'queued',
      priority: taskData.priority || 'medium',
      labels: taskData.labels || [],
      estimatedHours: taskData.estimatedHours,
      actualHours: taskData.actualHours,
      progressPercentage: 0,
      runtimeId: taskData.runtimeId,
      parentTaskId: taskData.parentTaskId,
      dependsOn: taskData.dependsOn || [],
      queuedAt: now,
      metadata: taskData.metadata || {},
      createdAt: now,
      updatedAt: now
    };

    this.db.prepare(`
      INSERT INTO agent_tasks (
        id, session_id, title, description, assignee_type, assignee_id, assignee_name,
        status, priority, labels, estimated_hours, actual_hours, progress_percentage,
        runtime_id, parent_task_id, depends_on, queued_at, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.id, task.sessionId, task.title, task.description, task.assigneeType,
      task.assigneeId, task.assigneeName, task.status, task.priority,
      JSON.stringify(task.labels), task.estimatedHours, task.actualHours,
      task.progressPercentage, task.runtimeId, task.parentTaskId,
      JSON.stringify(task.dependsOn), task.queuedAt.toISOString(),
      JSON.stringify(task.metadata), task.createdAt.toISOString(), task.updatedAt.toISOString()
    );

    this.emit('task_created', { type: 'task_created', task });
    return task;
  }

  async claimTask(taskId: string, agentId: string): Promise<boolean> {
    const now = new Date();
    
    const result = this.db.prepare(`
      UPDATE agent_tasks 
      SET status = 'claimed', claimed_at = ?, updated_at = ?
      WHERE id = ? AND status = 'queued'
    `).run(now.toISOString(), now.toISOString(), taskId);

    if (result.changes > 0) {
      const task = this.getTask(taskId);
      if (task) {
        this.emit('task_claimed', { type: 'task_claimed', task, agentId });
        await this.updateAgentWorkload(agentId, { currentTasks: 1 });
      }
      return true;
    }
    return false;
  }

  async startTask(taskId: string, agentId: string): Promise<boolean> {
    const now = new Date();
    
    const result = this.db.prepare(`
      UPDATE agent_tasks 
      SET status = 'in_progress', started_at = ?, updated_at = ?
      WHERE id = ? AND status = 'claimed'
    `).run(now.toISOString(), now.toISOString(), taskId);

    if (result.changes > 0) {
      const task = this.getTask(taskId);
      if (task) {
        this.emit('task_started', { type: 'task_started', task, agentId });
      }
      return true;
    }
    return false;
  }

  async updateTaskProgress(taskId: string, progress: number, notes?: string): Promise<void> {
    const now = new Date();
    
    this.db.prepare(`
      UPDATE agent_tasks 
      SET progress_percentage = ?, updated_at = ?
      WHERE id = ?
    `).run(progress, now.toISOString(), taskId);

    if (notes) {
      await this.addTaskComment(taskId, 'agent', 'system', 'System', notes, 'progress_update');
    }

    const task = this.getTask(taskId);
    if (task) {
      this.emit('task_progress', { type: 'task_progress', task, progress });
    }
  }

  async completeTask(taskId: string, agentId: string, result: any): Promise<boolean> {
    const now = new Date();
    
    const dbResult = this.db.prepare(`
      UPDATE agent_tasks 
      SET status = 'completed', completed_at = ?, progress_percentage = 100, updated_at = ?
      WHERE id = ? AND status = 'in_progress'
    `).run(now.toISOString(), now.toISOString(), taskId);

    if (dbResult.changes > 0) {
      const task = this.getTask(taskId);
      if (task) {
        this.emit('task_completed', { type: 'task_completed', task, result });
        await this.updateAgentWorkload(agentId, { currentTasks: -1 });
        await this.recordTaskCompletion(agentId, taskId, true);
      }
      return true;
    }
    return false;
  }

  async failTask(taskId: string, agentId: string, error: string): Promise<boolean> {
    const now = new Date();
    
    const result = this.db.prepare(`
      UPDATE agent_tasks 
      SET status = 'failed', failed_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('claimed', 'in_progress')
    `).run(now.toISOString(), now.toISOString(), taskId);

    if (result.changes > 0) {
      const task = this.getTask(taskId);
      if (task) {
        await this.addTaskComment(taskId, 'agent', agentId, 'Agent', `Task failed: ${error}`, 'status_change');
        this.emit('task_failed', { type: 'task_failed', task, error });
        await this.updateAgentWorkload(agentId, { currentTasks: -1 });
        await this.recordTaskCompletion(agentId, taskId, false);
      }
      return true;
    }
    return false;
  }

  async reportBlocker(taskId: string, blocker: Omit<TaskBlocker, 'id' | 'taskId' | 'createdAt'>): Promise<string> {
    const id = this.generateId();
    const now = new Date();
    
    const blockerData: TaskBlocker = {
      id,
      taskId,
      ...blocker,
      createdAt: now
    };

    this.db.prepare(`
      INSERT INTO task_blockers (
        id, task_id, blocker_type, title, description, severity, status,
        reported_by_type, reported_by_id, reported_by_name, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      blockerData.id, blockerData.taskId, blockerData.blockerType, blockerData.title,
      blockerData.description, blockerData.severity, blockerData.status,
      blockerData.reportedByType, blockerData.reportedById, blockerData.reportedByName,
      blockerData.createdAt.toISOString()
    );

    // Update task status to blocked
    this.db.prepare(`
      UPDATE agent_tasks SET status = 'blocked', updated_at = ? WHERE id = ?
    `).run(now.toISOString(), taskId);

    const task = this.getTask(taskId);
    if (task) {
      this.emit('task_blocked', { type: 'task_blocked', task, blocker: blockerData });
    }

    return id;
  }

  // ── Task Queries ──

  getTask(taskId: string): AgentTask | null {
    const row = this.db.prepare(`
      SELECT * FROM agent_tasks WHERE id = ?
    `).get(taskId) as any;

    return row ? this.mapTaskFromDb(row) : null;
  }

  getTasksBySession(sessionId: string): AgentTask[] {
    const rows = this.db.prepare(`
      SELECT * FROM agent_tasks WHERE session_id = ? ORDER BY created_at DESC
    `).all(sessionId) as any[];

    return rows.map(row => this.mapTaskFromDb(row));
  }

  getTasksByAgent(agentId: string): AgentTask[] {
    const rows = this.db.prepare(`
      SELECT * FROM agent_tasks WHERE assignee_id = ? ORDER BY created_at DESC
    `).all(agentId) as any[];

    return rows.map(row => this.mapTaskFromDb(row));
  }

  getTasksByStatus(status: AgentTask['status']): AgentTask[] {
    const rows = this.db.prepare(`
      SELECT * FROM agent_tasks WHERE status = ? ORDER BY created_at DESC
    `).all(status) as any[];

    return rows.map(row => this.mapTaskFromDb(row));
  }

  // ── Comments ──

  async addTaskComment(
    taskId: string, 
    authorType: 'human' | 'agent', 
    authorId: string, 
    authorName: string, 
    content: string, 
    commentType: TaskComment['commentType'] = 'comment'
  ): Promise<string> {
    const id = this.generateId();
    const now = new Date();

    this.db.prepare(`
      INSERT INTO task_comments (
        id, task_id, author_type, author_id, author_name, content, comment_type, metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, taskId, authorType, authorId, authorName, content, commentType, '{}', now.toISOString());

    return id;
  }

  getTaskComments(taskId: string): TaskComment[] {
    const rows = this.db.prepare(`
      SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at ASC
    `).all(taskId) as any[];

    return rows.map(row => ({
      id: row.id,
      taskId: row.task_id,
      authorType: row.author_type,
      authorId: row.author_id,
      authorName: row.author_name,
      content: row.content,
      commentType: row.comment_type,
      metadata: JSON.parse(row.metadata || '{}'),
      createdAt: new Date(row.created_at)
    }));
  }

  // ── Skills Management ──

  async assignSkillToAgent(agentId: string, skillId: string, proficiencyLevel: AgentSkillAssignment['proficiencyLevel'] = 'beginner'): Promise<void> {
    const now = new Date();

    this.db.prepare(`
      INSERT OR REPLACE INTO agent_skill_assignments (
        agent_id, skill_id, proficiency_level, success_rate, total_executions,
        successful_executions, avg_execution_time_ms, learned_at
      ) VALUES (?, ?, ?, 0.0, 0, 0, 0, ?)
    `).run(agentId, skillId, proficiencyLevel, now.toISOString());

    this.emit('skill_learned', { type: 'skill_learned', agentId, skillId });
  }

  getAgentSkills(agentId: string): AgentSkillAssignment[] {
    const rows = this.db.prepare(`
      SELECT asa.*, s.name as skill_name, s.description as skill_description, s.category as skill_category
      FROM agent_skill_assignments asa
      LEFT JOIN skills s ON asa.skill_id = s.id
      WHERE asa.agent_id = ?
    `).all(agentId) as any[];

    return rows.map(row => ({
      agentId: row.agent_id,
      skillId: row.skill_id,
      skillName: row.skill_name || row.skill_id,
      skillDescription: row.skill_description || '',
      skillCategory: row.skill_category || '',
      proficiencyLevel: row.proficiency_level,
      successRate: row.success_rate,
      totalExecutions: row.total_executions,
      successfulExecutions: row.successful_executions,
      avgExecutionTimeMs: row.avg_execution_time_ms,
      lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : undefined,
      learnedAt: new Date(row.learned_at)
    }));
  }

  // ── Runtime Management ──

  async registerRuntime(runtime: Omit<AgentRuntime, 'createdAt' | 'updatedAt'>): Promise<void> {
    const now = new Date();

    this.db.prepare(`
      INSERT OR REPLACE INTO agent_runtimes (
        id, name, type, status, capabilities, resources, config, last_heartbeat, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      runtime.id, runtime.name, runtime.type, runtime.status,
      JSON.stringify(runtime.capabilities), JSON.stringify(runtime.resources),
      JSON.stringify(runtime.config), runtime.lastHeartbeat?.toISOString(),
      now.toISOString(), now.toISOString()
    );

    this.emit('runtime_status_changed', { type: 'runtime_status_changed', runtime: { ...runtime, createdAt: now, updatedAt: now } });
  }

  getRuntimes(): AgentRuntime[] {
    const rows = this.db.prepare(`
      SELECT * FROM agent_runtimes ORDER BY created_at DESC
    `).all() as any[];

    return rows.map(row => ({
      id: row.id,
      name: row.name,
      type: row.type,
      status: row.status,
      capabilities: JSON.parse(row.capabilities || '[]'),
      resources: JSON.parse(row.resources || '{}'),
      config: JSON.parse(row.config || '{}'),
      lastHeartbeat: row.last_heartbeat ? new Date(row.last_heartbeat) : undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    }));
  }

  // ── Agent Workload Management ──

  private async updateAgentWorkload(agentId: string, updates: Partial<{ currentTasks: number }>): Promise<void> {
    const now = new Date();

    if (updates.currentTasks !== undefined) {
      this.db.prepare(`
        INSERT OR IGNORE INTO agent_workload (agent_id, current_tasks, max_concurrent_tasks, updated_at)
        VALUES (?, 0, 3, ?)
      `).run(agentId, now.toISOString());

      if (updates.currentTasks > 0) {
        this.db.prepare(`
          UPDATE agent_workload 
          SET current_tasks = current_tasks + ?, updated_at = ?
          WHERE agent_id = ?
        `).run(updates.currentTasks, now.toISOString(), agentId);
      } else {
        this.db.prepare(`
          UPDATE agent_workload 
          SET current_tasks = MAX(0, current_tasks + ?), updated_at = ?
          WHERE agent_id = ?
        `).run(updates.currentTasks, now.toISOString(), agentId);
      }
    }
  }

  private async recordTaskCompletion(agentId: string, taskId: string, success: boolean): Promise<void> {
    // Update workload success rate and timing
    const now = new Date();
    
    this.db.prepare(`
      UPDATE agent_workload 
      SET last_task_completed_at = ?, updated_at = ?
      WHERE agent_id = ?
    `).run(now.toISOString(), now.toISOString(), agentId);
  }

  private initializeDefaultWorkloads(): void {
    // Initialize workload entries for all agents in registry
    const now = new Date();
    
    for (const agent of AGENT_REGISTRY) {
      this.db.prepare(`
        INSERT OR IGNORE INTO agent_workload (
          agent_id, current_tasks, max_concurrent_tasks, avg_task_duration_ms,
          success_rate, status, updated_at
        ) VALUES (?, 0, 3, 0, 0.0, 'available', ?)
      `).run(agent.id, now.toISOString());
    }
  }

  // ── Utilities ──

  private mapTaskFromDb(row: any): AgentTask {
    return {
      id: row.id,
      sessionId: row.session_id,
      title: row.title,
      description: row.description,
      assigneeType: row.assignee_type,
      assigneeId: row.assignee_id,
      assigneeName: row.assignee_name,
      status: row.status,
      priority: row.priority,
      labels: JSON.parse(row.labels || '[]'),
      estimatedHours: row.estimated_hours,
      actualHours: row.actual_hours,
      progressPercentage: row.progress_percentage || 0,
      runtimeId: row.runtime_id,
      parentTaskId: row.parent_task_id,
      dependsOn: JSON.parse(row.depends_on || '[]'),
      queuedAt: new Date(row.queued_at),
      claimedAt: row.claimed_at ? new Date(row.claimed_at) : undefined,
      startedAt: row.started_at ? new Date(row.started_at) : undefined,
      completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
      failedAt: row.failed_at ? new Date(row.failed_at) : undefined,
      metadata: JSON.parse(row.metadata || '{}'),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    };
  }

  private generateId(): string {
    return Math.random().toString(36).substring(2) + Date.now().toString(36);
  }
}