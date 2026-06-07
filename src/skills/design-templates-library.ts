// Design Templates Library: template recommendation, usage tracking, customization
// Requirements: 4.1, 4.2, 4.3, 4.4, 4.5

import type Database from 'better-sqlite3';
import { SkillRegistry } from './skill-registry.js';
import { routeTask } from './skill-router.js';
import type { SkillDefinition } from './skill-metadata-parser.js';

export interface DesignTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  designStyle?: string;
  industry?: string;
  colorScheme?: string[];
  tags: string[];
  content: string;
  previewHtml?: string;
  metadata: Record<string, unknown>;
  version: string;
  createdAt: string;
  updatedAt: string;
}

export interface TemplateRecommendation {
  template: DesignTemplate;
  relevanceScore: number;
  reasoning: string;
  matchedCriteria: string[];
}

export interface TemplateUsageEvent {
  id: string;
  templateId: string;
  agentId: string;
  projectId: string;
  taskContext: string;
  usageType: 'recommendation' | 'manual_selection' | 'customization';
  timestamp: Date;
  skillDemonstrated: string[];
  customizations?: Record<string, unknown>;
}

export interface TaskContext {
  prompt: string;
  projectId: string;
  agentId?: string;
  filePaths?: string[];
  language?: string;
  projectMetadata?: Record<string, unknown>;
  designRequirements?: {
    style?: string;
    industry?: string;
    colorScheme?: string[];
    components?: string[];
  };
}

export class DesignTemplatesLibrary {
  private db: Database.Database;
  private registry: SkillRegistry;

  constructor(db: Database.Database) {
    this.db = db;
    this.registry = new SkillRegistry(db);
    this.initializeUsageTracking();
  }

  /**
   * Initialize database tables for template usage tracking
   */
  private initializeUsageTracking(): void {
    // Create template usage events table if it doesn't exist
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS template_usage_events (
        id TEXT PRIMARY KEY,
        template_id TEXT NOT NULL,
        agent_id TEXT,
        project_id TEXT NOT NULL,
        task_context TEXT NOT NULL,
        usage_type TEXT NOT NULL CHECK (usage_type IN ('recommendation', 'manual_selection', 'customization')),
        timestamp TEXT NOT NULL,
        skills_demonstrated TEXT NOT NULL, -- JSON array
        customizations TEXT, -- JSON object
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create index for efficient querying
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_template_usage_template_id ON template_usage_events(template_id);
      CREATE INDEX IF NOT EXISTS idx_template_usage_agent_id ON template_usage_events(agent_id);
      CREATE INDEX IF NOT EXISTS idx_template_usage_project_id ON template_usage_events(project_id);
    `);
  }

  /**
   * Get all available design templates
   */
  getTemplates(): DesignTemplate[] {
    const skills = this.registry.list({ 
      category: 'design-template', 
      enabled: true, 
      installed: true 
    });

    return skills.map(this.skillToTemplate);
  }

  /**
   * Get a specific template by ID
   */
  getTemplate(templateId: string): DesignTemplate | null {
    const skill = this.registry.get(templateId);
    if (!skill || skill.category !== 'design-template') {
      return null;
    }
    return this.skillToTemplate(skill);
  }

  /**
   * Recommend relevant design templates based on task context
   * Requirements: 4.1, 4.2
   */
  recommendTemplates(context: TaskContext, maxRecommendations: number = 5): TemplateRecommendation[] {
    const templates = this.getTemplates();
    const recommendations: TemplateRecommendation[] = [];

    for (const template of templates) {
      const recommendation = this.scoreTemplateRelevance(template, context);
      if (recommendation.relevanceScore > 0.1) { // Minimum threshold
        recommendations.push(recommendation);
      }
    }

    // Sort by relevance score descending
    recommendations.sort((a, b) => b.relevanceScore - a.relevanceScore);

    return recommendations.slice(0, maxRecommendations);
  }

  /**
   * Score template relevance based on task context
   * Requirements: 4.1, 4.2, 4.3
   */
  private scoreTemplateRelevance(template: DesignTemplate, context: TaskContext): TemplateRecommendation {
    let score = 0;
    const matchedCriteria: string[] = [];
    const reasoning: string[] = [];

    // Score based on design requirements match (40% weight)
    if (context.designRequirements) {
      const designScore = this.scoreDesignRequirements(template, context.designRequirements);
      score += designScore.score * 0.4;
      matchedCriteria.push(...designScore.criteria);
      reasoning.push(...designScore.reasoning);
    }

    // Score based on keyword matching in prompt (30% weight)
    const keywordScore = this.scoreKeywordMatch(template, context.prompt);
    score += keywordScore.score * 0.3;
    matchedCriteria.push(...keywordScore.criteria);
    reasoning.push(...keywordScore.reasoning);

    // Score based on historical usage success (20% weight)
    const historyScore = this.scoreHistoricalUsage(template.id, context.projectId);
    score += historyScore * 0.2;
    if (historyScore > 0.5) {
      matchedCriteria.push('historical_success');
      reasoning.push('Template has been successfully used in similar contexts');
    }

    // Score based on template metadata confidence (10% weight)
    const confidenceScore = typeof template.metadata.confidence === 'number' 
      ? Math.max(0, Math.min(1, template.metadata.confidence))
      : 0.5;
    score += confidenceScore * 0.1;

    return {
      template,
      relevanceScore: Math.max(0, Math.min(1, score)),
      reasoning: reasoning.join('; '),
      matchedCriteria
    };
  }

  /**
   * Score template based on design requirements
   */
  private scoreDesignRequirements(
    template: DesignTemplate, 
    requirements: NonNullable<TaskContext['designRequirements']>
  ): { score: number; criteria: string[]; reasoning: string[] } {
    let score = 0;
    const criteria: string[] = [];
    const reasoning: string[] = [];

    // Style matching
    if (requirements.style && template.designStyle) {
      if (template.designStyle.toLowerCase().includes(requirements.style.toLowerCase()) ||
          requirements.style.toLowerCase().includes(template.designStyle.toLowerCase())) {
        score += 0.4;
        criteria.push('design_style');
        reasoning.push(`Style match: ${template.designStyle}`);
      }
    }

    // Industry matching
    if (requirements.industry && template.industry) {
      if (template.industry.toLowerCase().includes(requirements.industry.toLowerCase()) ||
          requirements.industry.toLowerCase().includes(template.industry.toLowerCase())) {
        score += 0.3;
        criteria.push('industry');
        reasoning.push(`Industry match: ${template.industry}`);
      }
    }

    // Color scheme matching
    if (requirements.colorScheme && template.colorScheme) {
      const commonColors = requirements.colorScheme.filter(color =>
        template.colorScheme!.some(templateColor =>
          templateColor.toLowerCase().includes(color.toLowerCase()) ||
          color.toLowerCase().includes(templateColor.toLowerCase())
        )
      );
      if (commonColors.length > 0) {
        score += 0.3 * (commonColors.length / Math.max(requirements.colorScheme.length, template.colorScheme.length));
        criteria.push('color_scheme');
        reasoning.push(`Color scheme match: ${commonColors.join(', ')}`);
      }
    }

    return { score: Math.max(0, Math.min(1, score)), criteria, reasoning };
  }

  /**
   * Score template based on keyword matching
   */
  private scoreKeywordMatch(template: DesignTemplate, prompt: string): { score: number; criteria: string[]; reasoning: string[] } {
    const promptTokens = this.tokenize(prompt);
    const templateTokens = new Set([
      ...this.tokenize(template.name),
      ...this.tokenize(template.description),
      ...template.tags.flatMap(tag => this.tokenize(tag))
    ]);

    let matches = 0;
    const matchedTerms: string[] = [];

    for (const token of promptTokens) {
      for (const templateToken of templateTokens) {
        if (templateToken.includes(token) || token.includes(templateToken)) {
          matches++;
          matchedTerms.push(token);
          break;
        }
      }
    }

    const score = promptTokens.length > 0 ? matches / promptTokens.length : 0;
    const criteria = score > 0 ? ['keyword_match'] : [];
    const reasoning = matchedTerms.length > 0 ? [`Keyword matches: ${matchedTerms.join(', ')}`] : [];

    return { score, criteria, reasoning };
  }

  /**
   * Score template based on historical usage success
   */
  private scoreHistoricalUsage(templateId: string, projectId: string): number {
    try {
      const row = this.db.prepare(`
        SELECT COUNT(*) as total_usage
        FROM template_usage_events
        WHERE template_id = ? AND project_id = ?
      `).get(templateId, projectId) as { total_usage: number } | undefined;

      if (!row || row.total_usage === 0) return 0.5; // Neutral score for no history

      // Simple scoring: more usage = higher score, capped at 1.0
      return Math.min(1.0, 0.5 + (row.total_usage * 0.1));
    } catch {
      return 0.5; // Default on error
    }
  }

  /**
   * Record template usage for skill demonstration
   * Requirements: 4.3
   */
  recordTemplateUsage(event: Omit<TemplateUsageEvent, 'id' | 'timestamp'>): string {
    const eventId = `usage_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const timestamp = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO template_usage_events (
        id, template_id, agent_id, project_id, task_context, usage_type,
        timestamp, skills_demonstrated, customizations, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      event.templateId,
      event.agentId || null,
      event.projectId,
      event.taskContext,
      event.usageType,
      timestamp,
      JSON.stringify(event.skillDemonstrated),
      event.customizations ? JSON.stringify(event.customizations) : null,
      timestamp
    );

    return eventId;
  }

  /**
   * Get template usage history for skill demonstration tracking
   * Requirements: 4.3
   */
  getTemplateUsageHistory(filters: {
    templateId?: string;
    agentId?: string;
    projectId?: string;
    usageType?: TemplateUsageEvent['usageType'];
    limit?: number;
  } = {}): TemplateUsageEvent[] {
    let sql = 'SELECT * FROM template_usage_events WHERE 1=1';
    const params: unknown[] = [];

    if (filters.templateId) {
      sql += ' AND template_id = ?';
      params.push(filters.templateId);
    }
    if (filters.agentId) {
      sql += ' AND agent_id = ?';
      params.push(filters.agentId);
    }
    if (filters.projectId) {
      sql += ' AND project_id = ?';
      params.push(filters.projectId);
    }
    if (filters.usageType) {
      sql += ' AND usage_type = ?';
      params.push(filters.usageType);
    }

    sql += ' ORDER BY timestamp DESC';
    
    if (filters.limit) {
      sql += ' LIMIT ?';
      params.push(filters.limit);
    }

    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: string;
      template_id: string;
      agent_id: string | null;
      project_id: string;
      task_context: string;
      usage_type: string;
      timestamp: string;
      skills_demonstrated: string;
      customizations: string | null;
    }>;

    return rows.map(row => ({
      id: row.id,
      templateId: row.template_id,
      agentId: row.agent_id || 'unknown',
      projectId: row.project_id,
      taskContext: row.task_context,
      usageType: row.usage_type as TemplateUsageEvent['usageType'],
      timestamp: new Date(row.timestamp),
      skillDemonstrated: JSON.parse(row.skills_demonstrated),
      customizations: row.customizations ? JSON.parse(row.customizations) : undefined
    }));
  }

  /**
   * Customize a template while maintaining integrity
   * Requirements: 4.4
   */
  customizeTemplate(
    templateId: string,
    customizations: Record<string, unknown>,
    projectId: string,
    agentId?: string
  ): { success: boolean; customizedTemplate?: DesignTemplate; error?: string } {
    const originalTemplate = this.getTemplate(templateId);
    if (!originalTemplate) {
      return { success: false, error: 'Template not found' };
    }

    try {
      // Validate customizations don't break template integrity
      const validationResult = this.validateCustomizations(originalTemplate, customizations);
      if (!validationResult.valid) {
        return { success: false, error: validationResult.error };
      }

      // Apply customizations
      const customizedTemplate: DesignTemplate = {
        ...originalTemplate,
        id: `${templateId}_custom_${Date.now()}`,
        name: `${originalTemplate.name} (Customized)`,
        metadata: {
          ...originalTemplate.metadata,
          originalTemplateId: templateId,
          customizations,
          customizedAt: new Date().toISOString(),
          customizedBy: agentId
        }
      };

      // Apply content customizations
      customizedTemplate.content = this.applyContentCustomizations(
        originalTemplate.content,
        customizations
      );

      // Record the customization event
      this.recordTemplateUsage({
        templateId: originalTemplate.id,
        agentId: agentId || 'unknown',
        projectId,
        taskContext: `Template customization: ${JSON.stringify(customizations)}`,
        usageType: 'customization',
        skillDemonstrated: ['template_customization', 'design_adaptation'],
        customizations
      });

      return { success: true, customizedTemplate };
    } catch (error) {
      return { 
        success: false, 
        error: `Customization failed: ${error instanceof Error ? error.message : 'Unknown error'}` 
      };
    }
  }

  /**
   * Validate that customizations maintain template integrity
   */
  private validateCustomizations(
    template: DesignTemplate,
    customizations: Record<string, unknown>
  ): { valid: boolean; error?: string } {
    // Check for forbidden customizations that would break template structure
    const forbiddenKeys = ['id', 'version', 'createdAt'];
    for (const key of forbiddenKeys) {
      if (key in customizations) {
        return { valid: false, error: `Cannot customize protected field: ${key}` };
      }
    }

    // Validate color scheme format if being customized
    if (customizations.colorScheme !== undefined) {
      if (!Array.isArray(customizations.colorScheme)) {
        return { valid: false, error: 'colorScheme must be an array' };
      }
      for (const color of customizations.colorScheme) {
        if (typeof color !== 'string' || color.trim().length === 0) {
          return { valid: false, error: 'All color scheme values must be non-empty strings' };
        }
      }
    }

    // Validate design style
    if (customizations.designStyle !== undefined && 
        (typeof customizations.designStyle !== 'string' || customizations.designStyle.trim().length === 0)) {
      return { valid: false, error: 'designStyle must be a non-empty string' };
    }

    return { valid: true };
  }

  /**
   * Apply customizations to template content
   */
  private applyContentCustomizations(
    originalContent: string,
    customizations: Record<string, unknown>
  ): string {
    let customizedContent = originalContent;

    // Apply simple text replacements for common customizations
    if (customizations.colorScheme && Array.isArray(customizations.colorScheme)) {
      // Add color scheme information to content
      customizedContent += `\n\n## Customized Color Scheme\n${customizations.colorScheme.join(', ')}`;
    }

    if (customizations.designStyle && typeof customizations.designStyle === 'string') {
      customizedContent += `\n\n## Design Style\n${customizations.designStyle}`;
    }

    // Add customization metadata
    customizedContent += `\n\n## Template Customizations\n${JSON.stringify(customizations, null, 2)}`;

    return customizedContent;
  }

  /**
   * Convert SkillDefinition to DesignTemplate
   */
  private skillToTemplate(skill: SkillDefinition): DesignTemplate {
    return {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      category: skill.category,
      designStyle: skill.metadata.designStyle as string | undefined,
      industry: skill.metadata.industry as string | undefined,
      colorScheme: skill.metadata.colorScheme as string[] | undefined,
      tags: skill.tags,
      content: skill.content,
      previewHtml: skill.metadata.previewHtml as string | undefined,
      metadata: skill.metadata,
      version: skill.version,
      createdAt: skill.createdAt,
      updatedAt: skill.updatedAt
    };
  }

  /**
   * Tokenize text for keyword matching
   */
  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 0);
  }
}