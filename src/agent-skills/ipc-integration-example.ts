/**
 * Integration example for Agent Skills IPC handlers
 * 
 * Demonstrates how to use the Agent Skills API through IPC channels
 * from the renderer process.
 */

import { ipcRenderer } from 'electron';

/**
 * Example usage of Agent Skills IPC API from renderer process
 */
export class AgentSkillsIPCClient {
  
  /**
   * Get all skills with optional filtering
   */
  async getSkills(criteria?: {
    query?: string;
    category?: string;
    tags?: string[];
    scope?: string;
    enabled?: boolean;
    limit?: number;
    offset?: number;
  }) {
    return await ipcRenderer.invoke('agent-skills:get-skills', criteria);
  }

  /**
   * Get a specific skill by ID
   */
  async getSkill(skillId: string) {
    return await ipcRenderer.invoke('agent-skills:get-skill', skillId);
  }

  /**
   * Create a new skill
   */
  async createSkill(skillData: {
    name: string;
    description: string;
    category?: string;
    tags?: string[];
    scope?: 'global' | 'workspace' | 'project' | 'agent';
    content: string;
    metadata?: Record<string, any>;
  }) {
    return await ipcRenderer.invoke('agent-skills:create-skill', skillData);
  }

  /**
   * Update an existing skill
   */
  async updateSkill(skillId: string, updates: {
    name?: string;
    description?: string;
    category?: string;
    tags?: string[];
    enabled?: boolean;
    content?: string;
    metadata?: Record<string, any>;
  }) {
    return await ipcRenderer.invoke('agent-skills:update-skill', skillId, updates);
  }

  /**
   * Assign a skill to an agent
   */
  async assignSkill(assignment: {
    agentId: string;
    skillId: string;
    proficiencyLevel?: 'beginner' | 'intermediate' | 'advanced' | 'expert';
  }) {
    return await ipcRenderer.invoke('agent-skills:assign-skill', assignment);
  }

  /**
   * Get all skills assigned to an agent
   */
  async getAgentSkills(agentId: string) {
    return await ipcRenderer.invoke('agent-skills:get-agent-skills', agentId);
  }

  /**
   * Update skill performance metrics
   */
  async updatePerformance(performance: {
    agentId: string;
    skillId: string;
    executionTimeMs: number;
    success: boolean;
  }) {
    return await ipcRenderer.invoke('agent-skills:update-performance', performance);
  }

  /**
   * Get skill events with optional filtering
   */
  async getEvents(filters?: {
    entityType?: 'skill' | 'agent' | 'assignment' | 'task';
    entityId?: string;
    eventType?: string;
    limit?: number;
    offset?: number;
  }) {
    return await ipcRenderer.invoke('agent-skills:get-events', filters);
  }

  /**
   * Record a skill event
   */
  async recordEvent(eventData: {
    eventType: string;
    entityType: 'skill' | 'agent' | 'assignment' | 'task';
    entityId: string;
    data?: Record<string, any>;
    correlationId?: string;
    sessionId?: string;
  }) {
    return await ipcRenderer.invoke('agent-skills:record-event', eventData);
  }

  /**
   * Get skill usage statistics
   */
  async getUsageStats(skillId: string) {
    return await ipcRenderer.invoke('agent-skills:get-usage-stats', skillId);
  }

  /**
   * Get comprehensive skill analytics
   */
  async getSkillAnalytics(filters?: {
    timeRange?: string;
    skillIds?: string[];
    agentIds?: string[];
  }) {
    return await ipcRenderer.invoke('agent-skills:get-skill-analytics', filters);
  }

  /**
   * Subscribe to real-time updates
   */
  async subscribeUpdates(topics: string[]) {
    return await ipcRenderer.invoke('agent-skills:subscribe-updates', { topics });
  }

  /**
   * Unsubscribe from real-time updates
   */
  async unsubscribeUpdates(topics: string[]) {
    return await ipcRenderer.invoke('agent-skills:unsubscribe-updates', { topics });
  }

  /**
   * Listen for real-time updates
   */
  onRealtimeUpdate(callback: (update: {
    topic: string;
    data: any;
    timestamp: string;
  }) => void) {
    ipcRenderer.on('agent-skills:real-time-update', (event, update) => {
      callback(update);
    });
  }

  /**
   * Remove real-time update listener
   */
  removeRealtimeUpdateListener() {
    ipcRenderer.removeAllListeners('agent-skills:real-time-update');
  }
}

/**
 * Example usage scenarios
 */
export async function demonstrateAgentSkillsAPI() {
  const client = new AgentSkillsIPCClient();

  try {
    console.log('=== Agent Skills IPC API Demo ===');

    // 1. Create a new skill
    console.log('\n1. Creating a new skill...');
    const createResult = await client.createSkill({
      name: 'Data Analysis',
      description: 'Advanced data analysis and visualization capabilities',
      category: 'analytics',
      tags: ['data', 'analysis', 'visualization'],
      scope: 'project',
      content: 'Skill implementation content here...',
      metadata: {
        difficulty: 'intermediate',
        estimatedTime: '2-4 hours'
      }
    });

    if (createResult.success) {
      console.log('✓ Skill created:', createResult.data.name);
      const skillId = createResult.data.id;

      // 2. Assign skill to an agent
      console.log('\n2. Assigning skill to agent...');
      const assignResult = await client.assignSkill({
        agentId: 'agent-001',
        skillId: skillId,
        proficiencyLevel: 'intermediate'
      });

      if (assignResult.success) {
        console.log('✓ Skill assigned to agent');

        // 3. Update performance metrics
        console.log('\n3. Updating performance metrics...');
        const perfResult = await client.updatePerformance({
          agentId: 'agent-001',
          skillId: skillId,
          executionTimeMs: 1500,
          success: true
        });

        if (perfResult.success) {
          console.log('✓ Performance metrics updated');
        }

        // 4. Get agent skills
        console.log('\n4. Getting agent skills...');
        const agentSkillsResult = await client.getAgentSkills('agent-001');
        if (agentSkillsResult.success) {
          console.log(`✓ Agent has ${agentSkillsResult.data.length} skills`);
        }

        // 5. Get usage statistics
        console.log('\n5. Getting usage statistics...');
        const statsResult = await client.getUsageStats(skillId);
        if (statsResult.success) {
          console.log('✓ Usage stats:', {
            totalAgents: statsResult.data.totalAgents,
            averageSuccessRate: statsResult.data.averageSuccessRate
          });
        }
      }
    }

    // 6. Search skills
    console.log('\n6. Searching skills...');
    const searchResult = await client.getSkills({
      category: 'analytics',
      enabled: true,
      limit: 10
    });

    if (searchResult.success) {
      console.log(`✓ Found ${searchResult.data.length} analytics skills`);
    }

    // 7. Subscribe to real-time updates
    console.log('\n7. Setting up real-time updates...');
    const subscribeResult = await client.subscribeUpdates([
      'skill.created',
      'skill.updated',
      'skill.assigned'
    ]);

    if (subscribeResult.success) {
      console.log('✓ Subscribed to real-time updates');

      // Listen for updates
      client.onRealtimeUpdate((update) => {
        console.log(`📡 Real-time update: ${update.topic}`, update.data);
      });
    }

    console.log('\n=== Demo completed successfully ===');

  } catch (error) {
    console.error('❌ Demo failed:', error);
  }
}

/**
 * Error handling example
 */
export async function demonstrateErrorHandling() {
  const client = new AgentSkillsIPCClient();

  console.log('\n=== Error Handling Demo ===');

  // Try to get a non-existent skill
  const result = await client.getSkill('non-existent-skill-id');
  
  if (!result.success) {
    console.log('✓ Error handled gracefully:', result.error);
  }

  // Try to create a skill with missing required fields
  const invalidResult = await client.createSkill({
    name: '', // Invalid: empty name
    description: '', // Invalid: empty description
    content: '' // Invalid: empty content
  });

  if (!invalidResult.success) {
    console.log('✓ Validation error handled:', invalidResult.error);
  }

  console.log('=== Error handling demo completed ===');
}

/**
 * Performance monitoring example
 */
export async function demonstratePerformanceMonitoring() {
  const client = new AgentSkillsIPCClient();

  console.log('\n=== Performance Monitoring Demo ===');

  // Measure API response times
  const startTime = Date.now();
  
  const result = await client.getSkills({ limit: 100 });
  
  const responseTime = Date.now() - startTime;
  
  if (result.success) {
    console.log(`✓ Retrieved ${result.data.length} skills in ${responseTime}ms`);
  }

  // Monitor cache performance by making repeated requests
  console.log('\nTesting cache performance...');
  
  const skillId = 'test-skill-id';
  
  // First request (cache miss)
  const start1 = Date.now();
  await client.getSkill(skillId);
  const time1 = Date.now() - start1;
  
  // Second request (cache hit)
  const start2 = Date.now();
  await client.getSkill(skillId);
  const time2 = Date.now() - start2;
  
  console.log(`First request: ${time1}ms, Second request: ${time2}ms`);
  console.log(`Cache improvement: ${Math.round((time1 - time2) / time1 * 100)}%`);

  console.log('=== Performance monitoring demo completed ===');
}