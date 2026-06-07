/**
 * Provider Catalog — Structured metadata about supported AI providers.
 *
 * Lists each provider's capabilities, default endpoints, and features.
 * Used for auto-configuration, validation, and UI display.
 */

export interface ProviderCapabilities {
  streaming: boolean;
  toolUse: boolean;
  embeddings: boolean;
  vision: boolean;
  maxContextTokens: number;
  rateLimitRPM?: number; // Requests per minute (0 = unlimited)
}

export interface ProviderCatalogEntry {
  type: string;
  name: string;
  endpoint: string;
  capabilities: ProviderCapabilities;
  requiresApiKey: boolean;
  isLocal: boolean;
  description: string;
}

export const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  {
    type: 'openai',
    name: 'OpenAI',
    endpoint: 'https://api.openai.com/v1',
    capabilities: { streaming: true, toolUse: true, embeddings: true, vision: true, maxContextTokens: 128000, rateLimitRPM: 500 },
    requiresApiKey: true,
    isLocal: false,
    description: 'GPT-4o, GPT-4, GPT-3.5 — general purpose, strong reasoning',
  },
  {
    type: 'anthropic',
    name: 'Anthropic',
    endpoint: 'https://api.anthropic.com/v1',
    capabilities: { streaming: true, toolUse: true, embeddings: false, vision: true, maxContextTokens: 200000, rateLimitRPM: 60 },
    requiresApiKey: true,
    isLocal: false,
    description: 'Claude 3.5 Sonnet, Claude 3 Opus — excellent for code and analysis',
  },
  {
    type: 'deepseek',
    name: 'DeepSeek',
    endpoint: 'https://api.deepseek.com/v1',
    capabilities: { streaming: true, toolUse: true, embeddings: false, vision: false, maxContextTokens: 64000, rateLimitRPM: 60 },
    requiresApiKey: true,
    isLocal: false,
    description: 'DeepSeek V3, DeepSeek Coder — strong coding, cost-effective',
  },
  {
    type: 'gemini',
    name: 'Google Gemini',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai',
    capabilities: { streaming: true, toolUse: true, embeddings: true, vision: true, maxContextTokens: 1000000, rateLimitRPM: 60 },
    requiresApiKey: true,
    isLocal: false,
    description: 'Gemini Pro, Gemini Flash — massive context, multimodal',
  },
  {
    type: 'mistral',
    name: 'Mistral',
    endpoint: 'https://api.mistral.ai/v1',
    capabilities: { streaming: true, toolUse: true, embeddings: true, vision: false, maxContextTokens: 128000, rateLimitRPM: 120 },
    requiresApiKey: true,
    isLocal: false,
    description: 'Mistral Large, Codestral — fast, efficient, good for code',
  },
  {
    type: 'groq',
    name: 'Groq',
    endpoint: 'https://api.groq.com/openai/v1',
    capabilities: { streaming: true, toolUse: true, embeddings: false, vision: false, maxContextTokens: 32000, rateLimitRPM: 30 },
    requiresApiKey: true,
    isLocal: false,
    description: 'Ultra-fast inference — Llama, Mixtral on custom hardware',
  },
  {
    type: 'grok',
    name: 'Grok (xAI)',
    endpoint: 'https://api.x.ai/v1',
    capabilities: { streaming: true, toolUse: true, embeddings: false, vision: false, maxContextTokens: 128000, rateLimitRPM: 60 },
    requiresApiKey: true,
    isLocal: false,
    description: 'Grok — real-time knowledge, strong reasoning',
  },
  {
    type: 'nvidia',
    name: 'NVIDIA NIM',
    endpoint: 'https://integrate.api.nvidia.com/v1',
    capabilities: { streaming: true, toolUse: true, embeddings: true, vision: false, maxContextTokens: 128000, rateLimitRPM: 100 },
    requiresApiKey: true,
    isLocal: false,
    description: 'NVIDIA NIM — optimized inference for many models',
  },
  {
    type: 'ollama',
    name: 'Ollama (Local)',
    endpoint: 'http://localhost:11434/v1',
    capabilities: { streaming: true, toolUse: true, embeddings: true, vision: true, maxContextTokens: 8192, rateLimitRPM: 0 },
    requiresApiKey: false,
    isLocal: true,
    description: 'Local models — Llama, Mistral, Phi, Gemma, and more',
  },
  {
    type: 'llamacpp',
    name: 'llama.cpp (Local)',
    endpoint: 'http://localhost:8080/v1',
    capabilities: { streaming: true, toolUse: true, embeddings: false, vision: false, maxContextTokens: 8192, rateLimitRPM: 0 },
    requiresApiKey: false,
    isLocal: true,
    description: 'Local GGUF models — maximum control over inference',
  },
  {
    type: 'openmythos',
    name: 'OpenMythos (Local)',
    endpoint: 'http://localhost:8200/v1',
    capabilities: { streaming: true, toolUse: true, embeddings: false, vision: false, maxContextTokens: 32000, rateLimitRPM: 0 },
    requiresApiKey: false,
    isLocal: true,
    description: 'OpenMythos — local model server with GPU optimization',
  },
];

/**
 * Get catalog entry for a provider type.
 */
export function getProviderCatalogEntry(type: string): ProviderCatalogEntry | undefined {
  return PROVIDER_CATALOG.find(p => p.type === type);
}

/**
 * Get the effective catalog entry for a provider type, accounting for professional mode.
 *
 * In professional mode, all non-local providers are routed through the LLM proxy
 * (`llm.neuronest.cc`), so individual API keys are no longer required on the client.
 * This wrapper returns the base entry with `requiresApiKey` overridden to `false`
 * for non-local providers when professional mode is enabled. Local entries
 * (`isLocal: true`) are returned unchanged in both modes.
 *
 * The raw `getProviderCatalogEntry` is preserved for tests and other consumers that
 * need the unmodified base entry; only call sites that drive UI for `requiresApiKey`
 * or settings validation should query through this wrapper.
 *
 * Requirements: 2.1, 2.7
 */
export function effectiveCatalogEntry(
  type: string,
  professionalMode: boolean,
): ProviderCatalogEntry | undefined {
  const base = getProviderCatalogEntry(type);
  if (!base) return undefined;
  if (professionalMode && !base.isLocal) {
    return { ...base, requiresApiKey: false };
  }
  return base;
}

/**
 * Get capabilities for a provider type.
 */
export function getProviderCapabilities(type: string): ProviderCapabilities | null {
  const entry = PROVIDER_CATALOG.find(p => p.type === type);
  return entry?.capabilities ?? null;
}

/**
 * Check if a provider supports a specific capability.
 */
export function providerSupports(type: string, capability: keyof ProviderCapabilities): boolean {
  const caps = getProviderCapabilities(type);
  if (!caps) return false;
  return !!caps[capability];
}

/**
 * Get all providers that support a specific capability.
 */
export function getProvidersWithCapability(capability: keyof ProviderCapabilities): ProviderCatalogEntry[] {
  return PROVIDER_CATALOG.filter(p => !!p.capabilities[capability]);
}
