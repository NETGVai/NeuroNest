/**
 * Message Router - Intent classification and routing logic
 * 
 * Classifies user messages by intent and routes them appropriately:
 * - Conversational messages → Simple responder
 * - Build tasks → Orchestrator pipeline
 * - Skill-specific tasks → Skill routing system
 *
 * When the `unified_intent_gate` feature flag is enabled, all classification
 * is delegated to the IntentGate cascade. Legacy paths remain active when
 * the flag is disabled (Requirements: 1.6, 14.1).
 */

import { classifyIntent } from './intent-classifier';
import type { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';
import type { IIntentGate, SessionContext } from './intent-gate.js';
import { routeWithIntentGate } from './intent-gate-router.js';

export interface MessageIntent {
  type: 'conversational' | 'build_task' | 'skill_specific' | 'complex_orchestration' | 'clarification';
  confidence: number;
  reasoning: string;
}

export interface RoutingDecision {
  route: 'simple_responder' | 'orchestrator_pipeline' | 'skill_routing' | 'clarification';
  intent: MessageIntent;
}

/**
 * Classifies the intent of a user message.
 * 
 * Uses the enhanced intent classifier (classifyIntent) as the primary
 * classification mechanism. Falls through to legacy pattern-based logic
 * only when the new classifier returns 'ambiguous' with high confidence
 * (>= 0.7), indicating the signals are close and the old heuristics
 * may provide better disambiguation.
 */
export function classifyMessageIntent(message: string): MessageIntent {
  // --- New classifier gets first priority ---
  const result = classifyIntent(message);

  if (result.intent === 'informational') {
    return {
      type: 'conversational',
      confidence: result.confidence,
      reasoning: `Intent classifier: informational (signals: ${result.signals.map(s => s.pattern).join(', ')})`
    };
  }

  if (result.intent === 'execution') {
    return {
      type: 'build_task',
      confidence: result.confidence,
      reasoning: `Intent classifier: execution (signals: ${result.signals.map(s => s.pattern).join(', ')})`
    };
  }

  // result.intent === 'ambiguous'
  if (result.confidence < 0.7 && result.confidence > 0) {
    // Low confidence ambiguous with SOME signals detected — route to clarification
    // When confidence is exactly 0 (no signals matched at all), fall through to
    // legacy logic which has broader pattern coverage
    return {
      type: 'clarification',
      confidence: result.confidence,
      reasoning: `Intent classifier: ambiguous with low confidence (${result.confidence.toFixed(2)}) — requesting user clarification`
    };
  }

  // --- Ambiguous with high confidence (>= 0.7) — fall through to legacy logic ---
  const trimmed = message.trim().toLowerCase();
  
  // Build task patterns - development, coding, project creation (check first for high confidence)
  const buildTaskPatterns = [
    /create.*(app|application|project|website|api|service|component|function|class|module)/,
    /build.*(app|application|project|website|api|service|component|function|class|module)/,
    /develop.*(app|application|project|website|api|service|component|function|class|module)/,
    /make.*(app|application|project|website|api|service|component|function|class|module)/,
    /generate.*(code|component|function|class|module|api|rest|endpoint|file|script)/,
    /write.*(code|function|class|component|test|script|program)/,
    /implement.*(feature|functionality|system|module|algorithm|logic)/,
    /add.*(feature|functionality|component|page|endpoint|route)/,
    /fix.*(bug|issue|error|problem|code)/,
    /refactor.*(code|function|class|component|module)/,
    /optimize.*(code|performance|database|query|algorithm)/,
    /deploy.*(app|application|service|website|code)/,
    /setup.*(environment|project|database|server|development)/,
    /configure.*(server|database|api|service|environment)/,
    /install.*(package|dependency|library|framework)/,
    /update.*(code|package|dependency|version)/,
    /debug.*(code|issue|error|problem)/,
    /test.*(code|function|component|api|endpoint)/,
  ];

  // Complex orchestration patterns - multi-step, multi-agent tasks
  const complexOrchestrationPatterns = [
    /create.*and.*deploy/,
    /build.*with.*integration/,
    /setup.*entire.*stack/,
    /full.*stack.*application/,
    /microservices.*architecture/,
    /ci\/cd.*pipeline/,
    /automated.*testing.*deployment/,
    /multi.*step.*process/,
    /orchestrate.*multiple/,
  ];

  // Anti-build patterns - explicit statements that this is NOT a build task
  const antiBuildPatterns = [
    /not.*ask.*to.*build/,
    /don't.*build/,
    /no.*code/,
    /no.*programming/,
    /just.*tell.*me/,
    /just.*let.*me.*know/,
    /just.*want.*to.*know/,
    /information.*only/,
    /just.*asking/,
    /just.*curious/,
  ];

  // Informational/conversational patterns - questions, requests for information
  const conversationalPatterns = [
    /^(hi|hello|hey|good morning|good afternoon|good evening)\b/,
    /^(how are you|what's up|how's it going)/,
    /^(thanks?|thank you|thx)\b/,
    /^(bye|goodbye|see you|later)\b/,
    /^(yes|no|ok|okay|sure|alright|yep|yeah|nope|nah)$/,
    /^(yes|yeah|yep|sure|ok|okay|alright|confirm|confirmed|do it|go ahead|proceed|please do)(\s|!|\.)*$/,
    /^testing$/,
    /what.*is.*the.*weather/,
    /what.*weather/,
    /tell.*me.*about(?!.*(code|api|project|app|build|deploy|server|database))/,
    /what.*does.*mean/,
    /give.*me.*information/,
    /i.*want.*to.*know(?!.*(how to|build|create|deploy|setup))/,
  ];

  // Check for explicit anti-build patterns first
  for (const pattern of antiBuildPatterns) {
    if (pattern.test(trimmed)) {
      return {
        type: 'conversational',
        confidence: 0.95,
        reasoning: 'Message explicitly states it is not a build request'
      };
    }
  }

  // Check for complex orchestration patterns (highest priority for build tasks)
  for (const pattern of complexOrchestrationPatterns) {
    if (pattern.test(trimmed)) {
      return {
        type: 'complex_orchestration',
        confidence: 0.9,
        reasoning: 'Message indicates complex multi-step orchestration task'
      };
    }
  }

  // Check for explicit build task patterns
  for (const pattern of buildTaskPatterns) {
    if (pattern.test(trimmed)) {
      return {
        type: 'build_task',
        confidence: 0.85,
        reasoning: 'Message matches explicit build/development task pattern'
      };
    }
  }

  // Check for conversational patterns
  for (const pattern of conversationalPatterns) {
    if (pattern.test(trimmed)) {
      return {
        type: 'conversational',
        confidence: 0.9,
        reasoning: 'Message matches conversational/informational pattern'
      };
    }
  }

  // Check for skill-specific patterns (basic heuristics)
  if (trimmed.includes('skill') || trimmed.includes('template') || trimmed.includes('design pattern')) {
    return {
      type: 'skill_specific',
      confidence: 0.7,
      reasoning: 'Message may be skill-specific'
    };
  }

  // Analyze message characteristics for classification
  const wordCount = trimmed.split(/\s+/).length;
  const hasCodeKeywords = /\b(code|programming|function|class|variable|algorithm|database|server|framework|library|npm|git|repository|commit|branch|deploy|build|compile|debug|api|endpoint|json|xml|html|css|javascript|typescript|python|java|react|angular|vue|node|express)\b/.test(trimmed);
  const hasActionKeywords = /\b(run|execute|start|stop|scan|analyze|check|review|migrate|convert|transform|integrate|connect|setup|init|scaffold|bootstrap|generate|automate|monitor|profile|benchmark|lint|format|validate|parse|render|compile|transpile|bundle|minify|containerize|dockerize|provision|orchestrate)\b/.test(trimmed);
  const hasInformationalKeywords = /\b(what|why|when|where|who|tell|explain|information|about|weather|news|facts|definition|meaning)\b/.test(trimmed);

  // Detect interrogative sentences — questions ABOUT doing something, not commands TO do it
  // "Can I build X?" / "Is it possible to X?" / "How do I X?" / "What is X?" / "Should I use X?"
  const isInterrogative = /^(can i|could i|is it|are there|do i|does it|how do|how can|how to|what is|what are|what does|should i|would it|will it|is there|have you|did you|where do|where can|when should|why does|why is|which|whom)\b/i.test(trimmed) ||
    trimmed.endsWith('?');

  // Questions about code topics are conversational (answered by simple responder), not build tasks
  const isQuestionAboutCode = isInterrogative && hasCodeKeywords;
  const isPureQuestion = (hasInformationalKeywords && !hasActionKeywords) || isQuestionAboutCode;

  // If message is a question (even about code), route to conversational (simple responder)
  if (isPureQuestion) {
    return {
      type: 'conversational',
      confidence: 0.85,
      reasoning: isQuestionAboutCode
        ? 'Interrogative sentence about code — answering, not executing'
        : 'Message appears to be asking for information or explanation'
    };
  }

  // If message has code-related OR action keywords AND is imperative (not a question), route to pipeline
  if ((hasCodeKeywords || hasActionKeywords) && !isInterrogative) {
    return {
      type: 'build_task',
      confidence: 0.75,
      reasoning: 'Imperative message with code-related or action keywords'
    };
  }

  // If it's a question with action keywords (e.g., "how do I deploy?"), still conversational
  if (isInterrogative) {
    return {
      type: 'conversational',
      confidence: 0.8,
      reasoning: 'Interrogative sentence — routing to simple responder for direct answer'
    };
  }

  // Short messages (< 5 words) without any task indicators are likely conversational
  if (wordCount < 5 && !hasCodeKeywords && !hasActionKeywords) {
    return {
      type: 'conversational',
      confidence: 0.75,
      reasoning: 'Very short message without task indicators'
    };
  }

  // Medium-to-long messages without clear conversational patterns
  // Only route to pipeline if there are SOME code/action indicators
  if (wordCount >= 5) {
    // Check for file operation verbs that indicate a simple action, not a build task
    const hasFileOpVerbs = /\b(delete|remove|rename|move|copy|clean|clear|reset|list|show|find|search)\b/.test(trimmed);
    if (hasFileOpVerbs) {
      return {
        type: 'conversational',
        confidence: 0.7,
        reasoning: 'Message contains file operation verbs — routing to simple responder'
      };
    }
    return {
      type: 'build_task',
      confidence: 0.6,
      reasoning: 'Non-trivial message routed to pipeline for ZERA classification'
    };
  }

  // Fallback: short ambiguous messages
  return {
    type: 'conversational',
    confidence: 0.5,
    reasoning: 'Short ambiguous message without clear task indicators'
  };
}

/**
 * Determines routing based on message intent
 */
export function determineRouting(intent: MessageIntent): RoutingDecision {
  switch (intent.type) {
    case 'conversational':
      return {
        route: 'simple_responder',
        intent
      };
    
    case 'clarification':
      return {
        route: 'clarification',
        intent
      };
    
    case 'skill_specific':
      return {
        route: 'skill_routing',
        intent
      };
    
    case 'build_task':
    case 'complex_orchestration':
      return {
        route: 'orchestrator_pipeline',
        intent
      };
    
    default:
      // Fallback to simple responder for unknown intents
      return {
        route: 'simple_responder',
        intent: {
          ...intent,
          type: 'conversational'
        }
      };
  }
}

/**
 * Main routing function - classifies intent and determines routing (synchronous, pattern-based)
 */
export function routeMessage(message: string): RoutingDecision {
  const intent = classifyMessageIntent(message);
  return determineRouting(intent);
}

/**
 * Async routing function that uses an LLM for intent classification.
 * Falls back to pattern-based classification if the LLM is unavailable or fails.
 *
 * This provides much more accurate classification than regex patterns because
 * a reasoning model understands natural language nuance (e.g., "can you delete
 * files from the project?" is a polite imperative, not a capability question).
 */
export async function routeMessageWithLLM(message: string, llmClient: any): Promise<RoutingDecision> {
  if (llmClient) {
    try {
      const { classifyIntentWithLLM } = await import('./llm-intent-classifier');
      const llmResult = await classifyIntentWithLLM(message, llmClient);

      if (llmResult) {
        let intentType: MessageIntent['type'];
        
        switch (llmResult.intent) {
          case 'informational':
            intentType = 'conversational';
            break;
          case 'simple_action':
            // Simple actions (file ops, single edits) go to simple responder
            // which has project context and can handle them via a single LLM call
            intentType = 'conversational';
            break;
          case 'build_task':
            intentType = 'build_task';
            break;
          default:
            intentType = 'clarification';
            break;
        }

        const intent: MessageIntent = {
          type: intentType,
          confidence: llmResult.confidence,
          reasoning: `LLM classifier: ${llmResult.intent} — ${llmResult.reasoning}`,
        };

        console.log('[MessageRouter] LLM classification:', llmResult.intent, 'confidence:', llmResult.confidence, 'reasoning:', llmResult.reasoning);
        return determineRouting(intent);
      }
    } catch (err: any) {
      console.warn('[MessageRouter] LLM classification failed, falling back to patterns:', err?.message);
    }
  }

  // Fallback to pattern-based classification
  return routeMessage(message);
}


/**
 * Unified routing function that uses the IntentGate when the `unified_intent_gate`
 * feature flag is enabled. Falls back to legacy `routeMessageWithLLM` / `routeMessage`
 * when the flag is disabled, preserving backward compatibility.
 *
 * This is the recommended entry point for all message routing when the IntentGate
 * subsystem is available.
 *
 * Requirements: 1.3, 1.4, 1.5, 1.6, 14.1
 */
export async function routeMessageUnified(
  message: string,
  llmClient: any,
  options?: {
    intentGate?: IIntentGate;
    featureGate?: FeatureGateSystem;
    sessionContext?: SessionContext;
  },
): Promise<RoutingDecision> {
  // Attempt IntentGate routing when all required components are available
  if (options?.intentGate && options?.featureGate) {
    const sessionContext: SessionContext = options.sessionContext ?? {
      recentTurns: [],
      activeInterview: false,
      activeOrchestration: false,
      lastAssistantSubject: null,
    };

    const result = await routeWithIntentGate(
      message,
      sessionContext,
      options.intentGate,
      options.featureGate,
    );

    if (result !== null) {
      console.log(
        '[MessageRouter] IntentGate classification:',
        result.decision.intent,
        'confidence:', result.decision.confidence,
        'stage:', result.decision.stage,
        'route:', result.route,
      );
      return result.legacyCompat;
    }
    // result === null means flag is disabled — fall through to legacy
  }

  // Legacy fallback: use LLM-based or pattern-based classification
  if (llmClient) {
    return routeMessageWithLLM(message, llmClient);
  }
  return routeMessage(message);
}
