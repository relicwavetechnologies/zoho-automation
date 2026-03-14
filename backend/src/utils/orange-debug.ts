const ORANGE = '\x1b[38;5;208m';
const RESET = '\x1b[0m';

const shouldEmit =
  process.env.NODE_ENV === 'development' ||
  process.env.E2E_DEBUG_COLOR === '1' ||
  process.env.LARK_E2E_DEBUG === '1';

const safeStringify = (value: unknown): string => {
  if (value === undefined) {
    return '';
  }

  try {
    const json = JSON.stringify(value);
    return json.length > 2000 ? `${json.slice(0, 2000)}...<truncated>` : json;
  } catch (error) {
    return JSON.stringify({
      stringifyError: error instanceof Error ? error.message : 'unknown_error',
    });
  }
};

export const orangeDebug = (label: string, meta?: Record<string, unknown>): void => {
  if (!shouldEmit) {
    return;
  }

  const suffix = meta ? ` ${safeStringify(meta)}` : '';
  console.log(`${ORANGE}[LARK-E2E] ${label}${suffix}${RESET}`);
};
