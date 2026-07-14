/**
 * GitHub Integration — Issue triage, PR creation, code review trigger
 *
 * Handles GitHub webhook events and provides automation for:
 * - Issue triage: auto-label, assign, and categorize new issues
 * - PR creation: create pull requests from agent task results
 * - Code review trigger: initiate code review pipelines on PR events
 *
 * Task 22.2
 */

import * as crypto from 'crypto';

// ─── Types ──────────────────────────────────────────────────────

export interface GitHubWebhookEvent {
  action: string;
  repository: {
    full_name: string;
    owner: { login: string };
    name: string;
  };
  sender: { login: string };
}

export interface GitHubIssueEvent extends GitHubWebhookEvent {
  action: 'opened' | 'edited' | 'labeled' | 'closed';
  issue: {
    number: number;
    title: string;
    body: string;
    labels: { name: string }[];
    user: { login: string };
    state: string;
  };
}

export interface GitHubPullRequestEvent extends GitHubWebhookEvent {
  action: 'opened' | 'synchronize' | 'closed' | 'ready_for_review';
  pull_request: {
    number: number;
    title: string;
    body: string;
    head: { ref: string; sha: string };
    base: { ref: string };
    user: { login: string };
    draft: boolean;
    labels: { name: string }[];
  };
}

export interface IssueTriage {
  labels: string[];
  assignees: string[];
  priority: 'low' | 'medium' | 'high' | 'critical';
  category: string;
  autoResponse?: string;
}

export interface PRCreationRequest {
  owner: string;
  repo: string;
  title: string;
  body: string;
  head: string;
  base: string;
  labels?: string[];
  assignees?: string[];
  draft?: boolean;
}

export interface CodeReviewTrigger {
  owner: string;
  repo: string;
  prNumber: number;
  sha: string;
  reviewType: 'full' | 'incremental' | 'security';
}

export interface GitHubIntegrationConfig {
  webhookSecret: string;
  appId: string;
  privateKey: string;
  installationId: string;
}

// ─── Signature Verification ─────────────────────────────────────

/**
 * Verify GitHub webhook signature (HMAC-SHA256).
 */
export function verifyGitHubSignature(
  secret: string,
  payload: string,
  signature: string
): boolean {
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');

  if (signature.length !== expected.length) {
    return false;
  }

  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// ─── Issue Triage ───────────────────────────────────────────────

/** Keywords used for auto-categorization of issues */
const CATEGORY_KEYWORDS: Record<string, string[]> = {
  bug: ['bug', 'error', 'crash', 'broken', 'not working', 'fail', 'exception'],
  feature: ['feature', 'enhancement', 'request', 'add', 'new', 'support'],
  docs: ['documentation', 'docs', 'typo', 'readme', 'guide'],
  security: ['security', 'vulnerability', 'cve', 'exploit', 'xss', 'injection'],
  performance: ['slow', 'performance', 'memory', 'leak', 'optimization', 'latency'],
};

const PRIORITY_KEYWORDS: Record<string, string[]> = {
  critical: ['critical', 'urgent', 'blocker', 'production down', 'data loss'],
  high: ['high priority', 'important', 'regression', 'security'],
  medium: ['medium', 'moderate'],
  low: ['low priority', 'nice to have', 'minor', 'cosmetic'],
};

/**
 * Triage an issue based on its title and body content.
 */
export function triageIssue(title: string, body: string): IssueTriage {
  const text = `${title} ${body}`.toLowerCase();

  // Determine category
  let category = 'uncategorized';
  for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some(kw => text.includes(kw))) {
      category = cat;
      break;
    }
  }

  // Determine priority
  let priority: IssueTriage['priority'] = 'medium';
  for (const [prio, keywords] of Object.entries(PRIORITY_KEYWORDS)) {
    if (keywords.some(kw => text.includes(kw))) {
      priority = prio as IssueTriage['priority'];
      break;
    }
  }

  // Generate labels
  const labels: string[] = [category];
  if (priority === 'critical' || priority === 'high') {
    labels.push(`priority:${priority}`);
  }
  if (category === 'security') {
    labels.push('security');
  }

  return {
    labels,
    assignees: [],
    priority,
    category,
  };
}

// ─── GitHub Integration Handler ──────────────────────────────────

export class GitHubIntegration {
  private config: GitHubIntegrationConfig;
  private taskSubmitter: (tenantId: string, type: string, payload: Record<string, unknown>) => Promise<string>;

  constructor(
    config: GitHubIntegrationConfig,
    taskSubmitter: (tenantId: string, type: string, payload: Record<string, unknown>) => Promise<string>
  ) {
    this.config = config;
    this.taskSubmitter = taskSubmitter;
  }

  /**
   * Handle an incoming GitHub webhook event.
   */
  async handleWebhook(
    eventType: string,
    payload: string,
    signature: string
  ): Promise<{ handled: boolean; action?: string; taskId?: string }> {
    // Verify signature
    if (!verifyGitHubSignature(this.config.webhookSecret, payload, signature)) {
      return { handled: false, action: 'signature_verification_failed' };
    }

    const event = JSON.parse(payload);
    const repoFullName = event.repository?.full_name || 'unknown';

    switch (eventType) {
      case 'issues':
        return this.handleIssueEvent(event as GitHubIssueEvent, repoFullName);
      case 'pull_request':
        return this.handlePullRequestEvent(event as GitHubPullRequestEvent, repoFullName);
      default:
        return { handled: false, action: `unhandled_event:${eventType}` };
    }
  }

  /**
   * Handle issue events — auto-triage new issues.
   */
  private async handleIssueEvent(
    event: GitHubIssueEvent,
    repoFullName: string
  ): Promise<{ handled: boolean; action?: string; taskId?: string }> {
    if (event.action !== 'opened') {
      return { handled: false, action: `issue_action:${event.action}` };
    }

    const triage = triageIssue(event.issue.title, event.issue.body);

    const taskId = await this.taskSubmitter(repoFullName, 'github.issue_triage', {
      source: 'github',
      repo: repoFullName,
      issueNumber: event.issue.number,
      title: event.issue.title,
      body: event.issue.body,
      triage,
    });

    return { handled: true, action: 'issue_triaged', taskId };
  }

  /**
   * Handle pull request events — trigger code review.
   */
  private async handlePullRequestEvent(
    event: GitHubPullRequestEvent,
    repoFullName: string
  ): Promise<{ handled: boolean; action?: string; taskId?: string }> {
    // Trigger review on opened or synchronized (new commits pushed)
    if (event.action !== 'opened' && event.action !== 'synchronize' && event.action !== 'ready_for_review') {
      return { handled: false, action: `pr_action:${event.action}` };
    }

    // Skip draft PRs unless they become ready
    if (event.pull_request.draft && event.action !== 'ready_for_review') {
      return { handled: false, action: 'pr_draft_skipped' };
    }

    const reviewType = event.action === 'opened' ? 'full' : 'incremental';

    const trigger: CodeReviewTrigger = {
      owner: event.repository.owner.login,
      repo: event.repository.name,
      prNumber: event.pull_request.number,
      sha: event.pull_request.head.sha,
      reviewType,
    };

    const taskId = await this.taskSubmitter(repoFullName, 'github.code_review', {
      source: 'github',
      repo: repoFullName,
      trigger,
      prTitle: event.pull_request.title,
      prBody: event.pull_request.body,
      headRef: event.pull_request.head.ref,
      baseRef: event.pull_request.base.ref,
    });

    return { handled: true, action: `code_review_triggered:${reviewType}`, taskId };
  }

  /**
   * Create a PR creation request payload (to be executed by the agent).
   */
  static createPRRequest(
    owner: string,
    repo: string,
    options: {
      title: string;
      body: string;
      head: string;
      base?: string;
      labels?: string[];
      draft?: boolean;
    }
  ): PRCreationRequest {
    return {
      owner,
      repo,
      title: options.title,
      body: options.body,
      head: options.head,
      base: options.base || 'main',
      labels: options.labels,
      draft: options.draft ?? false,
    };
  }
}
