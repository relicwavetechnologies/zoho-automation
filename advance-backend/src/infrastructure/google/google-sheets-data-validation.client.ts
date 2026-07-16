import { google } from 'googleapis';
import { z } from 'zod';
import type { GoogleWorkspaceMcpToolDescription } from '../../application/orchestration/tools/families/google-workspace-mcp.tool';
import { GOOGLE_SHEETS_DATA_VALIDATION_OPERATION } from '../../application/google/google-workspace-mcp-manifest';

export { GOOGLE_SHEETS_DATA_VALIDATION_OPERATION };

const RuleSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('one_of_list'),
    values: z.array(z.string().min(1).max(500)).min(1).max(500),
  }).strict(),
  z.object({
    type: z.literal('one_of_range'),
    source_range: z.string().min(1).max(500),
  }).strict(),
]);

const InputSchema = z.object({
  spreadsheet_id: z.string().min(1),
  action: z.enum(['set', 'remove']),
  ranges: z.array(z.string().min(1).max(500)).min(1).max(100),
  rule: RuleSchema.optional(),
  strict: z.boolean().default(true),
  show_dropdown: z.boolean().default(true),
  input_message: z.string().max(500).optional(),
}).strict().superRefine((input, ctx) => {
  if (input.action === 'set' && !input.rule) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rule'], message: 'rule is required when action is set' });
  }
  if (input.action === 'remove' && input.rule) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rule'], message: 'rule must be omitted when action is remove' });
  }
});

export const GOOGLE_SHEETS_DATA_VALIDATION_DESCRIPTION: GoogleWorkspaceMcpToolDescription = {
  name: GOOGLE_SHEETS_DATA_VALIDATION_OPERATION,
  description:
    'Set or remove Google Sheets dropdown/data-validation rules. Every target range must include an explicit sheet name, for example Sheet1!D2:D100 or \'Project Plan\'!D2:D100. Divo uses the selected OAuth connection and returns the canonical spreadsheet URL.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['spreadsheet_id', 'action', 'ranges'],
    properties: {
      spreadsheet_id: { type: 'string', minLength: 1 },
      action: { type: 'string', enum: ['set', 'remove'] },
      ranges: {
        type: 'array', minItems: 1, maxItems: 100,
        items: { type: 'string', description: 'Explicit A1 range including sheet name, such as Sheet1!D2:D100.' },
      },
      rule: {
        oneOf: [
          {
            type: 'object', additionalProperties: false, required: ['type', 'values'],
            properties: {
              type: { const: 'one_of_list' },
              values: { type: 'array', minItems: 1, maxItems: 500, items: { type: 'string', minLength: 1 } },
            },
          },
          {
            type: 'object', additionalProperties: false, required: ['type', 'source_range'],
            properties: {
              type: { const: 'one_of_range' },
              source_range: { type: 'string', minLength: 1 },
            },
          },
        ],
      },
      strict: { type: 'boolean', default: true, description: 'Reject values not allowed by the rule.' },
      show_dropdown: { type: 'boolean', default: true },
      input_message: { type: 'string', maxLength: 500 },
    },
  },
};

type Input = z.infer<typeof InputSchema>;

export interface SheetsApiPort {
  getSheetProperties(spreadsheetId: string): Promise<readonly { sheetId: number; title: string }[]>;
  batchUpdate(spreadsheetId: string, requests: readonly Record<string, unknown>[]): Promise<unknown>;
}

export class GoogleSheetsDataValidationClient {
  private readonly api: SheetsApiPort;

  constructor(accessToken: string, api?: SheetsApiPort) {
    this.api = api ?? createGoogleSheetsApi(accessToken);
  }

  describeTool(name: string): GoogleWorkspaceMcpToolDescription | null {
    return name === GOOGLE_SHEETS_DATA_VALIDATION_OPERATION
      ? GOOGLE_SHEETS_DATA_VALIDATION_DESCRIPTION
      : null;
  }

  async callTool(name: string, rawInput: Readonly<Record<string, unknown>>): Promise<unknown> {
    if (name !== GOOGLE_SHEETS_DATA_VALIDATION_OPERATION) {
      throw new Error(`Unsupported Divo Google Sheets operation: ${name}`);
    }
    const input = InputSchema.parse(rawInput);
    const sheets = await this.api.getSheetProperties(input.spreadsheet_id);
    const sheetIdsByTitle = new Map(sheets.map((sheet) => [sheet.title, sheet.sheetId]));
    const requests = input.ranges.map((rangeName) => ({
      setDataValidation: {
        range: parseExplicitA1Range(rangeName, sheetIdsByTitle),
        rule: input.action === 'remove' ? null : buildRule(input),
      },
    }));

    const response = await this.api.batchUpdate(input.spreadsheet_id, requests);
    return {
      spreadsheetId: input.spreadsheet_id,
      updatedRanges: [...input.ranges],
      action: input.action,
      url: `https://docs.google.com/spreadsheets/d/${encodeURIComponent(input.spreadsheet_id)}/edit`,
      response,
    };
  }
}

function buildRule(input: Input) {
  if (!input.rule) throw new Error('rule is required when action is set');
  const condition = input.rule.type === 'one_of_list'
    ? {
        type: 'ONE_OF_LIST',
        values: input.rule.values.map((value) => ({ userEnteredValue: value })),
      }
    : {
        type: 'ONE_OF_RANGE',
        values: [{ userEnteredValue: input.rule.source_range }],
      };
  return {
    condition,
    strict: input.strict,
    showCustomUi: input.show_dropdown,
    ...(input.input_message ? { inputMessage: input.input_message } : {}),
  };
}

function createGoogleSheetsApi(accessToken: string): SheetsApiPort {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  const sheets = google.sheets({ version: 'v4', auth });
  return {
    async getSheetProperties(spreadsheetId) {
      const response = await sheets.spreadsheets.get({
        spreadsheetId,
        includeGridData: false,
        fields: 'sheets.properties(sheetId,title)',
      });
      return (response.data.sheets ?? []).flatMap((sheet) => {
        const sheetId = sheet.properties?.sheetId;
        const title = sheet.properties?.title;
        return typeof sheetId === 'number' && typeof title === 'string' ? [{ sheetId, title }] : [];
      });
    },
    async batchUpdate(spreadsheetId, requests) {
      const response = await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: requests as any[] },
      });
      return response.data;
    },
  };
}

export function parseExplicitA1Range(
  rangeName: string,
  sheetIdsByTitle: ReadonlyMap<string, number>,
): Record<string, number> {
  const match = /^(?:'((?:[^']|'')+)'|([^!]+))!(.+)$/.exec(rangeName.trim());
  if (!match) throw new Error(`Range "${rangeName}" must include an explicit sheet name, for example Sheet1!D2:D100`);
  const sheetTitle = (match[1] ? match[1].replace(/''/g, "'") : match[2]!).trim();
  const sheetId = sheetIdsByTitle.get(sheetTitle);
  if (sheetId === undefined) throw new Error(`Unknown sheet "${sheetTitle}" in range "${rangeName}"`);

  const range = match[3]!.trim().toUpperCase();
  const hasColon = range.includes(':');
  const [startText, endText, ...extra] = range.split(':');
  if (extra.length > 0 || !startText || (hasColon && !endText)) throw new Error(`Invalid A1 range "${rangeName}"`);
  const start = parseA1Point(startText);
  const end = endText ? parseA1Point(endText) : start;
  if (!start.column && !start.row) throw new Error(`Invalid A1 range "${rangeName}"`);

  const gridRange: Record<string, number> = { sheetId };
  if (start.column !== undefined) gridRange.startColumnIndex = start.column;
  if (start.row !== undefined) gridRange.startRowIndex = start.row;
  if (end.column !== undefined) gridRange.endColumnIndex = end.column + 1;
  if (end.row !== undefined) gridRange.endRowIndex = end.row + 1;

  if (gridRange.endColumnIndex !== undefined && gridRange.startColumnIndex !== undefined
      && gridRange.endColumnIndex <= gridRange.startColumnIndex) {
    throw new Error(`Range "${rangeName}" ends before it starts`);
  }
  if (gridRange.endRowIndex !== undefined && gridRange.startRowIndex !== undefined
      && gridRange.endRowIndex <= gridRange.startRowIndex) {
    throw new Error(`Range "${rangeName}" ends before it starts`);
  }
  return gridRange;
}

function parseA1Point(value: string): { column?: number; row?: number } {
  const match = /^([A-Z]+)?([1-9][0-9]*)?$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) throw new Error(`Invalid A1 coordinate "${value}"`);
  return {
    ...(match[1] ? { column: columnIndex(match[1]) } : {}),
    ...(match[2] ? { row: Number(match[2]) - 1 } : {}),
  };
}

function columnIndex(letters: string): number {
  let value = 0;
  for (const character of letters) value = value * 26 + character.charCodeAt(0) - 64;
  return value - 1;
}
