/**
 * Web Browser — Agent web browsing capability.
 *
 * Enables agents to fetch web pages, extract content, search the web,
 * and read documentation. Uses Node.js fetch (no Playwright dependency).
 * Lightweight approach suitable for Electron desktop app.
 */

import { wrapUntrusted } from './untrusted-context';
import { recordUntrustedWrap, type MetricsSink } from './untrusted-telemetry';
import { PERF_FLAGS } from '../main/performance/feature-flags';
import { currentDateContext } from './date-grounding';

/**
 * Optional F1 telemetry plumbing for {@link browsePage}. When a
 * `metricsSink` is supplied, the on-path wrap records
 * `untrusted_wrap.invocations` / `untrusted_wrap.wrapped_bytes` to the
 * Metrics_Sink (Requirements 5.5, 5.6). Fully optional and fail-soft so the
 * pre-existing call signature keeps working.
 */
export interface BrowseTelemetryOptions {
  /** Metrics_Sink for F1 wrap telemetry (e.g. `SessionTelemetryService`). */
  metricsSink?: MetricsSink | null;
  /** Session id for the metric sample. Null/omitted records a global metric. */
  sessionId?: string | null;
}

export interface BrowseRequest {
  url?: string;
  searchQuery?: string;
  extractSelector?: string; // CSS selector to extract specific content
  maxLength?: number;
}

export interface BrowseResult {
  success: boolean;
  url: string;
  title: string;
  content: string;
  links: Array<{ text: string; href: string }>;
  error?: string;
  durationMs: number;
}

/**
 * Fetch a web page and extract readable content (raw, unwrapped).
 *
 * This is the pre-existing fetch/extract path. It performs no F1
 * Untrusted_Source_Wrapper framing so internal consumers (e.g.
 * {@link webSearch}, which JSON-parses the DuckDuckGo response body) can read
 * the verbatim fetched content. The public {@link browsePage} entry point
 * applies the F1 wrap on top of this result.
 */
async function fetchPageRaw(request: BrowseRequest): Promise<BrowseResult> {
  const start = Date.now();
  const maxLen = request.maxLength || 50000;

  if (!request.url) {
    return { success: false, url: '', title: '', content: '', links: [], error: 'No URL provided', durationMs: 0 };
  }

  try {
    const response = await fetch(request.url, {
      headers: {
        'User-Agent': 'NeuroNest/1.0 (AI Development Environment)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      return { success: false, url: request.url, title: '', content: '', links: [], error: `HTTP ${response.status}`, durationMs: Date.now() - start };
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const json = await response.json();
      return {
        success: true, url: request.url, title: request.url,
        content: JSON.stringify(json, null, 2).slice(0, maxLen),
        links: [], durationMs: Date.now() - start,
      };
    }

    const html = await response.text();

    // Extract title
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim().replace(/\s+/g, ' ') : request.url;

    // Extract readable text content (strip HTML tags)
    let content = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();

    // Extract links
    const links: Array<{ text: string; href: string }> = [];
    const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let linkMatch;
    while ((linkMatch = linkRegex.exec(html)) !== null && links.length < 20) {
      const href = linkMatch[1];
      const text = linkMatch[2].replace(/<[^>]+>/g, '').trim();
      if (text && href && !href.startsWith('#') && !href.startsWith('javascript:')) {
        links.push({ text: text.slice(0, 100), href });
      }
    }

    return {
      success: true, url: request.url, title,
      content: content.slice(0, maxLen),
      links, durationMs: Date.now() - start,
    };
  } catch (e: any) {
    return { success: false, url: request.url, title: '', content: '', links: [], error: e.message, durationMs: Date.now() - start };
  }
}

/**
 * Fetch a web page and extract readable content.
 *
 * When `PERF_FLAGS.UNTRUSTED_SOURCE_WRAP` is enabled (F1), the fetched page
 * content on the success path is routed through the Untrusted_Wrapper
 * ({@link wrapUntrusted}) with the requested URL as its label, so the LLM
 * frames the page body as untrusted external data rather than operator
 * instructions (Requirement 5.1). Only the `content` field is wrapped; the
 * `title`, `links`, and other metadata are left untouched. When the flag is
 * disabled, the result is forwarded via the pre-existing unwrapped path
 * exactly (Requirement 4.4).
 *
 * Failure results (no URL, HTTP error, fetch exception) carry no fetched
 * third-party content, so they are returned unwrapped regardless of the flag.
 *
 * When `opts.metricsSink` is supplied and the content is wrapped, F1 telemetry
 * (`untrusted_wrap.invocations` + `untrusted_wrap.wrapped_bytes`) is recorded
 * for the single wrapped segment (Requirements 5.5, 5.6). Telemetry is
 * fail-soft and only emitted on an actual wrap, so counts are never
 * double-recorded.
 */
export async function browsePage(
  request: BrowseRequest,
  opts?: BrowseTelemetryOptions,
): Promise<BrowseResult> {
  const result = await fetchPageRaw(request);

  if (PERF_FLAGS.UNTRUSTED_SOURCE_WRAP && result.success) {
    // F1 on-path: frame the fetched page body with the Untrusted_Source_Wrapper
    // delimiters + policy header, labeled with the source URL.
    const wrapped = wrapUntrusted(result.content, result.url);
    // Record F1 telemetry for this single wrapped segment (Requirements 5.5, 5.6).
    recordUntrustedWrap(opts?.metricsSink, wrapped, opts?.sessionId ?? null);
    return { ...result, content: wrapped };
  }

  return result;
}

/**
 * F5 Date_Grounding_Preamble for the web-browser search query-generation path
 * (Requirement 34.2).
 *
 * `webSearch` itself performs **no LLM query rewrite** — it consumes an
 * already-formed query and builds the DuckDuckGo request URL from it verbatim
 * (see {@link webSearch}), so there is no year-sensitive query-generation
 * prompt inside this module to ground. The design's F5 call-site table notes
 * this site as "`webSearch(query)` query-rewrite step (if any)"; the "(if any)"
 * is the operative clause here.
 *
 * To still satisfy Requirement 34.2, this helper is exported for any caller
 * that *does* build search queries via an LLM prompt (today or in future):
 * prepend it to the query-generation prompt body so the model grounds
 * "latest"/"current"/"this year" references in the real current date instead
 * of a training-cutoff year. It mirrors `iterative-refinement.ts`'s
 * `buildRefinementPrompt` shape and is gated by `DATE_GROUNDING_ENABLED`:
 *
 * - When the flag is `true`, returns `currentDateContext(now) + prompt`.
 * - When the flag is `false`, returns `prompt` unchanged.
 *
 * The function is pure given a frozen clock — callers may inject `now` to get
 * byte-identical output for the same input (tests).
 *
 * @param prompt - The search-query-generation prompt body bound for the LLM.
 * @param now - Optional reference date forwarded to {@link currentDateContext}
 *   for deterministic output under a frozen clock.
 * @returns The prompt, optionally prefixed with the current-date preamble.
 *
 * Validates: Requirement 34.2
 */
export function groundSearchQueryPrompt(prompt: string, now?: Date): string {
  if (PERF_FLAGS.DATE_GROUNDING_ENABLED) {
    return currentDateContext(now) + prompt;
  }
  return prompt;
}

/**
 * Search the web using a simple search API.
 *
 * Calls the raw fetch path ({@link fetchPageRaw}) rather than the public
 * {@link browsePage} so the DuckDuckGo JSON response body can be parsed below;
 * routing through the F1-wrapping `browsePage` would frame the JSON in
 * delimiters and break the parse. This preserves `webSearch`'s pre-existing
 * behavior exactly. The F1 wrapping of fetched page content is scoped to
 * `browsePage` per the design's call-site table (Requirement 5.1).
 *
 * F5 note (Requirement 34.2): `webSearch` uses the supplied `query` **verbatim**
 * to build the DuckDuckGo request URL — there is no LLM query-rewrite step in
 * this path, so there is no stale-year generation prompt to ground here. The
 * date-grounding preamble for query-generation callers is provided by the
 * exported {@link groundSearchQueryPrompt} helper above.
 */
export async function webSearch(query: string): Promise<BrowseResult> {
  // Use DuckDuckGo instant answer API (no API key needed).
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const result = await fetchPageRaw({ url, maxLength: 20000 });

  if (result.success) {
    try {
      const data = JSON.parse(result.content);
      const parts: string[] = [];
      if (data.AbstractText) parts.push(data.AbstractText);
      if (data.Answer) parts.push(`Answer: ${data.Answer}`);
      if (data.RelatedTopics) {
        for (const topic of data.RelatedTopics.slice(0, 5)) {
          if (topic.Text) parts.push(`- ${topic.Text}`);
        }
      }
      result.content = parts.join('\n\n') || 'No results found.';
      result.title = `Search: ${query}`;
    } catch {
      // Keep raw content
    }
  }

  return result;
}
