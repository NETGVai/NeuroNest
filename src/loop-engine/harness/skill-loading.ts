// ─── Skill Loading Discipline ──────────────────────────────────
// Enforces lazy body loading for the skill system: only name and
// description are injected at session start. Bodies are loaded on
// trigger match and cleared at pass boundaries.
// Requirements: 29.1, 29.2, 29.3, 29.4, 29.5

/**
 * Minimal skill header injected into context at startup.
 * Only name + description — no body content.
 */
export interface SkillHeader {
  name: string;
  description: string;
}

/**
 * Full skill registration including the optional body.
 * Body should be undefined/empty until explicitly loaded on trigger match.
 */
export interface SkillRegistration {
  name: string;
  description: string;
  body?: string;
}

/**
 * Violation record when a skill is found to eagerly load its body.
 */
export interface LoadingViolation {
  skillName: string;
  reason: string;
}

/** Token estimation: chars/4 approximation */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Default threshold for flagging header token cost (REQ-29.4) */
const HEADER_TOKEN_WARNING_THRESHOLD = 500;

/**
 * SkillLoadingDiscipline verifies that the skill system injects only
 * name + description at session start with lazy body loading on trigger
 * match (REQ-29.1). It clears loaded bodies at pass boundaries (REQ-29.3)
 * and emits diagnostics about header token cost (REQ-29.4).
 */
export class SkillLoadingDiscipline {
  private skills: SkillRegistration[];

  constructor(skills: SkillRegistration[]) {
    this.skills = skills;
  }

  /**
   * Verify at startup that skills inject only name+description (REQ-29.1).
   * Returns violations for any skill where body is eagerly loaded.
   *
   * REQ-29.5: Eager loading violations are flagged regardless of whether
   * the eagerly loaded content consumes zero tokens.
   */
  verifyLazyLoading(): LoadingViolation[] {
    const violations: LoadingViolation[] = [];

    for (const skill of this.skills) {
      if (skill.body !== undefined && skill.body !== '') {
        const tokenCost = estimateTokens(skill.body);
        violations.push({
          skillName: skill.name,
          reason:
            `Skill "${skill.name}" has body eagerly loaded at startup ` +
            `(${tokenCost} tokens). Only name+description should be injected.`,
        });
      }
    }

    return violations;
  }

  /**
   * Clear all loaded skill bodies at pass boundary (REQ-29.3).
   * After this call, body is undefined for all skills — ensuring that
   * skill bodies loaded in pass N do NOT persist into pass N+1 context.
   */
  clearLoadedBodies(): void {
    for (const skill of this.skills) {
      delete skill.body;
    }
  }

  /**
   * Estimate total token cost of all skill headers (name+description only).
   * Uses chars/4 approximation.
   */
  getHeaderTokenCost(): number {
    let total = 0;
    for (const skill of this.skills) {
      total += estimateTokens(skill.name);
      total += estimateTokens(skill.description);
    }
    return total;
  }

  /**
   * Return a startup diagnostic string reporting total header count
   * and token cost (REQ-29.4). Flags if token cost exceeds 500 tokens.
   */
  getStartupDiagnostic(): string {
    const headerCount = this.skills.length;
    const tokenCost = this.getHeaderTokenCost();
    const exceedsThreshold = tokenCost > HEADER_TOKEN_WARNING_THRESHOLD;

    let diagnostic =
      `[SKILL LOADING] ${headerCount} skill header(s) loaded, ` +
      `total token cost: ${tokenCost} tokens`;

    if (exceedsThreshold) {
      diagnostic +=
        ` [WARNING] Exceeds ${HEADER_TOKEN_WARNING_THRESHOLD}-token threshold. ` +
        `Consider reducing skill descriptions.`;
    }

    return diagnostic;
  }

  /**
   * Return names of skills with currently loaded bodies (for debugging).
   * Useful for verifying that clearLoadedBodies() worked correctly.
   */
  getLoadedSkills(): string[] {
    return this.skills
      .filter((skill) => skill.body !== undefined && skill.body !== '')
      .map((skill) => skill.name);
  }
}
