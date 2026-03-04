const tryParseJson = (value: string): unknown | null => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const extractMarkdownJson = (value: string): string | null => {
  const match = value.match(/```json\s*([\s\S]*?)```/i);
  if (!match) {
    return null;
  }
  return match[1]?.trim() ?? null;
};

export const extractJsonObject = (raw: string | null): Record<string, unknown> | null => {
  if (!raw) {
    return null;
  }

  const direct = tryParseJson(raw);
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
    return direct as Record<string, unknown>;
  }

  const fenced = extractMarkdownJson(raw);
  if (!fenced) {
    return null;
  }

  const parsed = tryParseJson(fenced);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }

  return null;
};
