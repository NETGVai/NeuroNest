/**
 * Integration Example: Using SQLite Adapter with NeuroNest Database
 * 
 * This example demonstrates how to integrate the Agent Skills system
 * with the existing NeuroNest SQLite database.
 */

import { initDatabase } from '../storage/database.js';
import { AgentSkillsService } from './agent-skills-service.js';

/**
 * Example: Initialize Agent Skills with existing NeuroNest database
 */
export async function initializeAgentSkills() {
  // Initialize the existing NeuroNest database (includes all migrations)
  const db = initDatabase();
  
  // Create the Agent Skills service using the existing database
  const agentSkillsService = new AgentSkillsService(db);
  
  return {
    database: db,
    agentSkillsService
  };
}

/**
 * Example: Create a skill using the integrated service
 */
export async function createExampleSkill(agentSkillsService: AgentSkillsService) {
  const skill = await agentSkillsService.createSkill({
    name: 'Code Review Assistant',
    description: 'Assists with code review tasks and provides feedback',
    category: 'development',
    tags: ['code-review', 'quality-assurance', 'development'],
    scope: 'workspace',
    content: `
      // Code review assistant skill
      function reviewCode(code, language) {
        // Analyze code for common issues
        const issues = [];
        
        // Check for basic syntax and style issues
        if (code.includes('var ')) {
          issues.push('Consider using let or const instead of var');
        }
        
        return {
          issues,
          score: issues.length === 0 ? 100 : Math.max(0, 100 - issues.length * 10)
        };
      }
      
      module.exports = { reviewCode };
    `,
    metadata: {
      difficulty: 'intermediate',
      estimatedTime: '5-10 minutes',
      prerequisites: ['javascript', 'code-analysis']
    }
  });
  
  console.log('Created skill:', skill.name, 'with ID:', skill.id);
  return skill;
}

/**
 * Example: Assign skill to an agent and track performance
 */
export async function assignSkillToAgent(
  agentSkillsService: AgentSkillsService,
  skillId: string,
  agentId: string
) {
  // Assign the skill to an agent
  const assignment = await agentSkillsService.assignSkillToAgent(
    agentId,
    skillId,
    'intermediate'
  );
  
  console.log('Assigned skill to agent:', assignment);
  
  // Simulate skill usage and update performance
  await agentSkillsService.updateSkillPerformance(
    agentId,
    skillId,
    2500, // execution time in ms
    true  // success
  );
  
  // Get updated assignment with performance metrics
  const updatedAssignment = await agentSkillsService.getAgentSkillAssignment(agentId, skillId);
  console.log('Updated assignment with performance:', updatedAssignment);
  
  return updatedAssignment;
}

/**
 * Example: Search and analyze skills
 */
export async function analyzeSkills(agentSkillsService: AgentSkillsService) {
  // Search for development-related skills
  const devSkills = await agentSkillsService.searchSkills({
    category: 'development',
    limit: 10
  });
  
  console.log('Found', devSkills.length, 'development skills');
  
  // Get usage statistics for each skill
  for (const skill of devSkills) {
    const stats = await agentSkillsService.getSkillUsageStats(skill.id);
    console.log(`Skill "${skill.name}":`, {
      totalAgents: stats.totalAgents,
      expertAgents: stats.expertAgents,
      averageSuccessRate: stats.averageSuccessRate,
      totalExecutions: stats.totalExecutions
    });
  }
  
  return devSkills;
}

/**
 * Example: Monitor skill events
 */
export async function monitorSkillEvents(agentSkillsService: AgentSkillsService) {
  // Get recent skill events
  const recentEvents = await agentSkillsService.getSkillEvents(
    undefined, // all entity types
    undefined, // all entities
    undefined, // all event types
    20,        // limit
    0          // offset
  );
  
  console.log('Recent skill events:');
  recentEvents.forEach(event => {
    console.log(`- ${event.event_type} for ${event.entity_type} ${event.entity_id} at ${event.timestamp}`);
  });
  
  return recentEvents;
}

/**
 * Complete example workflow
 */
export async function runCompleteExample() {
  console.log('🚀 Starting Agent Skills Integration Example');
  
  try {
    // Initialize the system
    const { agentSkillsService } = await initializeAgentSkills();
    console.log('✅ Agent Skills service initialized');
    
    // Create a sample skill
    const skill = await createExampleSkill(agentSkillsService);
    console.log('✅ Sample skill created');
    
    // Assign skill to an agent
    const agentId = 'example-agent-001';
    await assignSkillToAgent(agentSkillsService, skill.id, agentId);
    console.log('✅ Skill assigned to agent');
    
    // Analyze skills
    await analyzeSkills(agentSkillsService);
    console.log('✅ Skills analysis completed');
    
    // Monitor events
    await monitorSkillEvents(agentSkillsService);
    console.log('✅ Event monitoring completed');
    
    // Clean up
    agentSkillsService.close();
    console.log('✅ Agent Skills service closed');
    
    console.log('🎉 Example completed successfully!');
    
  } catch (error) {
    console.error('❌ Example failed:', error);
    throw error;
  }
}

// Export for use in other modules
export default {
  initializeAgentSkills,
  createExampleSkill,
  assignSkillToAgent,
  analyzeSkills,
  monitorSkillEvents,
  runCompleteExample
};