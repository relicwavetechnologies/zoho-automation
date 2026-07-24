type JsonRecord = Record<string, unknown>;

/**
 * Adds stable machine-readable fields to the few Google MCP operations whose
 * pinned implementation currently returns human-oriented prose. The original
 * payload is preserved for compatibility and audit/debug visibility.
 */
export function normalizeGoogleWorkspaceResult(
  nativeTool: string,
  result: unknown,
  input: Readonly<Record<string, unknown>> = {},
): unknown {
  if (!isRecord(result)) return result;
  const text = readText(result);
  if (!text) return result;

  if (nativeTool === 'create_spreadsheet') {
    const spreadsheetId = text.match(/\bID:\s*([A-Za-z0-9_-]+)/)?.[1];
    const spreadsheetUrl = text.match(/\bURL:\s*(https:\/\/docs\.google\.com\/spreadsheets\/d\/[^\s|]+)/)?.[1];
    if (!spreadsheetId && !spreadsheetUrl) return result;
    return {
      ...result,
      ...(spreadsheetId ? { spreadsheetId } : {}),
      ...(spreadsheetUrl ? { spreadsheetUrl } : {}),
    };
  }

  if (nativeTool === 'search_gmail_messages') {
    const messages = parseSearchMessages(text);
    const providerReturnedMessages = parseGmailReportedCount(text) ?? messages.length;
    const nextPageToken = parseGmailNextPageToken(text);
    const requestedPageSize = readPositiveInteger(input['page_size']);
    const unstructuredMessages = Math.max(0, providerReturnedMessages - messages.length);
    return {
      ...result,
      messages,
      messageIds: messages.map((message) => message.messageId),
      pagination: {
        providerReturnedMessages,
        structuredMessages: messages.length,
        unstructuredMessages,
        ...(requestedPageSize ? { requestedPageSize } : {}),
        hasNextPage: Boolean(nextPageToken),
        ...(nextPageToken ? { nextPageToken, nextPageInputField: 'page_token' } : {}),
      },
      ...(unstructuredMessages > 0 ? {
        advisories: mergeAdvisories(result['advisories'], [{
          code: 'gmail_search_records_unstructured',
          level: 'required',
          instruction: `${unstructuredMessages} provider-returned Gmail records could not be normalized. Record them as skipped with a reason and report partial/failed instead of claiming a zero-skip success.`,
        }]),
      } : {}),
    };
  }

  if (nativeTool === 'get_gmail_messages_content_batch') {
    const messages = parseMessageMetadata(text);
    const requestedMessageIds = readStringArray(input['message_ids']);
    const returnedMessageIds = new Set(messages.map(message => String(message['messageId'])));
    const missingMessageIds = requestedMessageIds.filter(messageId => !returnedMessageIds.has(messageId));
    const batch = {
      requestedMessages: requestedMessageIds.length,
      structuredMessages: messages.length,
      missingMessages: missingMessageIds.length,
      missingMessageIds,
      complete: requestedMessageIds.length > 0
        ? missingMessageIds.length === 0
        : messages.length > 0,
    };
    return {
      ...result,
      messages,
      batch,
      ...(missingMessageIds.length > 0 ? {
        advisories: mergeAdvisories(result['advisories'], [{
          code: 'gmail_batch_records_missing',
          level: 'required',
          instruction: `${missingMessageIds.length} requested Gmail records are absent from the structured batch result. Record each ID as skipped/error and report partial/failed.`,
        }]),
      } : {}),
    };
  }

  if (nativeTool === 'read_sheet_values') {
    return normalizeSheetRead(result, input, text);
  }

  return result;
}

function normalizeSheetRead(
  result: JsonRecord,
  input: Readonly<Record<string, unknown>>,
  text: string,
): JsonRecord {
  const values = parseSheetRows(text);
  const reportedRowCount = parseReportedSheetRowCount(text) ?? values.length;
  const returnedRowCount = values.length;
  const omittedRowCount = Math.max(0, reportedRowCount - returnedRowCount);
  const range = readInputString(input['range_name']) ?? parseSheetRange(text);
  const spreadsheetId = readInputString(input['spreadsheet_id']);
  const hasFormulaCells = /range contains formula cells/i.test(text);
  const isEmpty = reportedRowCount === 0 && !hasFormulaCells;
  const complete = omittedRowCount === 0;
  const columnCount = values.reduce((maximum, row) => Math.max(maximum, row.length), 0);

  const advisories: JsonRecord[] = [
    {
      code: 'verify_destination_write',
      level: 'required',
      instruction: 'Compare the returned header and final populated row with the intended write before reporting success.',
    },
  ];
  if (!complete) {
    advisories.push({
      code: 'sheet_read_model_view_incomplete',
      level: 'required',
      instruction: `This response exposes ${returnedRowCount} of ${reportedRowCount} rows. Read a narrower exact range before claiming full-range verification.`,
    });
  }

  return {
    ...result,
    ...(spreadsheetId ? { spreadsheetId } : {}),
    ...(range ? { range } : {}),
    values,
    rowCount: reportedRowCount,
    returnedRowCount,
    omittedRowCount,
    columnCount,
    isEmpty,
    complete,
    hasFormulaCells,
    advisories: mergeAdvisories(result['advisories'], advisories),
  };
}

function readText(result: JsonRecord): string | undefined {
  for (const key of ['result', 'text', 'content', 'output'] as const) {
    if (typeof result[key] === 'string' && result[key].trim()) return result[key];
  }
  return undefined;
}

function parseSearchMessages(text: string): JsonRecord[] {
  const matches = [...text.matchAll(/^\s*\d+\.\s+Message ID:\s*([^\s]+)\s*$/gm)];
  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? text.length;
    const block = text.slice(start, end);
    return compactRecord({
      messageId: match[1],
      webLink: readLine(block, 'Web Link'),
      threadId: readLine(block, 'Thread ID'),
      threadLink: readLine(block, 'Thread Link'),
    });
  });
}

function parseGmailNextPageToken(text: string): string | undefined {
  return text.match(/PAGINATION:[^\n]*\bpage_token='([^']+)'/i)?.[1];
}

function parseGmailReportedCount(text: string): number | undefined {
  const match = text.match(/^Found\s+(\d+)\s+messages?\b/im);
  if (match) return Number(match[1]);
  if (/^No messages found\b/im.test(text)) return 0;
  return undefined;
}

function parseMessageMetadata(text: string): JsonRecord[] {
  const matches = [...text.matchAll(/^Message ID:\s*([^\s]+)\s*$/gm)];
  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? text.length;
    const block = text.slice(start, end);
    return compactRecord({
      messageId: match[1],
      subject: readLine(block, 'Subject'),
      from: readLine(block, 'From'),
      date: readLine(block, 'Date'),
      to: readLine(block, 'To'),
      webLink: readLine(block, 'Web Link'),
    });
  });
}

function parseSheetRows(text: string): unknown[][] {
  const rows: unknown[][] = [];
  for (const match of text.matchAll(/^Row\s+\d+:\s*(\[.*\])\s*$/gm)) {
    const row = parsePythonRow(match[1] ?? '');
    if (row) rows.push(row);
  }
  return rows;
}

/** Parse the one-dimensional Python list representation emitted by Workspace MCP. */
function parsePythonRow(source: string): unknown[] | undefined {
  const value = source.trim();
  if (!value.startsWith('[') || !value.endsWith(']')) return undefined;
  const items: unknown[] = [];
  let token = '';
  let quote: "'" | '"' | undefined;
  let quotedToken = false;
  let escaped = false;

  const pushToken = (): boolean => {
    const parsed = quotedToken
      ? { ok: true as const, value: token }
      : parsePythonScalar(token.trim());
    if (!parsed.ok) return false;
    items.push(parsed.value);
    token = '';
    quotedToken = false;
    return true;
  };

  for (let index = 1; index < value.length - 1; index++) {
    const character = value[index]!;
    if (quote) {
      if (escaped) {
        token += decodePythonEscape(character);
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      } else {
        token += character;
      }
      continue;
    }

    if (character === "'" || character === '"') {
      if (token.trim()) return undefined;
      token = '';
      quote = character;
      quotedToken = true;
      continue;
    }
    if (character === ',') {
      if (!pushToken()) return undefined;
      continue;
    }
    token += character;
  }

  if (quote || escaped) return undefined;
  if (!token.trim() && !quotedToken) return items.length === 0 ? [] : undefined;
  return pushToken() ? items : undefined;
}

function parsePythonScalar(token: string): { ok: true; value: unknown } | { ok: false } {
  if (token === 'None') return { ok: true, value: null };
  if (token === 'True') return { ok: true, value: true };
  if (token === 'False') return { ok: true, value: false };
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(token)) {
    return { ok: true, value: Number(token) };
  }
  return { ok: false };
}

function decodePythonEscape(character: string): string {
  if (character === 'n') return '\n';
  if (character === 'r') return '\r';
  if (character === 't') return '\t';
  if (character === '\\' || character === "'" || character === '"') return character;
  return `\\${character}`;
}

function parseReportedSheetRowCount(text: string): number | undefined {
  const match = text.match(/Successfully read\s+(\d+)\s+rows?\b/i);
  if (match) return Number(match[1]);
  if (/No (?:displayed values|data) found\b/i.test(text)) return 0;
  return undefined;
}

function parseSheetRange(text: string): string | undefined {
  return text.match(/\brange\s+'([^']+)'/i)?.[1];
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    .map(item => item.trim());
}

function readInputString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function mergeAdvisories(existing: unknown, additions: readonly JsonRecord[]): JsonRecord[] {
  const current = Array.isArray(existing) ? existing.filter(isRecord) : [];
  const byCode = new Map<string, JsonRecord>();
  for (const advisory of [...current, ...additions]) {
    const code = typeof advisory['code'] === 'string' ? advisory['code'] : JSON.stringify(advisory);
    byCode.set(code, advisory);
  }
  return [...byCode.values()];
}

function readLine(block: string, field: string): string | undefined {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return block.match(new RegExp(`^\\s*${escaped}:\\s*(.+)$`, 'm'))?.[1]?.trim();
}

function compactRecord(record: JsonRecord): JsonRecord {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
