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

export function mapZohoError(error: unknown): string {
  const code = isRecord(error) ? extractCodeFromRecord(error) : undefined;
  if (code && zohoBooksErrorMessages[code]) return zohoBooksErrorMessages[code];

  const message = extractTextMessage(error);
  const messageCode = message ? extractCodeFromMessage(message) : undefined;
  if (messageCode && zohoBooksErrorMessages[messageCode]) return zohoBooksErrorMessages[messageCode];

  const status = message ? extractStatusFromMessage(message) : undefined;
  if (status && statusMessages[status]) return statusMessages[status];

  if (message?.trim()) return message;

  return 'Zoho Books request failed. Try again or reconnect Zoho Books if the issue continues.';
}
