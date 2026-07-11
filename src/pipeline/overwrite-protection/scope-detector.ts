/**
 * Scope Divergence Detector for Overwrite Protection.
 *
 * Analyzes user prompts against the current project manifest to determine
 * whether the user is requesting an entirely different project. Uses heuristic
 * NLP matching (keyword/technology detection) — no LLM call — so it can be
 * tested deterministically.
 *
 * @module scope-detector
 */

import type { ProjectManifest, ScopeDetectorConfig, ScopeDivergenceResult } from './types';

// ─── Technology Families ────────────────────────────────────────

/**
 * Technology families group related technologies so we can detect when
 * a prompt references a technology from a fundamentally different family
 * than the current project.
 */
const TECHNOLOGY_FAMILIES: Record<string, string[]> = {
  'web-frontend': ['react', 'vue', 'angular', 'svelte', 'nextjs', 'next', 'nuxt', 'gatsby', 'solid', 'preact', 'lit', 'htmx'],
  'web-backend': ['express', 'flask', 'django', 'fastapi', 'rails', 'spring', 'koa', 'hapi', 'nest', 'nestjs', 'gin', 'echo', 'actix', 'rocket', 'sinatra', 'laravel', 'phoenix'],
  'mobile': ['react-native', 'flutter', 'swift', 'swiftui', 'kotlin', 'android', 'ios', 'expo', 'ionic', 'capacitor', 'xamarin'],
  'systems': ['rust', 'go', 'golang', 'c', 'cpp', 'c++', 'zig', 'nim', 'assembly'],
  'data': ['pandas', 'numpy', 'jupyter', 'tensorflow', 'pytorch', 'scikit-learn', 'matplotlib', 'spark', 'hadoop', 'dbt', 'airflow'],
  'desktop': ['electron', 'tauri', 'qt', 'gtk', 'wxwidgets', 'tkinter', 'javafx'],
};

// ─── Domain Categories ──────────────────────────────────────────

/**
 * Domain categories map keywords commonly found in project purposes
 * to domain labels, enabling detection of cross-domain divergence.
 */
const DOMAIN_CATEGORIES: Record<string, string[]> = {
  'e-commerce': ['shop', 'store', 'cart', 'checkout', 'payment', 'product', 'order', 'inventory', 'catalog', 'merchant'],
  'social-media': ['social', 'feed', 'post', 'follow', 'like', 'share', 'comment', 'profile', 'friend', 'timeline'],
  'games': ['game', 'player', 'score', 'level', 'sprite', 'physics', 'render', 'multiplayer', 'quest', 'character'],
  'utilities': ['util', 'tool', 'cli', 'command', 'script', 'automation', 'converter', 'formatter', 'linter'],
  'dev-tools': ['ide', 'editor', 'debugger', 'compiler', 'bundler', 'transpiler', 'lsp', 'extension', 'plugin', 'coding', 'agent'],
  'healthcare': ['patient', 'medical', 'health', 'doctor', 'clinic', 'diagnosis', 'treatment', 'pharmacy', 'hospital'],
  'finance': ['finance', 'bank', 'trading', 'investment', 'portfolio', 'stock', 'crypto', 'wallet', 'transaction', 'ledger'],
  'education': ['course', 'student', 'teacher', 'lesson', 'quiz', 'exam', 'classroom', 'curriculum', 'learning'],
  'messaging': ['chat', 'message', 'conversation', 'notification', 'inbox', 'email', 'sms', 'realtime'],
  'media': ['video', 'audio', 'music', 'stream', 'podcast', 'photo', 'gallery', 'upload', 'media'],
};

// ─── Scaffold Keywords ──────────────────────────────────────────

/**
 * Keywords and phrases that suggest the user wants to scaffold or bootstrap
 * a new project, even without matching explicit scope-change patterns.
 */
const SCAFFOLD_PATTERNS: RegExp[] = [
  /\bscaffold\b/i,
  /\bbootstrap\b/i,
  /\binitialize\b/i,
  /\bset\s+up\s+a\s+new\b/i,
  /\bcreate\s+(?:\w+\s+)*?a\b/i,
  /\bbuild\s+(?:\w+\s+)*?a\b/i,
  /\bfrom\s+scratch\b/i,
  /\bstart\s+(?:\w+\s+)*?a\b/i,
  /\bgenerate\s+(?:\w+\s+)*?a\b/i,
  /\binit\b/i,
];

// ─── Project Name Extraction ────────────────────────────────────

/**
 * Patterns for extracting a potential project name from user messages.
 * Captures the first capitalized or multi-word phrase following action verbs.
 */
const PROJECT_NAME_PATTERNS: RegExp[] = [
  /\b(?:[Bb]uild|[Cc]reate|[Ss]caffold|[Bb]ootstrap|[Ii]nitialize|[Gg]enerate|[Mm]ake|[Ss]tart)\s+(?:\w+\s+)*?([A-Z][a-zA-Z0-9]*(?:[A-Z][a-zA-Z0-9]*)*)\b/,
  /\b(?:build|create|scaffold|bootstrap|initialize|generate|make|start)\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?["']([^"']+)["']/i,
  /\b(?:called|named)\s+["']?([A-Z][a-zA-Z0-9-_]*(?:\s[A-Z][a-zA-Z0-9-_]*)*)["']?/i,
];

// ─── Helper Functions ───────────────────────────────────────────

/**
 * Normalizes a string for comparison: lowercase, trimmed, extra spaces collapsed.
 */
function normalize(text: string): string {
  return text.toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Extracts all technology mentions from a text by checking against known families.
 * Returns an array of { tech, family } pairs.
 */
function extractTechMentions(text: string): Array<{ tech: string; family: string }> {
  const normalizedText = normalize(text);
  const mentions: Array<{ tech: string; family: string }> = [];

  for (const [family, techs] of Object.entries(TECHNOLOGY_FAMILIES)) {
    for (const tech of techs) {
      // Use word boundary matching for accurate detection
      const pattern = new RegExp(`\\b${escapeRegExp(tech)}\\b`, 'i');
      if (pattern.test(normalizedText)) {
        mentions.push({ tech, family });
      }
    }
  }

  return mentions;
}

/**
 * Determines the technology family of the current project based on its manifest.
 */
function getProjectFamily(manifest: ProjectManifest): string | null {
  const projectTechs: string[] = [];

  if (manifest.framework) {
    projectTechs.push(manifest.framework.toLowerCase());
  }
  if (manifest.primaryLanguage) {
    projectTechs.push(manifest.primaryLanguage.toLowerCase());
  }
  for (const dep of manifest.dependencies) {
    projectTechs.push(dep.toLowerCase());
  }

  for (const [family, techs] of Object.entries(TECHNOLOGY_FAMILIES)) {
    for (const tech of techs) {
      if (projectTechs.some((pt) => pt.includes(tech) || tech.includes(pt))) {
        return family;
      }
    }
  }

  return null;
}

/**
 * Detects the domain(s) of a text by checking against domain category keywords.
 */
function detectDomains(text: string): string[] {
  const normalizedText = normalize(text);
  const matched: string[] = [];

  for (const [domain, keywords] of Object.entries(DOMAIN_CATEGORIES)) {
    for (const keyword of keywords) {
      const pattern = new RegExp(`\\b${escapeRegExp(keyword)}\\b`, 'i');
      if (pattern.test(normalizedText)) {
        matched.push(domain);
        break; // One match per domain is enough
      }
    }
  }

  return matched;
}

/**
 * Escapes special regex characters in a string.
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Attempts to extract a project name from the user's message.
 */
function extractProjectName(message: string): string | null {
  for (const pattern of PROJECT_NAME_PATTERNS) {
    const match = pattern.exec(message);
    if (match && match[1]) {
      const name = match[1].trim();
      // Filter out common false positives (generic words)
      const genericWords = ['app', 'application', 'project', 'thing', 'something', 'api', 'service', 'site', 'website'];
      if (genericWords.includes(name.toLowerCase())) {
        continue;
      }
      return name;
    }
  }
  return null;
}

/**
 * Infers the technology stack from technology mentions in a message.
 */
function inferStack(message: string): string | null {
  const mentions = extractTechMentions(message);
  if (mentions.length === 0) {
    return null;
  }
  // Return the most significant mentions (up to 3) joined
  const uniqueTechs = [...new Set(mentions.map((m) => m.tech))];
  return uniqueTechs.slice(0, 3).join(', ');
}

// ─── Main Function ──────────────────────────────────────────────

/**
 * Analyzes a user prompt against the project manifest to compute divergence.
 *
 * Scoring heuristics:
 * - Explicit scope-change phrases → immediate 1.0 + isNewProjectRequest
 * - Technology mismatch (0.0 to 0.5 contribution)
 * - Scaffold keyword detection (0.0 to 0.3 contribution)
 * - Named project reference mismatch (0.0 to 0.2 contribution)
 * - Domain mismatch (0.0 to 0.2 contribution)
 *
 * Final score is clamped to [0.0, 1.0].
 *
 * @param userMessage - The raw user prompt text
 * @param manifest - The current project's manifest
 * @param config - Scope detector configuration
 * @returns ScopeDivergenceResult with score, flags, and explanation
 */
export function computeScopeDivergence(
  userMessage: string,
  manifest: ProjectManifest,
  config: ScopeDetectorConfig
): ScopeDivergenceResult {
  const explanations: string[] = [];
  let score = 0;
  let triggeredByExplicitPhrase = false;

  // ─── Step 1: Explicit scope-change phrase detection ──────────
  for (const pattern of config.explicitScopeChangePatterns) {
    if (pattern.test(userMessage)) {
      triggeredByExplicitPhrase = true;
      score = 1.0;
      explanations.push(`Explicit scope-change phrase detected (matched: ${pattern.source})`);
      break;
    }
  }

  // If explicit phrase was found, short-circuit scoring but still extract metadata
  if (!triggeredByExplicitPhrase) {
    // ─── Step 2: Technology mismatch scoring (0.0 to 0.5) ──────
    const messageTechMentions = extractTechMentions(userMessage);
    const projectFamily = getProjectFamily(manifest);

    if (messageTechMentions.length > 0 && projectFamily) {
      const messageFamilies = [...new Set(messageTechMentions.map((m) => m.family))];
      const hasDifferentFamily = messageFamilies.some((f) => f !== projectFamily);
      const hasSameFamily = messageFamilies.some((f) => f === projectFamily);

      if (hasDifferentFamily && !hasSameFamily) {
        // Strong mismatch: only mentions techs from different families
        score += 0.5;
        const mismatchedFamilies = messageFamilies.filter((f) => f !== projectFamily);
        explanations.push(
          `Technology family mismatch: project is ${projectFamily}, message references ${mismatchedFamilies.join(', ')}`
        );
      } else if (hasDifferentFamily && hasSameFamily) {
        // Weak mismatch: mentions both same and different families
        score += 0.2;
        explanations.push('Message references technologies from both the current and different families');
      }
    }

    // ─── Step 3: Scaffold keyword detection (0.0 to 0.3) ────────
    const matchedScaffoldPatterns: string[] = [];
    for (const pattern of SCAFFOLD_PATTERNS) {
      if (pattern.test(userMessage)) {
        matchedScaffoldPatterns.push(pattern.source);
      }
    }

    if (matchedScaffoldPatterns.length > 0) {
      // More scaffold keywords = higher score contribution
      const scaffoldScore = Math.min(0.3, matchedScaffoldPatterns.length * 0.1);
      score += scaffoldScore;
      explanations.push(
        `Scaffold keywords detected: ${matchedScaffoldPatterns.length} pattern(s) matched`
      );
    }

    // ─── Step 4: Named project reference mismatch (0.0 to 0.2) ──
    const inferredName = extractProjectName(userMessage);
    if (inferredName) {
      const normalizedInferred = normalize(inferredName);
      const normalizedManifest = normalize(manifest.name);

      // Check if inferred name is substantially different from manifest name
      if (
        !normalizedManifest.includes(normalizedInferred) &&
        !normalizedInferred.includes(normalizedManifest)
      ) {
        score += 0.2;
        explanations.push(
          `Named project reference "${inferredName}" doesn't match current project "${manifest.name}"`
        );
      }
    }

    // ─── Step 5: Domain mismatch detection (0.0 to 0.2) ─────────
    const manifestText = `${manifest.name} ${manifest.purpose} ${manifest.dependencies.join(' ')}`;
    const projectDomains = detectDomains(manifestText);
    const messageDomains = detectDomains(userMessage);

    if (messageDomains.length > 0 && projectDomains.length > 0) {
      const hasOverlap = messageDomains.some((d) => projectDomains.includes(d));
      if (!hasOverlap) {
        score += 0.2;
        explanations.push(
          `Domain mismatch: project domains [${projectDomains.join(', ')}], message domains [${messageDomains.join(', ')}]`
        );
      }
    }
  }

  // ─── Step 6: Clamp score to [0.0, 1.0] ────────────────────────
  score = Math.max(0, Math.min(1, score));

  // ─── Step 7: Determine isNewProjectRequest ─────────────────────
  const isNewProjectRequest = triggeredByExplicitPhrase || score > config.threshold;

  // ─── Step 8: Infer project name ────────────────────────────────
  const inferredProjectName = extractProjectName(userMessage);

  // ─── Step 9: Infer stack ───────────────────────────────────────
  const inferredStack = inferStack(userMessage);

  // ─── Build explanation ─────────────────────────────────────────
  const explanation =
    explanations.length > 0
      ? explanations.join('; ')
      : 'No significant divergence detected';

  return {
    score,
    isNewProjectRequest,
    triggeredByExplicitPhrase,
    inferredProjectName,
    inferredStack,
    explanation,
  };
}
