export const DOC_LIMIT_REASON_CODES = {
  uploadTooLarge: 'doc_upload_too_large',
  extractTooLarge: 'doc_extract_too_large',
  generationTooLarge: 'doc_generation_too_large',
} as const;

const tokenizeWords = (value: string): string[] =>
  value
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);

export const countWords = (value: string): number => tokenizeWords(value).length;

export const truncateToWordLimit = (value: string, maxWords: number): string => {
  if (maxWords <= 0) {
    return '';
  }

  const words = tokenizeWords(value);
  if (words.length <= maxWords) {
    return value.trim();
  }

  return words.slice(0, maxWords).join(' ').trim();
};

export const applyGenerationWordLimit = (
  value: string,
  maxWords: number,
): { text: string; truncated: boolean; reasonCode?: string } => {
  const normalized = value.trim();
  const currentWordCount = countWords(normalized);
  if (currentWordCount <= maxWords) {
    return { text: normalized, truncated: false };
  }

  const trimmed = truncateToWordLimit(normalized, maxWords);
  return {
    text: `${trimmed}\n\n[Output truncated to stay within the response word limit.]`,
    truncated: true,
    reasonCode: DOC_LIMIT_REASON_CODES.generationTooLarge,
  };
};
