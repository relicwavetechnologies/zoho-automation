/**
 * LLM-backed filename resolver: given a fuzzy user query and a list of candidate
 * filenames, returns the best match and a confidence score.
 *
 * Uses Groq llama-3.1-8b-instant (fast, ~200ms) so it can sit in the hot path.
 * Falls back gracefully (returns null) when GROQ_API_KEY is absent or the call fails.
 */

import Groq from 'groq-sdk';

const SYSTEM_PROMPT = `You are a filename matcher. The user described a file using an approximate or informal name.
Given a list of actual filenames, return the single best match.

Rules:
- Match on meaning, not exact words. "mr market" → "Mr. Market Functional Doc.pdf"
- Abbreviations resolve to the most likely full name.
- If the user says "html file" or "the demo" → pick the only .html file.
- "conscious_product" could mean a product demo, product doc, or anything product-related.
- When only one candidate exists, return it with high confidence.
- If no candidate is a reasonable match, return null.

Respond ONLY with valid JSON: { "match": "<exact filename or null>", "confidence": 0.0-1.0 }`;

export interface FilenameResolverResult {
  match: string | null;
  confidence: number;
}

export async function resolveFilenameWithGroq(
  query:      string,
  candidates: string[],
  groqApiKey: string,
  timeoutMs = 5_000,
): Promise<FilenameResolverResult> {
  if (!groqApiKey || candidates.length === 0) return { match: null, confidence: 0 };

  const groq = new Groq({ apiKey: groqApiKey });

  const userMessage = `User's approximate description: "${query}"\n\nCandidates:\n${candidates.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\nBest match?`;

  try {
    const completion = await Promise.race([
      groq.chat.completions.create({
        model:       'llama-3.1-8b-instant',
        messages:    [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: userMessage },
        ],
        temperature: 0,
        max_tokens:  80,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), timeoutMs),
      ),
    ]);

    const raw = completion.choices[0]?.message?.content?.trim() ?? '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { match: null, confidence: 0 };

    const parsed = JSON.parse(jsonMatch[0]) as { match?: string | null; confidence?: number };
    return {
      match:      typeof parsed.match === 'string' ? parsed.match : null,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
    };
  } catch {
    return { match: null, confidence: 0 };
  }
}
