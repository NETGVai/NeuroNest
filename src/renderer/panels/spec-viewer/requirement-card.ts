/**
 * Requirement Card component for the Spec Viewer Panel.
 *
 * Renders individual requirements as card components with title, user story,
 * acceptance criteria list, and status indicators.
 *
 * Requirements: 23.9, 23.11
 */

// ─── Types ──────────────────────────────────────────────────────

/** Parsed requirement data for rendering. */
export interface RequirementData {
  id: string;
  title: string;
  userStory: string;
  acceptanceCriteria: string[];
  status: 'not_started' | 'in_progress' | 'completed';
}

// ─── CSS Classes ────────────────────────────────────────────────

const CSS = {
  card: 'nn-req-card',
  cardHeader: 'nn-req-card__header',
  cardTitle: 'nn-req-card__title',
  cardStatus: 'nn-req-card__status',
  cardStory: 'nn-req-card__story',
  cardCriteria: 'nn-req-card__criteria',
  cardCriteriaTitle: 'nn-req-card__criteria-title',
  cardCriteriaItem: 'nn-req-card__criteria-item',
  statusNotStarted: 'nn-req-card__status--not-started',
  statusInProgress: 'nn-req-card__status--in-progress',
  statusCompleted: 'nn-req-card__status--completed',
} as const;

// ─── Styles ─────────────────────────────────────────────────────

/** Inject scoped styles for requirement cards. */
export function injectRequirementCardStyles(): void {
  if (document.getElementById('nn-req-card-styles')) return;

  const style = document.createElement('style');
  style.id = 'nn-req-card-styles';
  style.textContent = `
    .${CSS.card} {
      border: 1px solid var(--border, #334155);
      border-radius: 8px;
      background: var(--bg-secondary, #1e293b);
      padding: 16px;
      margin-bottom: 12px;
      transition: border-color 0.15s;
    }
    .${CSS.card}:hover {
      border-color: var(--accent, #6366f1);
    }
    .${CSS.cardHeader} {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
    }
    .${CSS.cardTitle} {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary, #e2e8f0);
      margin: 0;
    }
    .${CSS.cardStatus} {
      display: inline-flex;
      align-items: center;
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.3px;
      flex-shrink: 0;
    }
    .${CSS.statusNotStarted} {
      background: rgba(100, 116, 139, 0.2);
      color: #94a3b8;
    }
    .${CSS.statusInProgress} {
      background: rgba(245, 158, 11, 0.2);
      color: #fbbf24;
    }
    .${CSS.statusCompleted} {
      background: rgba(16, 185, 129, 0.2);
      color: #34d399;
    }
    .${CSS.cardStory} {
      font-size: 12px;
      color: var(--text-secondary, #94a3b8);
      margin-bottom: 12px;
      line-height: 1.5;
      font-style: italic;
    }
    .${CSS.cardCriteria} {
      border-top: 1px solid var(--border, #334155);
      padding-top: 10px;
    }
    .${CSS.cardCriteriaTitle} {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-secondary, #94a3b8);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 8px;
    }
    .${CSS.cardCriteriaItem} {
      font-size: 12px;
      color: var(--text-primary, #e2e8f0);
      padding: 4px 0 4px 16px;
      position: relative;
      line-height: 1.5;
    }
    .${CSS.cardCriteriaItem}::before {
      content: '•';
      position: absolute;
      left: 4px;
      color: var(--accent, #6366f1);
    }
  `;
  document.head.appendChild(style);
}

// ─── Helpers ────────────────────────────────────────────────────

/** Get status label text. */
function getStatusLabel(status: RequirementData['status']): string {
  switch (status) {
    case 'not_started': return 'Not Started';
    case 'in_progress': return 'In Progress';
    case 'completed': return 'Completed';
    default: return 'Unknown';
  }
}

/** Get status CSS class. */
function getStatusClass(status: RequirementData['status']): string {
  switch (status) {
    case 'not_started': return CSS.statusNotStarted;
    case 'in_progress': return CSS.statusInProgress;
    case 'completed': return CSS.statusCompleted;
    default: return CSS.statusNotStarted;
  }
}

// ─── Component ──────────────────────────────────────────────────

/**
 * Renders a single requirement as a card element.
 */
export function renderRequirementCard(requirement: RequirementData): HTMLElement {
  injectRequirementCardStyles();

  const card = document.createElement('article');
  card.className = CSS.card;
  card.setAttribute('role', 'article');
  card.setAttribute('aria-label', `Requirement: ${requirement.title}`);
  card.dataset.requirementId = requirement.id;

  // Header: title + status badge
  const header = document.createElement('div');
  header.className = CSS.cardHeader;

  const title = document.createElement('h3');
  title.className = CSS.cardTitle;
  title.textContent = `${requirement.id}. ${requirement.title}`;
  header.appendChild(title);

  const status = document.createElement('span');
  status.className = `${CSS.cardStatus} ${getStatusClass(requirement.status)}`;
  status.textContent = getStatusLabel(requirement.status);
  status.setAttribute('aria-label', `Status: ${getStatusLabel(requirement.status)}`);
  header.appendChild(status);

  card.appendChild(header);

  // User story
  if (requirement.userStory) {
    const story = document.createElement('p');
    story.className = CSS.cardStory;
    story.textContent = requirement.userStory;
    card.appendChild(story);
  }

  // Acceptance criteria
  if (requirement.acceptanceCriteria.length > 0) {
    const criteriaSection = document.createElement('div');
    criteriaSection.className = CSS.cardCriteria;

    const criteriaTitle = document.createElement('div');
    criteriaTitle.className = CSS.cardCriteriaTitle;
    criteriaTitle.textContent = 'Acceptance Criteria';
    criteriaSection.appendChild(criteriaTitle);

    for (const criterion of requirement.acceptanceCriteria) {
      const item = document.createElement('div');
      item.className = CSS.cardCriteriaItem;
      item.textContent = criterion;
      criteriaSection.appendChild(item);
    }

    card.appendChild(criteriaSection);
  }

  return card;
}

/**
 * Parse requirements from a requirements.md markdown string.
 * Extracts requirement blocks with user stories and acceptance criteria.
 */
export function parseRequirements(markdown: string): RequirementData[] {
  const requirements: RequirementData[] = [];

  // Split by ### Requirement headers
  const reqPattern = /^### Requirement (\d+): (.+)$/gm;
  let match: RegExpExecArray | null;
  const matches: Array<{ id: string; title: string; startIndex: number }> = [];

  while ((match = reqPattern.exec(markdown)) !== null) {
    matches.push({
      id: match[1],
      title: match[2],
      startIndex: match.index,
    });
  }

  for (let i = 0; i < matches.length; i++) {
    const reqMatch = matches[i];
    const endIndex = i < matches.length - 1 ? matches[i + 1].startIndex : markdown.length;
    const section = markdown.slice(reqMatch.startIndex, endIndex);

    // Extract user story
    const storyMatch = section.match(/\*\*User Story:\*\*\s*(.+?)(?:\n\n|$)/s);
    const userStory = storyMatch ? storyMatch[1].trim() : '';

    // Extract acceptance criteria
    const criteriaSection = section.match(/#### Acceptance Criteria\n+([\s\S]+?)(?=\n### |\n## |$)/);
    const criteria: string[] = [];
    if (criteriaSection) {
      const lines = criteriaSection[1].split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith(/^\d+\.\s/.test(trimmed) ? '' : '')) {
          // Match numbered list items
          const numMatch = trimmed.match(/^\d+\.\s+(.+)/);
          if (numMatch) {
            criteria.push(numMatch[1]);
          }
        }
      }
    }

    requirements.push({
      id: reqMatch.id,
      title: reqMatch.title,
      userStory,
      acceptanceCriteria: criteria,
      status: 'not_started',
    });
  }

  return requirements;
}
