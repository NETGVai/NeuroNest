/**
 * Brainstorm-Before-Code Mode — Superpowers-inspired spec-first workflow.
 *
 * When the user describes a feature, the agent asks 3-5 clarifying questions
 * before writing any code. Forces design thinking before implementation.
 *
 * Integrates with the existing chat pipeline without modifying it —
 * the brainstorm mode intercepts messages and returns questions instead
 * of jumping straight to code generation.
 */

export interface BrainstormSession {
  id: string;
  projectId: string;
  originalRequest: string;
  questions: string[];
  answers: Map<string, string>;
  status: 'questioning' | 'designing' | 'approved' | 'cancelled';
  designDoc: string;
  createdAt: number;
  updatedAt: number;
}

export interface BrainstormConfig {
  enabled: boolean;
  minQuestions: number;
  maxQuestions: number;
  autoDetect: boolean; // Auto-detect when user is describing a feature
}

const DEFAULT_CONFIG: BrainstormConfig = {
  enabled: true,
  minQuestions: 3,
  maxQuestions: 5,
  autoDetect: true,
};

// Patterns that suggest the user wants to build something (not just chat)
const FEATURE_PATTERNS = [
  /\b(build|create|implement|add|make|develop|write)\b.*\b(feature|system|module|component|page|api|endpoint|service|function|class)\b/i,
  /\b(i want|i need|we need|let's|can you)\b.*\b(build|create|implement|add|make)\b/i,
  /\bhow (do i|can i|should i|would i)\b.*\b(build|create|implement|add)\b/i,
  /\b(integrate|connect|hook up|wire|set up)\b.*\b(with|to|into)\b/i,
];

// Patterns that suggest a simple question or chat (NOT a feature request)
const CHAT_PATTERNS = [
  /\b(what is|explain|tell me|how does|why does|what does)\b/i,
  /\b(fix|debug|error|bug|crash|broken|not working)\b/i,
  /\b(show|list|display|get|find|search)\b/i,
  /^\s*(hi|hello|hey|thanks|thank you|ok|yes|no|sure)\s*$/i,
];

export class BrainstormMode {
  private sessions: Map<string, BrainstormSession> = new Map();
  private config: BrainstormConfig;

  constructor(config?: Partial<BrainstormConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Check if a message looks like a feature request that should trigger brainstorming.
   */
  shouldBrainstorm(message: string): boolean {
    if (!this.config.enabled || !this.config.autoDetect) return false;
    if (message.length < 20) return false;

    // Skip if it matches chat patterns
    for (const pattern of CHAT_PATTERNS) {
      if (pattern.test(message)) return false;
    }

    // Check if it matches feature patterns
    for (const pattern of FEATURE_PATTERNS) {
      if (pattern.test(message)) return true;
    }

    return false;
  }

  /**
   * Start a brainstorm session for a feature request.
   */
  startSession(projectId: string, request: string): BrainstormSession {
    const session: BrainstormSession = {
      id: `bs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      projectId,
      originalRequest: request,
      questions: this.generateQuestions(request),
      answers: new Map(),
      status: 'questioning',
      designDoc: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.sessions.set(session.id, session);
    return session;
  }

  /**
   * Generate clarifying questions based on the feature request.
   */
  private generateQuestions(request: string): string[] {
    const questions: string[] = [];

    // Core questions that apply to any feature
    questions.push('What specific problem does this solve for the user?');
    questions.push('What does success look like? How will you know it works?');
    questions.push('What are the edge cases or failure scenarios to handle?');

    // Context-specific questions
    if (/\b(api|endpoint|service|backend)\b/i.test(request)) {
      questions.push('What data format should the API accept and return?');
      questions.push('What authentication/authorization is needed?');
    } else if (/\b(ui|page|component|panel|modal|form)\b/i.test(request)) {
      questions.push('What should the user see and interact with?');
      questions.push('How should errors and loading states be displayed?');
    } else if (/\b(integrate|connect|hook)\b/i.test(request)) {
      questions.push('What external service or system are we connecting to?');
      questions.push('What happens if the external service is unavailable?');
    } else {
      questions.push('Are there any constraints or requirements I should know about?');
      questions.push('Should this work with existing features, or is it standalone?');
    }

    return questions.slice(0, this.config.maxQuestions);
  }

  /**
   * Submit an answer to a question in the session.
   */
  answerQuestion(sessionId: string, questionIndex: number, answer: string): BrainstormSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    session.answers.set(String(questionIndex), answer);
    session.updatedAt = Date.now();

    // Check if enough questions are answered
    if (session.answers.size >= this.config.minQuestions) {
      session.status = 'designing';
    }

    return session;
  }

  /**
   * Generate a design summary from the brainstorm session.
   */
  generateDesignSummary(sessionId: string): string | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    let doc = `## Design: ${session.originalRequest}\n\n`;
    doc += `### Requirements\n\n`;
    doc += `**Original Request:** ${session.originalRequest}\n\n`;
    doc += `### Clarifications\n\n`;

    for (let i = 0; i < session.questions.length; i++) {
      const answer = session.answers.get(String(i));
      if (answer) {
        doc += `**Q:** ${session.questions[i]}\n`;
        doc += `**A:** ${answer}\n\n`;
      }
    }

    doc += `### Implementation Notes\n\n`;
    doc += `- Feature request analyzed and clarified\n`;
    doc += `- ${session.answers.size} questions answered\n`;
    doc += `- Ready for implementation\n`;

    session.designDoc = doc;
    session.status = 'approved';
    session.updatedAt = Date.now();

    return doc;
  }

  /**
   * Get a session by ID.
   */
  getSession(sessionId: string): BrainstormSession | null {
    return this.sessions.get(sessionId) || null;
  }

  /**
   * Get active session for a project.
   */
  getActiveSession(projectId: string): BrainstormSession | null {
    for (const session of this.sessions.values()) {
      if (session.projectId === projectId && (session.status === 'questioning' || session.status === 'designing')) {
        return session;
      }
    }
    return null;
  }

  /**
   * Cancel a brainstorm session.
   */
  cancelSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = 'cancelled';
      session.updatedAt = Date.now();
    }
  }

  /**
   * Get/set config.
   */
  getConfig(): BrainstormConfig { return { ...this.config }; }
  setConfig(config: Partial<BrainstormConfig>): void { Object.assign(this.config, config); }
}
