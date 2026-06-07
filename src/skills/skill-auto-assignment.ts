// Auto-assigns relevant skills to agents based on keyword matching between
// skill tags/description and agent department/specialty.
// Called from loadCatalogAndTemplates at startup.

import type Database from 'better-sqlite3';
import { AGENT_REGISTRY } from '../agents/agent-registry.js';

/** Category-to-department mapping for broad matching */
const CATEGORY_DEPARTMENT_MAP: Record<string, string[]> = {
  'code-quality': ['Engineering', 'Research', 'Software Delivery'],
  'frontend': ['Engineering', 'Design'],
  'backend': ['Engineering', 'Software Delivery'],
  'database': ['Engineering', 'Specialized'],
  'testing': ['Testing', 'Software Delivery'],
  'devops': ['Engineering', 'Infrastructure', 'Software Delivery'],
  'infrastructure': ['Infrastructure', 'Engineering'],
  'documentation': ['Product', 'Software Delivery'],
  'security': ['Engineering', 'Testing', 'Specialized', 'Software Delivery'],
  'optimization': ['Optimization', 'Engineering'],
  'ai': ['Engineering', 'Specialized', 'NeuroNest Orchestration'],
  'design': ['Design'],
  'marketing': ['Marketing'],
  'mobile': ['Engineering'],
  'workflow': ['Product', 'Project Management', 'Software Delivery'],
  'swarm': ['Consensus', 'Infrastructure', 'NeuroNest Orchestration'],
  'data': ['Specialized', 'Engineering'],
  'architecture': ['Engineering', 'Software Delivery'],
};

/** Keywords that indicate strong affinity between a skill and an agent */
const SPECIALTY_KEYWORDS: Record<string, string[]> = {
  'security': ['security', 'vulnerability', 'owasp', 'auth', 'encryption', 'compliance', 'threat'],
  'performance': ['performance', 'profiling', 'optimization', 'benchmark', 'latency', 'throughput'],
  'testing': ['test', 'tdd', 'e2e', 'integration', 'sandbox', 'qa'],
  'deployment': ['deploy', 'ci-cd', 'pipeline', 'release', 'canary', 'production'],
  'architecture': ['architecture', 'system-design', 'microservices', 'patterns', 'components'],
  'ai-ml': ['ml', 'neural', 'embedding', 'prediction', 'training', 'llm', 'ai'],
  'consensus': ['consensus', 'byzantine', 'distributed', 'raft', 'paxos', 'voting'],
  'swarm': ['swarm', 'multi-agent', 'coordination', 'orchestration', 'hive'],
  'data': ['database', 'migration', 'schema', 'sql', 'data-pipeline'],
  'frontend': ['react', 'vue', 'css', 'ui', 'component', 'responsive'],
  'devops': ['docker', 'kubernetes', 'terraform', 'github-actions', 'ci'],
  'docs': ['documentation', 'readme', 'changelog', 'specification', 'technical-writing'],
  'monitoring': ['monitoring', 'observability', 'alerting', 'metrics', 'runtime'],
};

interface SkillRow {
  id: string;
  category: string;
  tags: string;
  description: string;
}

/**
 * Compute a relevance score between a skill and an agent based on keyword overlap.
 */
function computeRelevance(
  skill: SkillRow,
  agentDepartment: string,
  agentSpecialty: string,
): number {
  let score = 0;
  const tags: string[] = JSON.parse(skill.tags || '[]');
  const skillText = `${skill.description} ${tags.join(' ')} ${skill.category}`.toLowerCase();
  const specialtyLower = agentSpecialty.toLowerCase();

  // Category-department match
  const depts = CATEGORY_DEPARTMENT_MAP[skill.category];
  if (depts?.includes(agentDepartment)) {
    score += 2;
  }

  // Keyword overlap between skill tags/description and agent specialty
  for (const tag of tags) {
    if (specialtyLower.includes(tag.toLowerCase())) {
      score += 3;
    }
  }

  // Check specialty keyword groups
  for (const [, keywords] of Object.entries(SPECIALTY_KEYWORDS)) {
    const skillHasKeyword = keywords.some((kw) => skillText.includes(kw));
    const agentHasKeyword = keywords.some((kw) => specialtyLower.includes(kw));
    if (skillHasKeyword && agentHasKeyword) {
      score += 2;
    }
  }

  return score;
}

/**
 * Auto-assign skills to agents based on keyword matching.
 * Uses INSERT OR IGNORE to avoid duplicating existing assignments.
 * Returns the number of new assignments created.
 */
export function autoAssignSkills(db: Database.Database): number {
  // Get all enabled skills from the database
  const skills = db
    .prepare('SELECT id, category, tags, description FROM skills WHERE enabled = 1')
    .all() as SkillRow[];

  if (skills.length === 0) {
    console.log('[SkillAutoAssignment] No enabled skills found, skipping auto-assignment');
    return 0;
  }

  const stmt = db.prepare(
    `INSERT OR IGNORE INTO agent_skill_assignments
       (agent_id, skill_id, proficiency_level, success_rate, total_executions, successful_executions, avg_execution_time_ms, learned_at)
     VALUES (?, ?, 'intermediate', 0.0, 0, 0, 0, CURRENT_TIMESTAMP)`,
  );

  let count = 0;
  const RELEVANCE_THRESHOLD = 4;

  for (const agent of AGENT_REGISTRY) {
    for (const skill of skills) {
      const relevance = computeRelevance(skill, agent.department, agent.specialty);
      if (relevance >= RELEVANCE_THRESHOLD) {
        try {
          const result = stmt.run(agent.id, skill.id);
          if (result.changes > 0) count++;
        } catch {
          // FK constraint or other issue — skip silently
        }
      }
    }
  }

  console.log(`[SkillAutoAssignment] Auto-assigned ${count} skill-agent pairs (threshold: ${RELEVANCE_THRESHOLD})`);
  return count;
}
