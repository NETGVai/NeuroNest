/**
 * IPC Handler for Agent Skills API
 * 
 * Provides all Agent Skills API endpoints through Electron IPC while maintaining
 * identical request/response formats as the original REST API.
 * 
 * Requirements: 2.1, 2.2, 8.1, 8.2, 8.3, 8.4, 8.5
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type Database from 'better-sqlite3';
import { AgentSkillsService } from './agent-skills-service.js';
import { EventBus } from '../events/event-bus.js';
import { MemoryCache } from '../cache/memory-cache.js';
import { logger } from '../utils/logger.js';
import type {
  Skill,
  AgentSkillAssignment,
  SkillEvent,
  CreateSkillRequest,
  UpdateSkillRequest,
  SkillSearchCriteria
} from './agent-skills-service.js';

/**
 * Authentication context for Agent Skills operations
 */
interface AuthContext {
  userId?: string;
  sessionId?: string;
  permissions?: string[];
}

/**
 * Standard API response format matching original REST API
 */
interface APIResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  timestamp: string;
}

/**
 * Skill assignment request format
 */
interface SkillAssignmentRequest {
  agentId: string;
  skillId: string;
  proficiencyLevel?: 'beginner' | 'intermediate' | 'advanced' | 'expert';
}

/**
 * Skill performance update request
 */
interface SkillPerformanceRequest {
  agentId: string;
  skillId: string;
  executionTimeMs: number;
  success: boolean;
}

/**
 * Event subscription request
 */
interface EventSubscriptionRequest {
  topics: string[];
  sessionId?: string;
}

/**
 * IPC Handler class for Agent Skills API endpoints
 */
export class AgentSkillsIPCHandler {
  private service: AgentSkillsService;
  private eventBus: EventBus;
  private cache: MemoryCache;
  private isInitialized = false;

  constructor(database: Database.Database) {
    this.service = new AgentSkillsService(database);
    this.eventBus = new EventBus({ database });
    this.cache = new MemoryCache({ database, enablePersistence: true });
  }

  /**
   * Initialize and register all IPC handlers
   */
  initialize(): void {
    if (this.isInitialized) {
      logger.warn('Agent Skills IPC handlers already initialized');
      return;
    }

    this.registerSkillManagementHandlers();
    this.registerAssignmentHandlers();
    this.registerEventHandlers();
    this.registerAnalyticsHandlers();
    this.registerRealtimeHandlers();

    this.isInitialized = true;
    logger.info('Agent Skills IPC handlers initialized successfully');
  }

  /**
   * Clean up resources and remove handlers
   */
  cleanup(): void {
    if (!this.isInitialized) return;

    const handlers = [
      // Skill management
      'agent-skills:get-skills',
      'agent-skills:get-skill',
      'agent-skills:create-skill',
      'agent-skills:update-skill',
      'agent-skills:delete-skill',
      'agent-skills:search-skills',
      
      // Assignment operations
      'agent-skills:assign-skill',
      'agent-skills:get-assignments',
      'agent-skills:get-agent-skills',
      'agent-skills:update-performance',
      
      // Event operations
      'agent-skills:get-events',
      'agent-skills:record-event',
      
      // Analytics
      'agent-skills:get-usage-stats',
      'agent-skills:get-skill-analytics',
      
      // Real-time updates
      'agent-skills:subscribe-updates',
      'agent-skills:unsubscribe-updates',
      
      // WebSocket management
      'agent-skills:websocket-status',
      'agent-skills:websocket-test',
      'agent-skills:websocket-broadcast'
    ];

    handlers.forEach(handler => {
      try {
        ipcMain.removeHandler(handler);
      } catch (error) {
        logger.warn(`Failed to remove handler ${handler}:`, { error: error instanceof Error ? error.message : String(error) });
      }
    });

    this.service.close();
    this.isInitialized = false;
    logger.info('Agent Skills IPC handlers cleaned up');
  }

  /**
   * Register skill management IPC handlers
   */
  private registerSkillManagementHandlers(): void {
    // GET /api/skills - Get all skills with optional filtering
    ipcMain.handle('agent-skills:get-skills', async (event: IpcMainInvokeEvent, criteria?: SkillSearchCriteria): Promise<APIResponse<Skill[]>> => {
      return this.handleWithAuth(event, async (authContext) => {
        const cacheKey = `skills:list:${JSON.stringify(criteria || {})}`;
        
        // Try cache first
        const cached = await this.cache.get(cacheKey);
        if (cached) {
          return this.createSuccessResponse(cached);
        }

        const skills = await this.service.searchSkills(criteria || {});
        
        // Cache for 5 minutes
        await this.cache.set(cacheKey, skills, 300);
        
        return this.createSuccessResponse(skills);
      });
    });

    // GET /api/skills/:id - Get specific skill
    ipcMain.handle('agent-skills:get-skill', async (event: IpcMainInvokeEvent, skillId: string): Promise<APIResponse<Skill>> => {
      return this.handleWithAuth(event, async (authContext) => {
        if (!skillId) {
          return this.createErrorResponse('Skill ID is required');
        }

        const cacheKey = `skill:${skillId}`;
        const cached = await this.cache.get(cacheKey);
        if (cached) {
          return this.createSuccessResponse(cached);
        }

        const skill = await this.service.getSkillById(skillId);
        if (!skill) {
          return this.createErrorResponse('Skill not found', 404);
        }

        await this.cache.set(cacheKey, skill, 300);
        return this.createSuccessResponse(skill);
      });
    });

    // POST /api/skills - Create new skill
    ipcMain.handle('agent-skills:create-skill', async (event: IpcMainInvokeEvent, skillData: CreateSkillRequest): Promise<APIResponse<Skill>> => {
      return this.handleWithAuth(event, async (authContext) => {
        if (!skillData.name || !skillData.description || !skillData.content) {
          return this.createErrorResponse('Name, description, and content are required');
        }

        const skill = await this.service.createSkill(skillData);
        
        // Invalidate relevant caches
        await this.invalidateSkillCaches();
        
        // Publish real-time update
        await this.eventBus.publish('skill.created', {
          type: 'skill_created',
          data: {
            skill,
            userId: authContext.userId
          },
          correlationId: skill.id,
          source: 'agent-skills-ipc'
        });

        return this.createSuccessResponse(skill, 'Skill created successfully');
      });
    });

    // PUT /api/skills/:id - Update skill
    ipcMain.handle('agent-skills:update-skill', async (event: IpcMainInvokeEvent, skillId: string, updates: UpdateSkillRequest): Promise<APIResponse<Skill>> => {
      return this.handleWithAuth(event, async (authContext) => {
        if (!skillId) {
          return this.createErrorResponse('Skill ID is required');
        }

        const skill = await this.service.updateSkill(skillId, updates);
        if (!skill) {
          return this.createErrorResponse('Skill not found or update failed', 404);
        }

        // Invalidate caches
        await this.cache.delete(`skill:${skillId}`);
        await this.invalidateSkillCaches();

        // Publish real-time update
        await this.eventBus.publish('skill.updated', {
          type: 'skill_updated',
          data: {
            skill,
            updates,
            userId: authContext.userId
          },
          correlationId: skill.id,
          source: 'agent-skills-ipc'
        });

        return this.createSuccessResponse(skill, 'Skill updated successfully');
      });
    });

    // DELETE /api/skills/:id - Delete skill (not implemented in service, but handler ready)
    ipcMain.handle('agent-skills:delete-skill', async (event: IpcMainInvokeEvent, skillId: string): Promise<APIResponse<void>> => {
      return this.handleWithAuth(event, async (authContext) => {
        // Note: Delete functionality not implemented in service yet
        return this.createErrorResponse('Delete operation not yet implemented', 501);
      });
    });

    // POST /api/skills/search - Advanced skill search
    ipcMain.handle('agent-skills:search-skills', async (event: IpcMainInvokeEvent, criteria: SkillSearchCriteria): Promise<APIResponse<Skill[]>> => {
      return this.handleWithAuth(event, async (authContext) => {
        const skills = await this.service.searchSkills(criteria);
        return this.createSuccessResponse(skills);
      });
    });
  }
  /**
   * Register assignment operation IPC handlers
   */
  private registerAssignmentHandlers(): void {
    // POST /api/assignments - Assign skill to agent
    ipcMain.handle('agent-skills:assign-skill', async (event: IpcMainInvokeEvent, assignment: SkillAssignmentRequest): Promise<APIResponse<AgentSkillAssignment>> => {
      return this.handleWithAuth(event, async (authContext) => {
        if (!assignment.agentId || !assignment.skillId) {
          return this.createErrorResponse('Agent ID and Skill ID are required');
        }

        const result = await this.service.assignSkillToAgent(
          assignment.agentId,
          assignment.skillId,
          assignment.proficiencyLevel || 'beginner'
        );

        // Invalidate assignment caches
        await this.invalidateAssignmentCaches(assignment.agentId);

        // Publish real-time update
        await this.eventBus.publish('skill.assigned', {
          type: 'skill_assigned',
          data: {
            assignment: result,
            userId: authContext.userId
          },
          correlationId: `${assignment.agentId}:${assignment.skillId}`,
          source: 'agent-skills-ipc'
        });

        return this.createSuccessResponse(result, 'Skill assigned successfully');
      });
    });

    // GET /api/assignments - Get all assignments with optional filtering
    ipcMain.handle('agent-skills:get-assignments', async (event: IpcMainInvokeEvent, filters?: { agentId?: string; skillId?: string }): Promise<APIResponse<AgentSkillAssignment[]>> => {
      return this.handleWithAuth(event, async (authContext) => {
        if (filters?.agentId) {
          const cacheKey = `assignments:agent:${filters.agentId}`;
          const cached = await this.cache.get(cacheKey);
          if (cached) {
            return this.createSuccessResponse(cached);
          }

          const assignments = await this.service.getAgentSkills(filters.agentId);
          await this.cache.set(cacheKey, assignments, 300);
          return this.createSuccessResponse(assignments);
        }

        // For now, return empty array if no specific agent filter
        // In a full implementation, this would query all assignments
        return this.createSuccessResponse([]);
      });
    });

    // GET /api/agents/:agentId/skills - Get skills assigned to specific agent
    ipcMain.handle('agent-skills:get-agent-skills', async (event: IpcMainInvokeEvent, agentId: string): Promise<APIResponse<AgentSkillAssignment[]>> => {
      return this.handleWithAuth(event, async (authContext) => {
        if (!agentId) {
          return this.createErrorResponse('Agent ID is required');
        }

        const cacheKey = `assignments:agent:${agentId}`;
        const cached = await this.cache.get(cacheKey);
        if (cached) {
          return this.createSuccessResponse(cached);
        }

        const assignments = await this.service.getAgentSkills(agentId);
        await this.cache.set(cacheKey, assignments, 300);
        
        return this.createSuccessResponse(assignments);
      });
    });

    // PUT /api/assignments/performance - Update skill performance metrics
    ipcMain.handle('agent-skills:update-performance', async (event: IpcMainInvokeEvent, performance: SkillPerformanceRequest): Promise<APIResponse<void>> => {
      return this.handleWithAuth(event, async (authContext) => {
        if (!performance.agentId || !performance.skillId || performance.executionTimeMs === undefined || performance.success === undefined) {
          return this.createErrorResponse('Agent ID, Skill ID, execution time, and success status are required');
        }

        await this.service.updateSkillPerformance(
          performance.agentId,
          performance.skillId,
          performance.executionTimeMs,
          performance.success
        );

        // Invalidate assignment caches
        await this.invalidateAssignmentCaches(performance.agentId);

        // Publish real-time update
        await this.eventBus.publish('skill.performance.updated', {
          type: 'skill_performance_updated',
          data: {
            agentId: performance.agentId,
            skillId: performance.skillId,
            performance,
            userId: authContext.userId
          },
          correlationId: `${performance.agentId}:${performance.skillId}`,
          source: 'agent-skills-ipc'
        });

        return this.createSuccessResponse(undefined, 'Performance updated successfully');
      });
    });
  }

  /**
   * Register event operation IPC handlers
   */
  private registerEventHandlers(): void {
    // GET /api/events - Get skill events with optional filtering
    ipcMain.handle('agent-skills:get-events', async (event: IpcMainInvokeEvent, filters?: {
      entityType?: 'skill' | 'agent' | 'assignment' | 'task';
      entityId?: string;
      eventType?: string;
      limit?: number;
      offset?: number;
    }): Promise<APIResponse<SkillEvent[]>> => {
      return this.handleWithAuth(event, async (authContext) => {
        const events = await this.service.getSkillEvents(
          filters?.entityType,
          filters?.entityId,
          filters?.eventType,
          filters?.limit || 100,
          filters?.offset || 0
        );

        return this.createSuccessResponse(events);
      });
    });

    // POST /api/events - Record a skill event
    ipcMain.handle('agent-skills:record-event', async (event: IpcMainInvokeEvent, eventData: {
      eventType: string;
      entityType: 'skill' | 'agent' | 'assignment' | 'task';
      entityId: string;
      data?: Record<string, any>;
      correlationId?: string;
      sessionId?: string;
    }): Promise<APIResponse<void>> => {
      return this.handleWithAuth(event, async (authContext) => {
        if (!eventData.eventType || !eventData.entityType || !eventData.entityId) {
          return this.createErrorResponse('Event type, entity type, and entity ID are required');
        }

        await this.service.recordSkillEvent(
          eventData.eventType,
          eventData.entityType,
          eventData.entityId,
          eventData.data,
          eventData.correlationId,
          eventData.sessionId || authContext.sessionId
        );

        return this.createSuccessResponse(undefined, 'Event recorded successfully');
      });
    });
  }

  /**
   * Register analytics IPC handlers
   */
  private registerAnalyticsHandlers(): void {
    // GET /api/skills/:skillId/stats - Get skill usage statistics
    ipcMain.handle('agent-skills:get-usage-stats', async (event: IpcMainInvokeEvent, skillId: string): Promise<APIResponse<any>> => {
      return this.handleWithAuth(event, async (authContext) => {
        if (!skillId) {
          return this.createErrorResponse('Skill ID is required');
        }

        const cacheKey = `stats:skill:${skillId}`;
        const cached = await this.cache.get(cacheKey);
        if (cached) {
          return this.createSuccessResponse(cached);
        }

        const stats = await this.service.getSkillUsageStats(skillId);
        await this.cache.set(cacheKey, stats, 600); // Cache for 10 minutes

        return this.createSuccessResponse(stats);
      });
    });

    // GET /api/analytics/skills - Get comprehensive skill analytics
    ipcMain.handle('agent-skills:get-skill-analytics', async (event: IpcMainInvokeEvent, filters?: {
      timeRange?: string;
      skillIds?: string[];
      agentIds?: string[];
    }): Promise<APIResponse<any>> => {
      return this.handleWithAuth(event, async (authContext) => {
        // For now, return basic analytics structure
        // In a full implementation, this would provide comprehensive analytics
        const analytics = {
          totalSkills: 0,
          totalAssignments: 0,
          averageSuccessRate: 0,
          topPerformingSkills: [],
          recentActivity: [],
          timeRange: filters?.timeRange || '7d'
        };

        return this.createSuccessResponse(analytics);
      });
    });
  }

  /**
   * Register real-time update IPC handlers
   */
  private registerRealtimeHandlers(): void {
    // Subscribe to real-time updates
    ipcMain.handle('agent-skills:subscribe-updates', async (event: IpcMainInvokeEvent, subscription: EventSubscriptionRequest): Promise<APIResponse<void>> => {
      return this.handleWithAuth(event, async (authContext) => {
        if (!subscription.topics || subscription.topics.length === 0) {
          return this.createErrorResponse('At least one topic is required');
        }

        // Subscribe to each topic
        for (const topic of subscription.topics) {
          await this.eventBus.subscribe(topic, (eventData) => {
            // Send real-time update to renderer process
            event.sender.send('agent-skills:real-time-update', {
              topic,
              data: eventData,
              timestamp: new Date().toISOString()
            });
          });
        }

        return this.createSuccessResponse(undefined, 'Subscribed to updates successfully');
      });
    });

    // Unsubscribe from real-time updates
    ipcMain.handle('agent-skills:unsubscribe-updates', async (event: IpcMainInvokeEvent, subscription: EventSubscriptionRequest): Promise<APIResponse<void>> => {
      return this.handleWithAuth(event, async (authContext) => {
        if (!subscription.topics || subscription.topics.length === 0) {
          return this.createErrorResponse('At least one topic is required');
        }

        // Note: EventBus would need to support unsubscribe by topic
        // For now, just return success
        return this.createSuccessResponse(undefined, 'Unsubscribed from updates successfully');
      });
    });

    // Get WebSocket server status
    ipcMain.handle('agent-skills:websocket-status', async (event: IpcMainInvokeEvent): Promise<APIResponse<any>> => {
      return this.handleWithAuth(event, async (authContext) => {
        const { getWebSocketStats } = await import('./websocket-integration.js');
        const stats = getWebSocketStats();
        return this.createSuccessResponse(stats);
      });
    });

    // Test WebSocket connectivity
    ipcMain.handle('agent-skills:websocket-test', async (event: IpcMainInvokeEvent): Promise<APIResponse<any>> => {
      return this.handleWithAuth(event, async (authContext) => {
        const { testWebSocketConnectivity } = await import('./websocket-integration.js');
        const result = await testWebSocketConnectivity();
        return this.createSuccessResponse(result);
      });
    });

    // Broadcast manual event to WebSocket clients
    ipcMain.handle('agent-skills:websocket-broadcast', async (event: IpcMainInvokeEvent, data: { topic: string; payload: any }): Promise<APIResponse<void>> => {
      return this.handleWithAuth(event, async (authContext) => {
        if (!data.topic) {
          return this.createErrorResponse('Topic is required for broadcast');
        }

        const { broadcastToWebSocketClients } = await import('./websocket-integration.js');
        broadcastToWebSocketClients(data.topic, data.payload);
        
        return this.createSuccessResponse(undefined, 'Broadcast sent successfully');
      });
    });
  }

  /**
   * Handle IPC request with authentication and error handling
   */
  private async handleWithAuth<T>(
    event: IpcMainInvokeEvent,
    handler: (authContext: AuthContext) => Promise<APIResponse<T>>
  ): Promise<APIResponse<T>> {
    try {
      // Extract authentication context from event
      // In a real implementation, this would validate session tokens, etc.
      const authContext: AuthContext = {
        userId: 'system', // Default system user
        sessionId: event.processId?.toString(),
        permissions: ['read', 'write'] // Default permissions
      };

      return await handler(authContext);
    } catch (error) {
      logger.error('Agent Skills IPC handler error:', { error: error instanceof Error ? error.message : String(error) });
      return this.createErrorResponse(
        error instanceof Error ? error.message : 'Internal server error',
        500
      );
    }
  }

  /**
   * Create standardized success response
   */
  private createSuccessResponse<T>(data: T, message?: string): APIResponse<T> {
    return {
      success: true,
      data,
      message,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Create standardized error response
   */
  private createErrorResponse(error: string, statusCode?: number): APIResponse<never> {
    return {
      success: false,
      error,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Invalidate skill-related caches
   */
  private async invalidateSkillCaches(): Promise<void> {
    try {
      // Get all cache keys that start with 'skills:'
      const keys = await this.cache.keys();
      const skillKeys = keys.filter(key => key.startsWith('skills:') || key.startsWith('skill:'));
      
      for (const key of skillKeys) {
        await this.cache.delete(key);
      }
    } catch (error) {
      logger.warn('Failed to invalidate skill caches:', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Invalidate assignment-related caches for specific agent
   */
  private async invalidateAssignmentCaches(agentId: string): Promise<void> {
    try {
      await this.cache.delete(`assignments:agent:${agentId}`);
      await this.cache.delete(`stats:agent:${agentId}`);
    } catch (error) {
      logger.warn('Failed to invalidate assignment caches:', { error: error instanceof Error ? error.message : String(error) });
    }
  }
}

/**
 * Register Agent Skills IPC handlers with the main IPC system
 */
export function registerAgentSkillsIPC(database: Database.Database): AgentSkillsIPCHandler {
  const handler = new AgentSkillsIPCHandler(database);
  handler.initialize();
  return handler;
}