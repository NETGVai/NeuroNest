/**
 * AskSubAgent — Phase 4 / Item 2.
 *
 * The `/ask` chat slash command dispatches user questions through this
 * SubAgentDefinition via the Phase 3 Sub_Agent_Runner. The `toolSubset`
 * is a read-only-by-construction allow-list: zero write tools, no
 * `bash`, no `runPackagedWorkflow`, no media-generation tools. Phase 3's
 * ToolSubsetEnforcer rejects any tool call outside this set with a
 * `disallowed_tool` envelope before the underlying tool is executed.
 *
 * The system prompt is loaded once at module-load time from the
 * co-located `prompt.txt` so authors can edit prompt copy without code
 * changes.
 *
 * _Validates Requirements: 2.2, 2.3, 2.4_
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { JsonSchema, SubAgentDefinition } from '../types';

/**
 * Read-only tool surface available to the Ask_Sub_Agent.
 *
 * Exactly the 12 tool IDs enumerated in the Phase 4 design document
 * § Item 2:
 *
 *   1.  `skills.list`         — read-only enumerator over Skill_Registry
 *   2.  `skills.describe`     — read-only metadata fetch for one skill
 *   3.  `providers.list`      — enumerates configured providers
 *   4.  `mcp.list-servers`    — enumerates configured MCP servers
 *   5.  `mcp.list-tools`      — describes one MCP server's tools
 *   6.  `steering.list`       — enumerates Steering_Files
 *   7.  `steering.read`       — reads one Steering_File
 *   8.  `workflows.list`      — enumerates RegisteredWorkflow entries
 *   9.  `workflows.describe`  — manifest + paramsSchema for one workflow
 *  10. `file-read`            — workspace-bounded file read
 *  11. `web.scrape-url`       — read-only network fetch
 *  12. `web.search-google`    — read-only network search
 *
 * Notably absent — and asserted by Property 4 (`Ask no-write-tools`):
 *   - Write tools: `writeFile`, `writeSpec`, `editSpec`
 *   - Mutating tools: `bash`, `runPackagedWorkflow`
 *   - Media-generation tools: `media.generateImage`, `media.generateAudio`, …
 */
export const ASK_TOOL_SUBSET: ReadonlyArray<string> = Object.freeze([
  'skills.list',
  'skills.describe',
  'providers.list',
  'mcp.list-servers',
  'mcp.list-tools',
  'steering.list',
  'steering.read',
  'workflows.list',
  'workflows.describe',
  'file-read',
  'web.scrape-url',
  'web.search-google',
] as const);

/**
 * Load the curated system prompt text from the co-located `prompt.txt`.
 *
 * Reading happens once at module-load time. The prompt file ships
 * alongside the compiled module — the build pipeline copies it into
 * `dist/agent-skills/sub-agents/ask/prompt.txt` so this resolution
 * works under both `ts-node` and the packaged Electron app.
 */
function loadAskSystemPrompt(): string {
  const promptPath = path.join(__dirname, 'prompt.txt');
  return fs.readFileSync(promptPath, 'utf8');
}

/**
 * JSON Schema for the Ask_Sub_Agent's input payload.
 *
 * The single `question` property is a non-empty string (Req 2.9 — empty
 * `/ask` invocations are intercepted by the dispatcher's help branch
 * and never reach the sub-agent).
 */
const ASK_INPUT_SCHEMA: JsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: false,
  required: ['question'],
  properties: {
    question: {
      type: 'string',
      minLength: 1,
      description:
        'The user-supplied question, as typed after `/ask `. ' +
        'Must be a non-empty string.',
    },
  },
};

/**
 * The SubAgentDefinition registered with the Phase 3 Sub_Agent_Runner.
 * Inherits the parent run's model — no `modelOverride`.
 */
export const AskSubAgent: SubAgentDefinition = {
  id: 'ask',
  displayName: 'Workspace Q&A',
  systemPrompt: loadAskSystemPrompt(),
  toolSubset: ASK_TOOL_SUBSET,
  inputSchema: ASK_INPUT_SCHEMA,
  maxTurns: 8,
};
