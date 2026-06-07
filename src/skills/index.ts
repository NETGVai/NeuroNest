// Skills module exports

export { SkillRegistry } from './skill-registry.js';
export { DesignTemplatesLibrary } from './design-templates-library.js';
export { trySkillRoute, injectDesignTemplate, loadCatalogAndTemplates } from './skill-integration.js';
export { routeTask } from './skill-router.js';
export { ExecutionEngine } from './skill-execution-engine.js';
export { CatalogLoader } from './catalog-loader.js';
export { autoAssignSkills } from './skill-auto-assignment.js';

export type { DesignTemplate, TemplateRecommendation, TemplateUsageEvent, TaskContext } from './design-templates-library.js';
export type { SkillDefinition } from './skill-metadata-parser.js';
export type { RouteResult } from './skill-router.js';
export type { ExecutionResult } from './skill-execution-engine.js';