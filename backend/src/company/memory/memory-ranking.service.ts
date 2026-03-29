import type { FlatUserMemoryItem } from './contracts';

export type MemoryRankingMode = 'off' | 'heuristic' | 'rerank' | 'keyword_overlap';

const normalizeTokens = (value: string): string[] =>
  value
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((token) => token.length > 3);

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

const resolveEvidenceTimestamp = (item: FlatUserMemoryItem): number =>
  (item.lastConfirmedAt ?? item.lastSeenAt ?? item.updatedAt).getTime();

const keywordOverlapScore = (
  item: FlatUserMemoryItem,
  queryTokens: Set<string>,
): number => {
  const overlapScore = tokenOverlapScore(
    queryTokens,
    `${item.summary} ${JSON.stringify(item.valueJson ?? {})}`,
  );
  const daysSinceConfirmed = Math.max(
    0,
    (Date.now() - resolveEvidenceTimestamp(item)) / (1000 * 60 * 60 * 24),
  );
  const recencyScore = Math.max(0, 1 - (daysSinceConfirmed / 180));
  const confidenceScore = Math.max(0, Math.min(1, item.confidence ?? 0.5));
  return (overlapScore * 0.5) + (recencyScore * 0.3) + (confidenceScore * 0.2);
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
      const leftRecency = resolveEvidenceTimestamp(left);
      const rightRecency = resolveEvidenceTimestamp(right);
      const leftScore = mode === 'keyword_overlap'
        ? keywordOverlapScore(left, queryTokens)
        : (left.confidence * 100)
          + kindPriority(left.kind)
          + (
            mode === 'off'
              ? 0
              : tokenOverlapScore(queryTokens, `${left.summary} ${JSON.stringify(left.valueJson)}`) * 50
          );
      const rightScore = mode === 'keyword_overlap'
        ? keywordOverlapScore(right, queryTokens)
        : (right.confidence * 100)
          + kindPriority(right.kind)
          + (
            mode === 'off'
              ? 0
              : tokenOverlapScore(queryTokens, `${right.summary} ${JSON.stringify(right.valueJson)}`) * 50
          );
      if (rightScore !== leftScore) {
        return rightScore - leftScore;
      }
      if (mode === 'keyword_overlap') {
        const rightKindPriority = kindPriority(right.kind);
        const leftKindPriority = kindPriority(left.kind);
        if (rightKindPriority !== leftKindPriority) {
          return rightKindPriority - leftKindPriority;
        }
      }
      return rightRecency - leftRecency;
    });

    return ranked.slice(0, Math.max(0, input.limit));
  }
}

export const memoryRankingService = new MemoryRankingService();
