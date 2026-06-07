/**
 * Free Provider Catalog — curated list of free/free-limited LLM providers
 * that users can one-click configure without a credit card.
 *
 * Based on data from free-coding-models project.
 * Tier ratings based on SWE-bench scores: S+ ≥70%, S 60-70%, A 40-60%, B <40%
 */

export interface FreeProviderEntry {
  id: string;
  name: string;
  description: string;
  signupUrl: string;
  apiBaseUrl: string;
  envVar: string;
  models: FreeModelEntry[];
  rateLimit: string;
  requiresCreditCard: boolean;
  tier: 'S+' | 'S' | 'A' | 'B' | 'C';
}

export interface FreeModelEntry {
  id: string;
  name: string;
  tier: 'S+' | 'S' | 'A+' | 'A' | 'B+' | 'B' | 'C';
  contextWindow: number;
  description: string;
}

export const FREE_PROVIDER_CATALOG: FreeProviderEntry[] = [
  {
    id: 'groq',
    name: 'Groq',
    description: 'Ultra-fast inference on custom LPU hardware. Great for real-time coding.',
    signupUrl: 'https://console.groq.com/keys',
    apiBaseUrl: 'https://api.groq.com/openai/v1/chat/completions',
    envVar: 'GROQ_API_KEY',
    requiresCreditCard: false,
    tier: 'S',
    rateLimit: '30 RPM, 1K-14.4K req/day',
    models: [
      { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B', tier: 'S', contextWindow: 128000, description: 'Strong general-purpose coding model' },
      { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B', tier: 'B+', contextWindow: 128000, description: 'Fast, lightweight model for simple tasks' },
      { id: 'mixtral-8x7b-32768', name: 'Mixtral 8x7B', tier: 'A', contextWindow: 32768, description: 'Good balance of speed and quality' },
    ],
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    description: 'Fastest inference available. 1M tokens/day free.',
    signupUrl: 'https://cloud.cerebras.ai',
    apiBaseUrl: 'https://api.cerebras.ai/v1/chat/completions',
    envVar: 'CEREBRAS_API_KEY',
    requiresCreditCard: false,
    tier: 'S+',
    rateLimit: '30 RPM, 1M tokens/day',
    models: [
      { id: 'llama-3.3-70b', name: 'Llama 3.3 70B', tier: 'S', contextWindow: 128000, description: 'High-quality coding at extreme speed' },
      { id: 'qwen-3-32b', name: 'Qwen 3 32B', tier: 'A+', contextWindow: 32768, description: 'Strong multilingual coding model' },
    ],
  },
  {
    id: 'nvidia-nim',
    name: 'NVIDIA NIM',
    description: 'Access to 40+ models including top-tier coding models. No credit card.',
    signupUrl: 'https://build.nvidia.com',
    apiBaseUrl: 'https://integrate.api.nvidia.com/v1/chat/completions',
    envVar: 'NVIDIA_API_KEY',
    requiresCreditCard: false,
    tier: 'S+',
    rateLimit: '~40 RPM',
    models: [
      { id: 'deepseek-ai/deepseek-r1', name: 'DeepSeek R1', tier: 'S+', contextWindow: 128000, description: 'Top reasoning model for complex tasks' },
      { id: 'meta/llama-3.3-70b-instruct', name: 'Llama 3.3 70B', tier: 'S', contextWindow: 128000, description: 'Strong general coding' },
      { id: 'qwen/qwen2.5-coder-32b-instruct', name: 'Qwen 2.5 Coder 32B', tier: 'A+', contextWindow: 32768, description: 'Specialized coding model' },
    ],
  },
  {
    id: 'google-ai-studio',
    name: 'Google AI Studio',
    description: 'Access to Gemini models with generous free quotas.',
    signupUrl: 'https://aistudio.google.com/apikey',
    apiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    envVar: 'GOOGLE_API_KEY',
    requiresCreditCard: false,
    tier: 'S+',
    rateLimit: 'Varies by model/region',
    models: [
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', tier: 'S', contextWindow: 1000000, description: 'Fast with 1M context window' },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', tier: 'S+', contextWindow: 1000000, description: 'Top-tier with massive context' },
    ],
  },
  {
    id: 'github-models',
    name: 'GitHub Models',
    description: 'Free access to top models via GitHub token.',
    signupUrl: 'https://models.github.ai',
    apiBaseUrl: 'https://models.inference.ai.azure.com/chat/completions',
    envVar: 'GITHUB_TOKEN',
    requiresCreditCard: false,
    tier: 'S+',
    rateLimit: 'Depends on GitHub/Copilot tier',
    models: [
      { id: 'gpt-4o', name: 'GPT-4o', tier: 'S+', contextWindow: 128000, description: 'OpenAI flagship model' },
      { id: 'DeepSeek-V3', name: 'DeepSeek V3', tier: 'S', contextWindow: 128000, description: 'Strong open-source coding model' },
    ],
  },
  {
    id: 'mistral',
    name: 'Mistral La Plateforme',
    description: 'European AI lab with strong coding models. Free experiment plan.',
    signupUrl: 'https://console.mistral.ai/api-keys',
    apiBaseUrl: 'https://api.mistral.ai/v1/chat/completions',
    envVar: 'MISTRAL_API_KEY',
    requiresCreditCard: false,
    tier: 'S+',
    rateLimit: '1 req/s, 1B tokens/month',
    models: [
      { id: 'devstral-small-latest', name: 'Devstral Small', tier: 'A+', contextWindow: 128000, description: 'Specialized coding model' },
      { id: 'mistral-large-latest', name: 'Mistral Large', tier: 'S', contextWindow: 128000, description: 'Flagship general model' },
    ],
  },
  {
    id: 'cloudflare-ai',
    name: 'Cloudflare Workers AI',
    description: 'Run AI models on Cloudflare edge network. 10K neurons/day free.',
    signupUrl: 'https://dash.cloudflare.com',
    apiBaseUrl: 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1/chat/completions',
    envVar: 'CLOUDFLARE_API_TOKEN',
    requiresCreditCard: false,
    tier: 'A',
    rateLimit: '10K neurons/day, 300 RPM',
    models: [
      { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', name: 'Llama 3.3 70B', tier: 'S', contextWindow: 128000, description: 'Strong coding on edge' },
      { id: '@cf/qwen/qwen2.5-coder-32b-instruct', name: 'Qwen 2.5 Coder 32B', tier: 'A+', contextWindow: 32768, description: 'Specialized coding' },
    ],
  },
  {
    id: 'openrouter-free',
    name: 'OpenRouter (Free Tier)',
    description: 'Access multiple providers through one API. 50 req/day free.',
    signupUrl: 'https://openrouter.ai/keys',
    apiBaseUrl: 'https://openrouter.ai/api/v1/chat/completions',
    envVar: 'OPENROUTER_API_KEY',
    requiresCreditCard: false,
    tier: 'S+',
    rateLimit: '50 req/day free',
    models: [
      { id: 'qwen/qwen3-coder:free', name: 'Qwen3 Coder (Free)', tier: 'A+', contextWindow: 128000, description: 'Free coding model via OpenRouter' },
      { id: 'google/gemma-3-27b-it:free', name: 'Gemma 3 27B (Free)', tier: 'A', contextWindow: 96000, description: 'Google open model' },
    ],
  },
  {
    id: 'sambanova',
    name: 'SambaNova',
    description: 'Fast inference on custom hardware. Small free developer quota.',
    signupUrl: 'https://cloud.sambanova.ai/apis',
    apiBaseUrl: 'https://api.sambanova.ai/v1/chat/completions',
    envVar: 'SAMBANOVA_API_KEY',
    requiresCreditCard: false,
    tier: 'S',
    rateLimit: 'Small developer quota',
    models: [
      { id: 'DeepSeek-V3-0324', name: 'DeepSeek V3', tier: 'S', contextWindow: 128000, description: 'Strong coding model' },
      { id: 'Qwen3-32B', name: 'Qwen3 32B', tier: 'A+', contextWindow: 32768, description: 'Fast multilingual coding' },
    ],
  },
];

/** Get all free providers */
export function getFreeProviders(): FreeProviderEntry[] {
  return FREE_PROVIDER_CATALOG;
}

/** Get a specific free provider by ID */
export function getFreeProvider(id: string): FreeProviderEntry | undefined {
  return FREE_PROVIDER_CATALOG.find(p => p.id === id);
}

/** Get all models across all free providers, sorted by tier */
export function getAllFreeModels(): Array<FreeModelEntry & { providerId: string; providerName: string }> {
  const tierOrder: Record<string, number> = { 'S+': 0, 'S': 1, 'A+': 2, 'A': 3, 'B+': 4, 'B': 5, 'C': 6 };
  const models: Array<FreeModelEntry & { providerId: string; providerName: string }> = [];
  for (const provider of FREE_PROVIDER_CATALOG) {
    for (const model of provider.models) {
      models.push({ ...model, providerId: provider.id, providerName: provider.name });
    }
  }
  return models.sort((a, b) => (tierOrder[a.tier] || 9) - (tierOrder[b.tier] || 9));
}
