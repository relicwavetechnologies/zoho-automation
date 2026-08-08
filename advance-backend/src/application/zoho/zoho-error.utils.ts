const zohoBooksErrorMessages: Record<string, string> = {
  '5':    'Zoho Books rejected the request because one or more required fields are missing.',
  '14':   'Zoho Books could not find the requested record.',
  '1002': 'Zoho Books authentication failed. Reconnect Zoho Books and try again.',
  '2006': 'Zoho Books rejected the request because a referenced record is missing or invalid.',
  '3008': 'Zoho Books rejected the request because the record is already in that state.',
  '4001': 'Zoho Books rejected the request because the organization is invalid or unavailable.',
  '4823': 'Zoho Books rejected the request because the record cannot be modified in its current status.',
};

const statusMessages: Record<number, string> = {
  400: 'Zoho Books rejected the request. Check the fields and try again.',
  401: 'Zoho Books authentication failed. Reconnect Zoho Books and try again.',
  403: 'Zoho Books denied access for this operation.',
  404: 'Zoho Books could not find the requested record.',
  429: 'Zoho Books rate limit reached. Try again shortly.',
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function extractCodeFromRecord(record: Record<string, unknown>): string | undefined {
  const directCode = record['code'] ?? record['error_code'] ?? record['errorCode'];
  if (typeof directCode === 'string' || typeof directCode === 'number') {
    return String(directCode);
  }

  const response = record['response'];
  if (isRecord(response)) {
    const code = extractCodeFromRecord(response);
    if (code) return code;
  }

  const data = record['data'];
  if (isRecord(data)) {
    const code = extractCodeFromRecord(data);
    if (code) return code;
  }

  const error = record['error'];
  if (isRecord(error)) {
    const code = extractCodeFromRecord(error);
    if (code) return code;
  }

  return undefined;
}

function extractCodeFromMessage(message: string): string | undefined {
  const jsonCode = message.match(/"code"\s*:\s*"?([0-9A-Za-z_-]+)"?/);
  if (jsonCode) return jsonCode[1];

  const labeledCode = message.match(/\b(?:code|error_code)\b\s*[:=]\s*"?([0-9A-Za-z_-]+)"?/i);
  if (labeledCode) return labeledCode[1];

  return undefined;
}

function extractStatusFromMessage(message: string): number | undefined {
  const status = message.match(/\bZoho Books\s+(\d{3})\b/i);
  if (!status) return undefined;

  const parsed = Number(status[1]);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function extractTextMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (!isRecord(error)) return undefined;

  const message = error['message'] ?? error['details'];
  return typeof message === 'string' ? message : undefined;
}

/**
 * Zoho's own explanation, dug out of the response body.
 *
 * The client throws `Zoho Books <status> <statusText>: <body>`, where the body
 * is Zoho's error envelope — `{"code":2,"message":"Invalid value passed for
 * Payment Terms"}`. That sentence is the only thing in the whole failure that
 * says what was actually wrong, and every code we have not enumerated used to
 * fall through to a status line that discarded it. A generic "check the fields"
 * sends a member, and a model, hunting through fields that were never the
 * problem.
 *
 * The client truncates the body at 300 characters, so a long envelope arrives
 * as invalid JSON. The regex fallback exists for exactly that case.
 */
function extractUpstreamMessage(text: string): string | undefined {
  const brace = text.indexOf('{');
  if (brace === -1) return undefined;
  const body = text.slice(brace);

  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed)) {
      const message = parsed['message'];
      if (typeof message === 'string' && message.trim()) return message.trim();
    }
  } catch {
    // Truncated mid-object — fall through.
  }

  const matched = body.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!matched?.[1]) return undefined;

  const unescaped = matched[1].replace(/\\(["\\/])/g, '$1').trim();
  return unescaped || undefined;
}

/**
 * When Zoho has said what was wrong, that is the answer.
 *
 * The table below it is a gloss keyed on error codes, and Zoho reuses those
 * codes across unrelated failures — 1002 is "authentication failed" in one
 * response and "the customer is not accessible" in the next. Preferring the
 * gloss there does not merely lose detail, it asserts something false and sends
 * the member off to reconnect a connection that was working. So the gloss only
 * speaks when Zoho did not.
 *
 * The one thing worth adding to Zoho's own words is what to do next, and only
 * where the status settles it.
 */
export function mapZohoError(error: unknown): string {
  const message  = extractTextMessage(error);
  const upstream = message ? extractUpstreamMessage(message) : undefined;
  const status   = message ? extractStatusFromMessage(message) : undefined;

  if (upstream) {
    const hint = status === 401 ? ' Reconnect Zoho Books and try again.' : '';
    return `Zoho Books says: "${upstream.replace(/[.\s]+$/, '')}".${hint}`;
  }

  const recordCode  = isRecord(error) ? extractCodeFromRecord(error) : undefined;
  const messageCode = message ? extractCodeFromMessage(message) : undefined;
  const mapped =
    (recordCode ? zohoBooksErrorMessages[recordCode] : undefined)
    ?? (messageCode ? zohoBooksErrorMessages[messageCode] : undefined);
  if (mapped) return mapped;

  if (status && statusMessages[status]) return statusMessages[status];

  if (message?.trim()) return message;

  return 'Zoho Books request failed. Try again or reconnect Zoho Books if the issue continues.';
}
