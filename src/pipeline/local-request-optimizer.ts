/**
 * Local Request Optimizer — Answers trivial messages locally without hitting the LLM.
 *
 * Intercepts simple confirmations, acknowledgments, and meta-queries that don't
 * need AI processing. Saves latency and API costs.
 */

export interface LocalResponse {
  handled: boolean;
  content?: string;
  agent?: string;
}

// Patterns that can be answered locally (case-insensitive)
const CONFIRMATION_PATTERNS = [
  /^(yes|yep|yeah|yup|sure|ok|okay|k|confirm|confirmed|go ahead|proceed|do it|approved)\.?$/i,
  /^(no|nope|nah|cancel|stop|abort|nevermind|never mind)\.?$/i,
  /^(thanks|thank you|thx|ty|cheers)\.?$/i,
  /^(hi|hello|hey|howdy|sup|yo)\.?$/i,
];

// Simple greetings that get a quick local response
const GREETING_RESPONSES: Record<string, string> = {
  hi: "Hey! What can I help you with?",
  hello: "Hello! What would you like to work on?",
  hey: "Hey! Ready to help. What's on your mind?",
  howdy: "Howdy! What can I do for you?",
  sup: "Hey! What are we working on?",
  yo: "Yo! What's up?",
};

// Thank-you responses
const THANKS_RESPONSES = [
  "You're welcome! Let me know if you need anything else.",
  "Happy to help! Anything else?",
  "No problem! What's next?",
];

/**
 * Check if a message can be handled locally without an LLM call.
 * Returns { handled: true, content: "..." } if handled, or { handled: false } if not.
 */
export function tryLocalResponse(message: string): LocalResponse {
  const trimmed = message.trim().toLowerCase().replace(/[.!?]+$/, '');

  // Greetings
  if (GREETING_RESPONSES[trimmed]) {
    return { handled: true, content: GREETING_RESPONSES[trimmed], agent: 'NeuroNest' };
  }

  // Thanks
  if (/^(thanks|thank you|thx|ty|cheers)$/i.test(trimmed)) {
    const resp = THANKS_RESPONSES[Math.floor(Math.random() * THANKS_RESPONSES.length)];
    return { handled: true, content: resp, agent: 'NeuroNest' };
  }

  // Very short messages that are just acknowledgments (don't intercept if they could be confirmations for pending actions)
  // These are only handled if there's no pending confirmation state
  if (trimmed.length <= 2 && /^(k|ok)$/i.test(trimmed)) {
    return { handled: true, content: "Got it! What would you like me to do next?", agent: 'NeuroNest' };
  }

  // "what can you do" / "help" type queries
  if (/^(help|what can you do|what do you do|capabilities|features)$/i.test(trimmed)) {
    return {
      handled: true,
      content: "I can help you with:\n\n" +
        "• **Build projects** — describe what you want and I'll create it\n" +
        "• **Edit files** — rename, delete, create files in your project\n" +
        "• **Code review** — analyze code for bugs, security, performance\n" +
        "• **Research** — look up APIs, libraries, best practices\n" +
        "• **Debug** — help fix errors and issues\n" +
        "• **Explain** — break down complex code or concepts\n\n" +
        "Just describe what you need in plain language!",
      agent: 'NeuroNest',
    };
  }

  return { handled: false };
}

/**
 * Check if a message is a trivial confirmation that should NOT be intercepted
 * (because there's a pending action waiting for confirmation).
 */
export function isConfirmation(message: string): boolean {
  const trimmed = message.trim().toLowerCase().replace(/[.!?]+$/, '');
  return /^(yes|yep|yeah|yup|sure|ok|okay|confirm|confirmed|go ahead|proceed|do it|approved)$/i.test(trimmed);
}

/**
 * Check if a message is a cancellation.
 */
export function isCancellation(message: string): boolean {
  const trimmed = message.trim().toLowerCase().replace(/[.!?]+$/, '');
  return /^(no|nope|nah|cancel|stop|abort|nevermind|never mind)$/i.test(trimmed);
}
