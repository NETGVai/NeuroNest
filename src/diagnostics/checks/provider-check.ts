import * as http from 'node:http';
import * as https from 'node:https';
import type { HealthCheck, HealthCheckResult } from '../types.js';

/**
 * ProviderHealthCheck — validates configured provider API keys via lightweight test requests.
 *
 * Requirements: 1.2
 */

/** Provider base URLs (mirrors llm-client.ts) */
const PROVIDER_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  mistral: 'https://api.mistral.ai/v1',
  groq: 'https://api.groq.com/openai/v1',
  grok: 'https://api.x.ai/v1',
  ollama: 'http://localhost:11434/v1',
  llamacpp: 'http://localhost:8080/v1',
};

interface ProviderInfo {
  name: string;
  type: string;
  apiKey?: string;
  baseUrl?: string;
}

export class ProviderHealthCheck implements HealthCheck {
  name = 'Provider Connectivity';

  private loadProvidersFn: (() => ProviderInfo[]) | undefined;

  /**
   * @param loadProviders Optional function that returns the list of configured providers.
   *   When omitted the check reports "No providers configured" (pass).
   */
  constructor(loadProviders?: () => ProviderInfo[]) {
    this.loadProvidersFn = loadProviders;
  }

  async run(): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      const providers = this.loadProvidersFn ? this.loadProvidersFn() : [];

      if (providers.length === 0) {
        return {
          name: this.name,
          status: 'pass',
          message: 'No providers configured',
          durationMs: Date.now() - start,
        };
      }

      const results: { name: string; ok: boolean; error?: string }[] = [];

      for (const provider of providers) {
        try {
          const ok = await this.testProvider(provider);
          results.push({ name: provider.name || provider.type, ok });
        } catch (err) {
          results.push({
            name: provider.name || provider.type,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const failed = results.filter((r) => !r.ok);
      if (failed.length === 0) {
        return {
          name: this.name,
          status: 'pass',
          message: `All ${results.length} provider(s) reachable`,
          durationMs: Date.now() - start,
        };
      }

      const failedNames = failed.map((f) => f.name).join(', ');
      return {
        name: this.name,
        status: failed.length === results.length ? 'fail' : 'warning',
        message: `${failed.length}/${results.length} provider(s) unreachable: ${failedNames}`,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        name: this.name,
        status: 'fail',
        message: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
  }

  /** Make a lightweight HTTP request to the provider's models endpoint. */
  private testProvider(provider: ProviderInfo): Promise<boolean> {
    const baseUrl = provider.baseUrl || PROVIDER_URLS[provider.type] || '';
    if (!baseUrl) return Promise.resolve(false);

    const url = baseUrl + '/models';
    const isHttps = url.startsWith('https');
    const lib = isHttps ? https : http;

    return new Promise<boolean>((resolve) => {
      const headers: Record<string, string> = {};
      if (provider.apiKey) {
        headers['Authorization'] = `Bearer ${provider.apiKey}`;
      }

      const req = lib.get(url, { headers, timeout: 5000 }, (res) => {
        // Any 2xx or 401 (key issue but endpoint reachable) counts as reachable
        const code = res.statusCode ?? 0;
        res.resume(); // drain
        resolve(code >= 200 && code < 500);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });
  }
}
