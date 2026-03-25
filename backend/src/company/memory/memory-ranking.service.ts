import type { FlatUserMemoryItem } from './contracts';

export type MemoryRankingMode = 'off' | 'heuristic' | 'rerank';

const normalizeTokens = (value: string): string[] =>
  value
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((token) => token.length >= 3);

const tokenOverlapScore = (queryTokens: Set<string>, text: string): number => {
  if (queryTokens.size === 0) {
    return 0;
  }
  const tokens = normalizeTokens(text);
  if (tokens.length === 0) {
    return 0;
  }
  let overlap = 0;
  for (const token of tokens) {
    if (queryTokens.has(token)) {
      overlap += 1;
    }
  }
  return overlap / Math.max(queryTokens.size, 1);
};

const kindPriority = (kind: FlatUserMemoryItem['kind']): number => {
  switch (kind) {
    case 'constraint':
      return 18;
    case 'ongoing_task':
      return 16;
    case 'project':
      return 14;
    case 'decision':
      return 12;
    case 'identity':
      return 10;
    case 'response_style':
      return 8;
    case 'preference':
      return 6;
    default:
      return 0;
  }
};

class MemoryRankingService {
  rankRelevant(input: {
    mode?: MemoryRankingMode;
    queryText: string;
    items: FlatUserMemoryItem[];
    limit: number;
  }): FlatUserMemoryItem[] {
    const mode = input.mode ?? 'off';
    const queryTokens = new Set(normalizeTokens(input.queryText));

    const ranked = [...input.items].sort((left, right) => {
      const leftRecency = left.updatedAt.getTime();
      const rightRecency = right.updatedAt.getTime();
      const leftOverlap = mode === 'off' ? 0 : tokenOverlapScore(queryTokens, `${left.summary} ${JSON.stringify(left.valueJson)}`);
      const rightOverlap = mode === 'off' ? 0 : tokenOverlapScore(queryTokens, `${right.summary} ${JSON.stringify(right.valueJson)}`);
      const leftScore = (left.confidence * 100) + kindPriority(left.kind) + (leftOverlap * 50);
      const rightScore = (right.confidence * 100) + kindPriority(right.kind) + (rightOverlap * 50);
      if (rightScore !== leftScore) {
        return rightScore - leftScore;
      }
      return rightRecency - leftRecency;
    });

    return ranked.slice(0, Math.max(0, input.limit));
  }
}

export const memoryRankingService = new MemoryRankingService();
