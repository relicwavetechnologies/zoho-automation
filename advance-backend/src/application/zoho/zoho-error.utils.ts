/**
 * Which Zoho product failed.
 *
 * This module is shared by the Books tool and the CRM tool, and their clients
 * throw `Zoho Books <status> …` and `Zoho CRM <status> …` respectively. Naming
 * the wrong one sends a member to reconnect a connection that was working, so
 * the product is read from the failure rather than assumed. "Zoho" alone when
 * the text does not say.
 */
type ZohoProduct = 'Zoho Books' | 'Zoho CRM' | 'Zoho';

const codeMessages: Record<string, (product: ZohoProduct) => string> = {
  '5':    p => `${p} rejected the request because one or more required fields are missing.`,
  '14':   p => `${p} could not find the requested record.`,
  '1002': p => `${p} authentication failed. Reconnect ${p} and try again.`,
  '2006': p => `${p} rejected the request because a referenced record is missing or invalid.`,
  '3008': p => `${p} rejected the request because the record is already in that state.`,
  '4001': p => `${p} rejected the request because the organization is invalid or unavailable.`,
  '4823': p => `${p} rejected the request because the record cannot be modified in its current status.`,
};

const statusMessages: Record<number, (product: ZohoProduct) => string> = {
  400: p => `${p} rejected the request. Check the fields and try again.`,
  401: p => `${p} authentication failed. Reconnect ${p} and try again.`,
  403: p => `${p} denied access for this operation.`,
  404: p => `${p} could not find the requested record.`,
  429: p => `${p} rate limit reached. Try again shortly.`,
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

/**
 * The header both clients throw: `Zoho <product> <status> <statusText>: <body>`.
 * Read together, because attributing the status to the wrong product is the
 * mistake worth preventing.
 */
function parseThrownHeader(message: string): { product: ZohoProduct; status?: number } {
  const matched = message.match(/\bZoho\s+(Books|CRM)\s+(\d{3})\b/i);
  if (!matched) return { product: 'Zoho' };

  const product: ZohoProduct = matched[1]!.toLowerCase() === 'crm' ? 'Zoho CRM' : 'Zoho Books';
  const parsed = Number(matched[2]);
  return Number.isInteger(parsed) ? { product, status: parsed } : { product };
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
  const { product, status } = message ? parseThrownHeader(message) : { product: 'Zoho' as ZohoProduct, status: undefined };

  if (upstream) {
    const hint = status === 401 ? ` Reconnect ${product} and try again.` : '';
    return `${product} says: "${upstream.replace(/[.\s]+$/, '')}".${hint}`;
  }

  const recordCode  = isRecord(error) ? extractCodeFromRecord(error) : undefined;
  const messageCode = message ? extractCodeFromMessage(message) : undefined;
  const mapped =
    (recordCode ? codeMessages[recordCode] : undefined)
    ?? (messageCode ? codeMessages[messageCode] : undefined);
  if (mapped) return mapped(product);

  const byStatus = status ? statusMessages[status] : undefined;
  if (byStatus) return byStatus(product);

  if (message?.trim()) return message;

  return `${product} request failed. Try again or reconnect ${product} if the issue continues.`;
}
