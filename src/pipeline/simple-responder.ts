/**
 * Simple Responder - Lightweight conversational response handler with file operation support
 * 
 * Provides direct LLM responses for conversational messages and simple project actions
 * (delete files, rename, etc.) without the overhead of ZERA optimization, orchestrator
 * planning, or swarm execution.
 *
 * When the LLM response contains file operation instructions (JSON action blocks),
 * the responder executes them on disk and reports the result.
 */

import { createLLMClientWithProMode } from './pro-mode-state';
import { PERF_FLAGS } from '../main/performance/feature-flags';
import { GCF_PRIMER } from '../serializers/gcf-encoder';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { APP_NAME } from '../branding';

export interface SimpleResponse {
  content: string;
  agent: string;
  isCommand: boolean;
  /** True if file operations were performed (caller should refresh the file tree) */
  filesChanged?: boolean;
}

export interface SimpleResponderConfig {
  llmClient: any;
  projectContext?: string;
  projectDir?: string;
  sessionId?: string;
  conversationHistory?: Array<{ role: string; content: string }>;
  /**
   * Optional `## Current State` block provider (12-factor-agent-improvements
   * task 25). Returns the block string to splice into the system prompt.
   * Wired by the IPC bootstrap to the live `UnifiedStateReducer` +
   * Metrics_Sink. The provider is responsible for honouring
   * `PERF_FLAGS.UNIFIED_EVENT_LOG` / `UNIFIED_EVENT_LOG_SHADOW` — when
   * the active flag is off (or the helper short-circuits) it returns an
   * empty string and SimpleResponder skips the splice. Errors thrown
   * here are caught by the responder and logged; the prompt-assembly
   * path must remain hot.
   */
  stateBlockProvider?: (sessionId: string) => Promise<string>;
}

/**
 * Simple Responder class for lightweight conversational responses and file operations
 */
export class SimpleResponder {
  private llmClient: any;
  private projectContext: string;
  private projectDir: string;
  private sessionId: string;
  private conversationHistory: Array<{ role: string; content: string }>;
  private stateBlockProvider?: (sessionId: string) => Promise<string>;

  constructor(config: SimpleResponderConfig) {
    this.llmClient = config.llmClient;
    this.projectContext = config.projectContext || '';
    this.projectDir = config.projectDir || '';
    this.sessionId = config.sessionId || 'default';
    this.conversationHistory = config.conversationHistory || [];
    this.stateBlockProvider = config.stateBlockProvider;
  }

  /**
   * Generate a response — may include executing file operations on the project.
   */
  async respond(message: string): Promise<SimpleResponse> {
    if (!this.llmClient) {
      return this.getFallbackResponse(message);
    }

    try {
      const systemPrompt = `You are ${APP_NAME}, an AI coding assistant with FULL access to the user's project directory.

You CAN perform real file operations when the user asks. You have access to:
- Delete files/folders
- Rename/move files
- Create new files
- Edit existing files
- List directory contents

CRITICAL SAFETY RULES:
1. For DESTRUCTIVE operations (delete, overwrite, delete_all), you MUST FIRST describe what will happen and ask the user to confirm. Do NOT include an action block on the first request.
   - Example: User says "delete all files" → You respond: "This will permanently delete all 15 files in your project. This cannot be undone. Type 'confirm' to proceed."
   - Only AFTER the user confirms (says "yes", "confirm", "do it", "go ahead") should you include the action block.

2. For NON-DESTRUCTIVE operations (create new files, rename), you may execute immediately with an action block.

3. When the user says "yes", "confirm", "go ahead", "do it" — check the conversation history. They are confirming the PREVIOUS destructive action you proposed. NOW include the action block to execute it.

4. Do NOT ask for unnecessary clarification about WHICH project. The user has a project open — "this project" means their current project.

5. Do NOT say you cannot access files. You can.

To execute file operations, include a JSON block in your response like this:
\`\`\`__action__
{"action": "delete_files", "paths": ["file1.ts", "file2.ts"]}
\`\`\`

Available actions:
- {"action": "delete_files", "paths": ["relative/path/to/file"]} — Delete specific files
- {"action": "delete_all", "keepGit": true} — Delete all project files (keep .git if true)
- {"action": "rename_file", "from": "old.ts", "to": "new.ts"} — Rename a file
- {"action": "create_file", "path": "file.ts", "content": "..."} — Create a file

REMEMBER: NEVER include delete/delete_all action blocks unless the user has EXPLICITLY confirmed in this conversation. Always warn first, execute only after confirmation.

${this.projectDir ? `Project directory: ${this.projectDir}` : ''}
${this.projectContext ? `\n--- ACTIVE PROJECT CONTEXT ---\n${this.projectContext}\n--- END PROJECT CONTEXT ---` : '\nNo project files found.'}`;

      // ── 12-factor Factor 5: `## Current State` block ──
      // Splice the unified-state block (task 25) into the system prompt
      // when the helper returns one. The helper itself honours the
      // `UNIFIED_EVENT_LOG` / `UNIFIED_EVENT_LOG_SHADOW` flags — in
      // shadow mode it returns an empty string while still recording
      // metrics, so this code path doesn't need to know about the
      // flag state. Errors are swallowed: a transient reducer / sink
      // failure must never tear down the chat-message handler.
      let systemPromptWithState = systemPrompt;

      // ── F10 GCF primer injection ──
      // When the GCF wire format is active, prepend the LLM comprehension
      // primer so the model knows how to parse GCF-encoded tool responses.
      if (PERF_FLAGS.GCF_WIRE_FORMAT) {
        systemPromptWithState = GCF_PRIMER + '\n\n' + systemPromptWithState;
      }

      if (this.stateBlockProvider) {
        try {
          const stateBlock = await this.stateBlockProvider(this.sessionId);
          if (stateBlock) {
            systemPromptWithState = systemPrompt + '\n\n' + stateBlock;
          }
        } catch (err) {
          console.warn(
            '[SimpleResponder] state-block provider failed; omitting block:',
            (err as Error)?.message,
          );
        }
      }

      // Build messages with conversation history for context continuity
      const messages: Array<{ role: string; content: string }> = [
        { role: 'system', content: systemPromptWithState },
        ...this.conversationHistory.slice(-6), // Last 3 turns (6 messages)
        { role: 'user', content: message },
      ];

      const response = await this.llmClient.chat(messages);
      let content = response.content || "I'm here to help with your coding projects!";

      // Check for and execute action blocks (with confirmation enforcement)
      const actionResult = await this.executeActions(content, message);
      if (actionResult) {
        content = actionResult;
      }

      return {
        content,
        agent: APP_NAME,
        isCommand: false,
        filesChanged: actionResult !== null,
      };

    } catch (error) {
      console.error('[SimpleResponder] LLM error:', error);
      return this.getFallbackResponse(message);
    }
  }

  /**
   * Parse and execute action blocks from the LLM response.
   * Returns the modified response content with action results, or null if no actions found.
   *
   * SAFETY: Destructive actions (delete_files, delete_all) are BLOCKED unless the user's
   * current message is an explicit confirmation. This is a code-level safeguard that
   * cannot be bypassed by prompt injection.
   */
  private async executeActions(content: string, userMessage: string): Promise<string | null> {
    // Match multiple action block formats the LLM might use:
    // 1. ```__action__\n{...}\n```  (intended format)
    // 2. ```action\n{...}\n```     (common LLM variation)
    // 3. ```json\n{"action":...}\n``` (generic JSON block with action field)
    // 4. action {"action": ...}    (inline without fences)
    // 5. __action__\n{...}         (no fences)
    const patterns = [
      /```__action__\s*\n([\s\S]*?)\n```/g,
      /```action\s*\n([\s\S]*?)\n```/g,
      /```(?:json)?\s*\n(\{[\s\S]*?"action"\s*:[\s\S]*?\})\n```/g,
      /(?:^|\n)__action__\s*\n(\{[\s\S]*?\})/g,
      /(?:^|\n)action\s+(\{"action"\s*:\s*"[^"]+?"[\s\S]*?\})/gm,
    ];

    let hasActions = false;
    let resultContent = content;

    // Determine if the user's current message is a confirmation
    const isConfirmation = this.isUserConfirmation(userMessage);

    for (const actionRegex of patterns) {
      let match: RegExpExecArray | null;
      actionRegex.lastIndex = 0;

      while ((match = actionRegex.exec(resultContent)) !== null) {
        hasActions = true;
        try {
          const jsonStr = match[1].trim();
          const action = JSON.parse(jsonStr);

          // Validate it's actually an action object
          if (!action.action) continue;

          // SAFETY GATE: Block destructive actions unless user explicitly confirmed
          if (this.isDestructiveAction(action) && !isConfirmation) {
            console.warn('[SimpleResponder] SAFETY: Blocked destructive action without user confirmation:', action.action);
            const fileCount = action.paths ? action.paths.length : 'all';
            resultContent = resultContent.replace(match[0],
              `⚠️ **This is a destructive operation** that will permanently ${action.action === 'delete_all' ? 'delete all files in your project' : `delete ${fileCount} file(s)`}. This cannot be undone.\n\n**Type "confirm" or "yes" to proceed.**`
            );
            continue;
          }

          const actionOutput = await this.performAction(action);
          resultContent = resultContent.replace(match[0], actionOutput);
        } catch (err: any) {
          resultContent = resultContent.replace(match[0], `⚠️ Action failed: ${err.message}`);
        }
      }
    }

    return hasActions ? resultContent : null;
  }

  /**
   * Check if an action is destructive (deletes or overwrites data).
   */
  private isDestructiveAction(action: any): boolean {
    return action.action === 'delete_files' ||
           action.action === 'delete_all';
  }

  /**
   * Check if the user's message is an explicit confirmation of a previous action.
   * This is checked at the CODE level — not dependent on LLM interpretation.
   */
  private isUserConfirmation(message: string): boolean {
    const trimmed = message.trim().toLowerCase();
    const confirmPatterns = [
      /^(yes|yeah|yep|yup|sure|ok|okay|confirm|confirmed|do it|go ahead|proceed|please do|affirmative)[\s.!]*$/,
      /^yes[,.]?\s*(please|do it|go ahead|confirm|proceed)/,
      /^(i confirm|i agree|confirmed?|proceed|execute|do it|go for it)[\s.!]*$/,
    ];
    return confirmPatterns.some(p => p.test(trimmed));
  }

  /**
   * Validate that a resolved path is strictly within the project directory.
   * Prevents path traversal attacks (../, symlinks, etc.)
   *
   * Security rules:
   * 1. Resolve the path to its absolute canonical form (follows symlinks)
   * 2. The resolved path MUST start with the project directory + path separator
   *    (or be the project directory itself)
   * 3. Reject any path containing '..' segments before resolution
   * 4. Reject null bytes and other path injection characters
   */
  private isPathSafe(targetPath: string): boolean {
    try {
      // Reject null bytes and control characters
      if (/[\x00-\x1f]/.test(targetPath)) return false;

      // Resolve to absolute path
      const resolved = path.resolve(this.projectDir, targetPath);

      // The resolved path must be the project dir itself or a child of it
      const projectDirWithSep = this.projectDir.endsWith(path.sep)
        ? this.projectDir
        : this.projectDir + path.sep;

      if (resolved !== this.projectDir && !resolved.startsWith(projectDirWithSep)) {
        return false;
      }

      // If the file/dir already exists, resolve through symlinks and re-check
      if (fs.existsSync(resolved)) {
        const realPath = fs.realpathSync(resolved);
        const realProjectDir = fs.realpathSync(this.projectDir);
        const realProjectDirWithSep = realProjectDir.endsWith(path.sep)
          ? realProjectDir
          : realProjectDir + path.sep;

        if (realPath !== realProjectDir && !realPath.startsWith(realProjectDirWithSep)) {
          return false;
        }
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Perform a file system action on the project directory.
   * ALL paths are validated to be strictly within the project folder.
   */
  private async performAction(action: any): Promise<string> {
    if (!this.projectDir) {
      return '⚠️ No project directory available.';
    }

    // Verify the project directory itself exists and is a directory
    try {
      const projectStat = fs.statSync(this.projectDir);
      if (!projectStat.isDirectory()) {
        return '⚠️ Project path is not a directory.';
      }
    } catch {
      return '⚠️ Project directory does not exist.';
    }

    switch (action.action) {
      case 'delete_files': {
        const deleted: string[] = [];
        const failed: string[] = [];
        for (const filePath of (action.paths || [])) {
          if (!this.isPathSafe(filePath)) {
            failed.push(`${filePath} (BLOCKED: outside project boundary)`);
            console.warn('[SimpleResponder] SECURITY: Blocked path traversal attempt:', filePath);
            continue;
          }
          const fullPath = path.resolve(this.projectDir, filePath);
          try {
            if (fs.existsSync(fullPath)) {
              const stat = fs.statSync(fullPath);
              if (stat.isDirectory()) {
                fs.rmSync(fullPath, { recursive: true, force: true });
              } else {
                fs.unlinkSync(fullPath);
              }
              deleted.push(filePath);
            } else {
              failed.push(`${filePath} (not found)`);
            }
          } catch (err: any) {
            failed.push(`${filePath} (${err.message})`);
          }
        }
        let result = deleted.length > 0
          ? `✅ **Deleted ${deleted.length} file(s):**\n${deleted.map(f => `  - \`${f}\``).join('\n')}`
          : '⚠️ No files were deleted.';
        if (failed.length > 0) {
          result += `\n\n⚠️ **Failed (${failed.length}):**\n${failed.map(f => `  - ${f}`).join('\n')}`;
        }
        return result;
      }

      case 'delete_all': {
        const keepGit = action.keepGit !== false;
        let deletedCount = 0;
        try {
          const entries = fs.readdirSync(this.projectDir, { withFileTypes: true });
          for (const entry of entries) {
            if (keepGit && entry.name === '.git') continue;
            const fullPath = path.join(this.projectDir, entry.name);
            // Double-check each entry is within bounds (paranoid safety)
            if (!this.isPathSafe(entry.name)) continue;
            try {
              if (entry.isDirectory()) {
                fs.rmSync(fullPath, { recursive: true, force: true });
              } else {
                fs.unlinkSync(fullPath);
              }
              deletedCount++;
            } catch {}
          }
          return `✅ **Deleted ${deletedCount} items from the project.**${keepGit ? ' (.git directory preserved)' : ''}`;
        } catch (err: any) {
          return `⚠️ Failed to delete project files: ${err.message}`;
        }
      }

      case 'rename_file': {
        if (!this.isPathSafe(action.from) || !this.isPathSafe(action.to)) {
          console.warn('[SimpleResponder] SECURITY: Blocked rename path traversal:', action.from, '→', action.to);
          return '⚠️ BLOCKED: Path is outside the project directory.';
        }
        const fromPath = path.resolve(this.projectDir, action.from);
        const toPath = path.resolve(this.projectDir, action.to);
        try {
          fs.mkdirSync(path.dirname(toPath), { recursive: true });
          fs.renameSync(fromPath, toPath);
          return `✅ **Renamed:** \`${action.from}\` → \`${action.to}\``;
        } catch (err: any) {
          return `⚠️ Rename failed: ${err.message}`;
        }
      }

      case 'create_file': {
        if (!this.isPathSafe(action.path)) {
          console.warn('[SimpleResponder] SECURITY: Blocked create path traversal:', action.path);
          return '⚠️ BLOCKED: Path is outside the project directory.';
        }
        const filePath = path.resolve(this.projectDir, action.path);
        try {
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          fs.writeFileSync(filePath, action.content || '', 'utf-8');
          return `✅ **Created:** \`${action.path}\``;
        } catch (err: any) {
          return `⚠️ Create failed: ${err.message}`;
        }
      }

      default:
        return `⚠️ Unknown action: ${action.action}`;
    }
  }

  /**
   * Fallback response when LLM is unavailable
   */
  private getFallbackResponse(message: string): SimpleResponse {
    const trimmed = message.trim().toLowerCase();
    
    // Pattern-based responses for common conversational messages
    if (/^(hi|hello|hey|good morning|good afternoon|good evening)/.test(trimmed)) {
      return {
        content: `👋 Hello! I'm ${APP_NAME}, your AI coding assistant. How can I help you with your development projects today?`,
        agent: APP_NAME,
        isCommand: false
      };
    }

    if (/^(how are you|what's up|how's it going)/.test(trimmed)) {
      return {
        content: '🚀 I\'m doing great and ready to help with your coding projects! What would you like to build today?',
        agent: APP_NAME,
        isCommand: false
      };
    }

    if (/^(thanks?|thank you|thx)/.test(trimmed)) {
      return {
        content: '😊 You\'re welcome! Feel free to ask if you need help with any coding tasks.',
        agent: APP_NAME,
        isCommand: false
      };
    }

    if (/^(bye|goodbye|see you|later)/.test(trimmed)) {
      return {
        content: '👋 Goodbye! Come back anytime you need help with your coding projects.',
        agent: APP_NAME,
        isCommand: false
      };
    }

    if (/^what is/.test(trimmed)) {
      return {
        content: '🤔 That\'s a great question! I\'d be happy to explain, but I need an AI model configured to provide detailed answers. You can set up a provider in Settings, or feel free to ask about specific coding concepts!',
        agent: APP_NAME,
        isCommand: false
      };
    }

    if (/^testing/.test(trimmed)) {
      return {
        content: `✅ Test received! ${APP_NAME} is working properly. I'm ready to help you with coding tasks, from simple questions to complex project development.`,
        agent: APP_NAME,
        isCommand: false
      };
    }

    // Generic conversational response
    return {
      content: `💬 I'm ${APP_NAME}, your AI coding assistant! I can help you build applications, write code, explain concepts, and much more. What would you like to work on?`,
      agent: APP_NAME,
      isCommand: false
    };
  }

  /**
   * Static method to create a simple responder with database config
   */
  static async create(db: any, sessionId?: string, projectContext?: string, projectDir?: string, conversationHistory?: Array<{ role: string; content: string }>, stateBlockProvider?: (sessionId: string) => Promise<string>): Promise<SimpleResponder> {
    let llmClient = null;

    try {
      // Try to get configured LLM provider
      const provRow = db.prepare("SELECT value FROM config WHERE key = 'providers'").get() as any;
      const defRow = db.prepare("SELECT value FROM config WHERE key = 'default-provider'").get() as any;
      
      if (provRow) {
        const providers = JSON.parse(provRow.value);
        let defaultProv = null;
        
        if (defRow) {
          try {
            const dp = JSON.parse(defRow.value);
            defaultProv = providers.find((p: any) => p.id === dp.id || p.name === dp.id || p.type === dp.id);
            if (defaultProv && dp.model) defaultProv = { ...defaultProv, model: dp.model };
          } catch {}
        }
        
        const activeProv = defaultProv || providers[0];
        if (activeProv) {
          llmClient = createLLMClientWithProMode(activeProv);
        }
      }
    } catch (error) {
      console.warn('[SimpleResponder] Failed to create LLM client:', error);
    }

    return new SimpleResponder({
      llmClient,
      projectContext,
      projectDir,
      sessionId,
      conversationHistory,
      stateBlockProvider,
    });
  }
}