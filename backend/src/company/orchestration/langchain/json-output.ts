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

const findLastBalancedJsonObject = (raw: string): string | null => {
  const end = raw.lastIndexOf('}');
  if (end === -1) return null;

  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = end; index >= 0; index -= 1) {
    const char = raw[index];

    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === '\\') {
        escaping = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '}') {
      depth += 1;
      continue;
    }

    if (char === '{') {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(index, end + 1).trim();
      }
    }
  }

  return null;
};

export const extractLastJsonObjectString = (raw: string | null): string | null => {
  if (!raw) return null;

  const fenced = extractMarkdownJson(raw);
  if (fenced) {
    const directFenced = tryParseJson(fenced);
    if (directFenced && typeof directFenced === 'object' && !Array.isArray(directFenced)) {
      return fenced;
    }
    const nestedFenced = findLastBalancedJsonObject(fenced);
    if (nestedFenced) {
      const parsed = tryParseJson(nestedFenced);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return nestedFenced;
      }
    }
  }

  return findLastBalancedJsonObject(raw);
};

export const extractJsonObject = (raw: string | null): Record<string, unknown> | null => {
  if (!raw) {
    return null;
  }

  const direct = tryParseJson(raw);
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
    return direct as Record<string, unknown>;
  }

  const trailingJson = extractLastJsonObjectString(raw);
  if (!trailingJson) {
    return null;
  }

  const parsed = tryParseJson(trailingJson);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }

  return null;
};
