/**
 * Embedding Provider Configuration
 *
 * Maps provider types to their embedding model, endpoint, and dimensions.
 * Used by the Indexing & Intelligence settings UI and the embedding daemon.
 */

export interface EmbeddingProviderSpec {
  type: 'ollama' | 'openai' | 'mistral' | 'gemini';
  label: string;
  model: string;
  endpoint: string;
  dimensions: number;
  requiresApiKey: boolean;
}

/**
 * All supported embedding providers with their default configurations.
 * Model names are defaults — the system will query the provider for available
 * embedding models at runtime and use the first available one.
 */
export const EMBEDDING_PROVIDERS: EmbeddingProviderSpec[] = [
  {
    type: 'ollama',
    label: 'Ollama (local)',
    model: '', // Auto-detected from Ollama's installed models
    endpoint: 'http://localhost:11434',
    dimensions: 768,
    requiresApiKey: false,
  },
  {
    type: 'openai',
    label: 'OpenAI',
    model: '', // Auto-detected via /v1/models endpoint
    endpoint: 'https://api.openai.com',
    dimensions: 1536,
    requiresApiKey: true,
  },
  {
    type: 'mistral',
    label: 'Mistral',
    model: '', // Auto-detected via /v1/models endpoint
    endpoint: 'https://api.mistral.ai',
    dimensions: 1024,
    requiresApiKey: true,
  },
  {
    type: 'gemini',
    label: 'Google Gemini',
    model: '', // Auto-detected via API
    endpoint: 'https://generativelanguage.googleapis.com',
    dimensions: 768,
    requiresApiKey: true,
  },
];

/**
 * Known embedding model patterns per provider.
 * Used to identify embedding models from a provider's model list.
 * Order matters — first match wins (prefer smaller/faster models).
 */
export const EMBEDDING_MODEL_PATTERNS: Record<string, RegExp[]> = {
  ollama: [
    /nomic-embed/i,
    /mxbai-embed/i,
    /all-minilm/i,
    /snowflake-arctic-embed/i,
    /embed/i,
  ],
  openai: [
    /text-embedding-3-small/i,
    /text-embedding-3-large/i,
    /text-embedding-ada/i,
    /embedding/i,
  ],
  mistral: [
    /mistral-embed/i,
    /embed/i,
  ],
  gemini: [
    /text-embedding/i,
    /embedding/i,
  ],
};

/**
 * Get the embedding provider spec for a given type.
 */
export function getEmbeddingProviderSpec(type: string): EmbeddingProviderSpec | undefined {
  return EMBEDDING_PROVIDERS.find(p => p.type === type);
}

/**
 * Discover the best available embedding model from a provider's model list.
 * Returns the model name or null if no embedding model is found.
 */
export function findBestEmbeddingModel(providerType: string, availableModels: string[]): string | null {
  const patterns = EMBEDDING_MODEL_PATTERNS[providerType];
  if (!patterns || availableModels.length === 0) return null;

  // Try each pattern in priority order
  for (const pattern of patterns) {
    const match = availableModels.find(m => pattern.test(m));
    if (match) return match;
  }

  return null;
}

/**
 * Provider types that support embeddings.
 * Used to filter the user's configured providers in the UI.
 */
export const EMBEDDING_CAPABLE_TYPES = new Set(['ollama', 'openai', 'mistral', 'gemini']);
