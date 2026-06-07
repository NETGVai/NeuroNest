/**
 * Cross-Model Second Opinion — gstack-inspired multi-model comparison.
 *
 * Sends the same query to two different configured LLM providers and
 * returns a comparison showing overlapping vs unique findings.
 * Uses existing multi-provider infrastructure.
 */

export interface SecondOpinionRequest {
  query: string;
  context?: string;
  primaryProvider?: string;
  secondaryProvider?: string;
}

export interface SecondOpinionResult {
  primary: { provider: string; model: string; response: string; latencyMs: number };
  secondary: { provider: string; model: string; response: string; latencyMs: number };
  comparison: {
    agreementScore: number; // 0-100
    overlapping: string[];
    primaryOnly: string[];
    secondaryOnly: string[];
    summary: string;
  };
  timestamp: number;
}

/**
 * Extract key points from a response for comparison.
 */
function extractKeyPoints(response: string): string[] {
  const points: string[] = [];
  const lines = response.split('\n').filter(l => l.trim().length > 10);

  for (const line of lines) {
    const trimmed = line.trim();
    // Bullet points, numbered items, or sentences with key info
    if (/^[-*•]\s/.test(trimmed) || /^\d+[.)]\s/.test(trimmed)) {
      points.push(trimmed.replace(/^[-*•\d.)]+\s*/, '').trim());
    } else if (trimmed.length > 20 && trimmed.length < 200 && /[.!?]$/.test(trimmed)) {
      points.push(trimmed);
    }
  }

  return points.slice(0, 20); // Cap at 20 points
}

/**
 * Compare two sets of key points to find overlaps and differences.
 */
function comparePoints(primaryPoints: string[], secondaryPoints: string[]): {
  overlapping: string[];
  primaryOnly: string[];
  secondaryOnly: string[];
  agreementScore: number;
} {
  const overlapping: string[] = [];
  const primaryOnly: string[] = [];
  const secondaryOnly: string[] = [...secondaryPoints];

  for (const pp of primaryPoints) {
    const ppLower = pp.toLowerCase();
    const ppWords = new Set(ppLower.split(/\s+/).filter(w => w.length > 3));

    let matched = false;
    for (let i = 0; i < secondaryOnly.length; i++) {
      const spLower = secondaryOnly[i].toLowerCase();
      const spWords = new Set(spLower.split(/\s+/).filter(w => w.length > 3));

      // Check word overlap
      let overlap = 0;
      for (const w of ppWords) { if (spWords.has(w)) overlap++; }
      const similarity = ppWords.size > 0 ? overlap / Math.max(ppWords.size, spWords.size) : 0;

      if (similarity > 0.4) {
        overlapping.push(pp);
        secondaryOnly.splice(i, 1);
        matched = true;
        break;
      }
    }

    if (!matched) {
      primaryOnly.push(pp);
    }
  }

  const totalPoints = primaryPoints.length + secondaryPoints.length;
  const agreementScore = totalPoints > 0
    ? Math.round((overlapping.length * 2) / totalPoints * 100)
    : 0;

  return { overlapping, primaryOnly, secondaryOnly, agreementScore };
}

/**
 * Get a second opinion by querying two different LLM providers.
 */
export async function getSecondOpinion(
  request: SecondOpinionRequest,
  providers: Array<{ name: string; type: string; apiKey?: string; baseUrl?: string }>,
  createLLMClient: (provider: any) => any,
): Promise<SecondOpinionResult | null> {
  if (providers.length < 2) return null;

  const primary = providers[0];
  const secondary = providers[1];

  const systemPrompt = 'You are a code reviewer. Analyze the following and provide your findings as bullet points. Be specific and actionable.';
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: request.context ? `Context:\n${request.context}\n\nQuery: ${request.query}` : request.query },
  ];

  // Query primary
  const primaryStart = Date.now();
  let primaryResponse = '';
  try {
    const client = createLLMClient(primary);
    const result = await client.chat(messages, { temperature: 0.3, maxTokens: 1024 });
    primaryResponse = result.content || '';
  } catch (e: any) {
    primaryResponse = `Error: ${e.message}`;
  }
  const primaryLatency = Date.now() - primaryStart;

  // Query secondary
  const secondaryStart = Date.now();
  let secondaryResponse = '';
  try {
    const client = createLLMClient(secondary);
    const result = await client.chat(messages, { temperature: 0.3, maxTokens: 1024 });
    secondaryResponse = result.content || '';
  } catch (e: any) {
    secondaryResponse = `Error: ${e.message}`;
  }
  const secondaryLatency = Date.now() - secondaryStart;

  // Compare responses
  const primaryPoints = extractKeyPoints(primaryResponse);
  const secondaryPoints = extractKeyPoints(secondaryResponse);
  const comparison = comparePoints(primaryPoints, secondaryPoints);

  let summary = '';
  if (comparison.agreementScore > 70) {
    summary = `High agreement (${comparison.agreementScore}%) — both models largely agree.`;
  } else if (comparison.agreementScore > 40) {
    summary = `Moderate agreement (${comparison.agreementScore}%) — some differences worth reviewing.`;
  } else {
    summary = `Low agreement (${comparison.agreementScore}%) — significant differences between models.`;
  }

  return {
    primary: { provider: primary.name, model: primary.type, response: primaryResponse, latencyMs: primaryLatency },
    secondary: { provider: secondary.name, model: secondary.type, response: secondaryResponse, latencyMs: secondaryLatency },
    comparison: { ...comparison, summary },
    timestamp: Date.now(),
  };
}
