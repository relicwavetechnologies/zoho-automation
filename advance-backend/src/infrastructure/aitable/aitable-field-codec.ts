/**
 * Translating between AITable cell values and the values a model supplies.
 *
 * This is the file that must not guess. AITable's own published MCP server got
 * this wrong in a way that loses data silently: its converter dropped any field
 * whose conversion returned null — unsupported types, empty dates — and then
 * reported the write as a success. A caller asking to set six fields could have
 * four written and be told all six landed.
 *
 * So the rule here is the opposite: anything this codec cannot encode with
 * confidence raises a named error, and the write never leaves the process.
 * Refusing loudly is recoverable; a half-written record is not.
 *
 * Types and per-type properties are ported from the MIT-licensed `apitable` SDK
 * (github.com/apitable/sdk, es/enums.d.ts and es/interface/field.property.d.ts).
 */

/** Every field type the Fusion API declares. */
export const AITABLE_FIELD_TYPES = [
  'Text', 'SingleText', 'Number', 'Currency', 'Percent', 'SingleSelect',
  'MultiSelect', 'DateTime', 'Attachment', 'MagicLink', 'URL', 'Email',
  'Phone', 'Checkbox', 'Rating', 'Member',
  'MagicLookUp', 'Formula', 'AutoNumber', 'CreatedTime', 'LastModifiedTime',
  'CreatedBy', 'LastModifiedBy',
] as const;

export type AitableFieldType = typeof AITABLE_FIELD_TYPES[number];

/**
 * Fields AITable computes. They can be read and never written — the API either
 * ignores the value or rejects the request, and both are worse than saying so
 * before the call.
 */
export const AITABLE_COMPUTED_FIELD_TYPES: ReadonlySet<string> = new Set([
  'MagicLookUp', 'Formula', 'AutoNumber',
  'CreatedTime', 'LastModifiedTime', 'CreatedBy', 'LastModifiedBy',
]);

export interface AitableSelectOption {
  readonly id: string;
  readonly name: string;
}

export interface AitableFieldProperty {
  readonly options?: readonly AitableSelectOption[];
  readonly max?: number;
  readonly [key: string]: unknown;
}

export interface AitableField {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly isPrimary?: boolean;
  readonly desc?: string;
  readonly property?: AitableFieldProperty;
  readonly permissionLevel?: 'edit' | 'read';
}

/** Raised instead of silently dropping or mangling a value. */
export class AitableFieldEncodingError extends Error {
  constructor(
    readonly fieldName: string,
    readonly reason:
      | 'computed_field'
      | 'unknown_field'
      | 'read_only_field'
      | 'unsupported_type'
      | 'invalid_value',
    message: string,
  ) {
    super(message);
    this.name = 'AitableFieldEncodingError';
  }
}

export interface AitableAttachmentValue {
  readonly token: string;
  readonly name: string;
  readonly size: number;
  readonly mimeType: string;
  readonly url: string;
  readonly width?: number;
  readonly height?: number;
}

/**
 * Encode one model-supplied value for one field.
 *
 * Throws rather than returning null or undefined. Callers must not catch and
 * continue — that reintroduces exactly the silent-partial-write bug this
 * exists to prevent.
 */
export function encodeCellValue(field: AitableField, value: unknown): unknown {
  if (AITABLE_COMPUTED_FIELD_TYPES.has(field.type)) {
    throw new AitableFieldEncodingError(
      field.name,
      'computed_field',
      `"${field.name}" is a ${field.type} field. AITable calculates it, so it cannot be written.`,
    );
  }
  if (field.permissionLevel === 'read') {
    throw new AitableFieldEncodingError(
      field.name,
      'read_only_field',
      `This connection has read-only access to "${field.name}".`,
    );
  }

  // Clearing a cell is a legitimate write, and distinct from "I had nothing to
  // encode": null is passed through, undefined never reaches here.
  if (value === null) return null;

  switch (field.type) {
    case 'Text':
    case 'SingleText':
    case 'URL':
    case 'Email':
    case 'Phone':
      return encodeText(field, value);

    case 'SingleSelect':
      return encodeSingleSelect(field, value);

    case 'MultiSelect':
      return encodeMultiSelect(field, value);

    case 'Number':
    case 'Currency':
    case 'Percent':
      return encodeNumber(field, value);

    case 'Rating':
      return encodeRating(field, value);

    case 'Checkbox':
      return encodeCheckbox(field, value);

    case 'DateTime':
      return encodeDateTime(field, value);

    case 'Attachment':
      return encodeAttachment(field, value);

    case 'MagicLink':
      return encodeRecordLinks(field, value);

    case 'Member':
      return encodeMembers(field, value);

    default:
      throw new AitableFieldEncodingError(
        field.name,
        'unsupported_type',
        `Divo does not know how to write a "${field.type}" field yet ("${field.name}").`,
      );
  }
}

/**
 * Encode a whole record's worth of values.
 *
 * Every supplied key must match a field and encode cleanly, or nothing is
 * returned at all. A name that matches no field is an error rather than a
 * no-op: silently ignoring it is how a model comes to believe it set a value
 * it never set.
 */
export function encodeRecordFields(
  fields: readonly AitableField[],
  values: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const byName = new Map(fields.map(field => [field.name, field]));
  const encoded: Record<string, unknown> = {};

  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) continue;
    const field = byName.get(name);
    if (!field) {
      throw new AitableFieldEncodingError(
        name,
        'unknown_field',
        `"${name}" is not a field in this datasheet. Available fields: ${[...byName.keys()].join(', ')}.`,
      );
    }
    encoded[name] = encodeCellValue(field, value);
  }
  return encoded;
}

// ── Per-type encoders ──────────────────────────────────────────────────────

function encodeText(field: AitableField, value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw invalid(field, value, 'a string');
}

function encodeNumber(field: AitableField, value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    // String(Number) round-trips only for genuine numbers. "12abc" parses to
    // NaN and "" to 0, both of which would otherwise be written as data.
    if (Number.isFinite(parsed)) return parsed;
  }
  throw invalid(field, value, 'a number');
}

function encodeRating(field: AitableField, value: unknown): number {
  const rating = encodeNumber(field, value);
  if (!Number.isInteger(rating) || rating < 0) throw invalid(field, value, 'a whole rating of 0 or more');
  const max = typeof field.property?.max === 'number' ? field.property.max : undefined;
  // Clamping would record a score nobody asked for. AITable's own MCP server
  // told the model to "reduce to max" and then wrote whatever it was given.
  if (max !== undefined && rating > max) {
    throw new AitableFieldEncodingError(
      field.name,
      'invalid_value',
      `"${field.name}" is rated out of ${max}, so ${rating} cannot be stored.`,
    );
  }
  return rating;
}

function encodeCheckbox(field: AitableField, value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  // Not Boolean(value): "false" and 0 would both flip to a value the caller
  // plainly did not mean.
  throw invalid(field, value, 'true or false');
}

function encodeDateTime(field: AitableField, value: unknown): string | number {
  // A timestamp is what Fusion returns and accepts; an ISO string is what a
  // model naturally produces. Both are allowed, neither is guessed at.
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  throw invalid(field, value, 'an ISO 8601 date-time such as 2026-07-27T09:00:00Z');
}

function encodeSingleSelect(field: AitableField, value: unknown): string {
  const name = typeof value === 'string' ? value : undefined;
  if (name === undefined) throw invalid(field, value, 'one of the field options');
  const options = field.property?.options ?? [];
  // An option list that is empty means the schema did not carry one, not that
  // the field has no options, so the value passes through unchecked.
  if (options.length === 0) return name;
  const match = options.find(option => option.name === name);
  if (!match) {
    throw new AitableFieldEncodingError(
      field.name,
      'invalid_value',
      `"${name}" is not an option for "${field.name}". Options: ${options.map(o => o.name).join(', ')}.`,
    );
  }
  return match.name;
}

/**
 * MultiSelect is the mapping this codec is least sure of, and it is flagged
 * here rather than in a commit message: AITable's MCP server converts option
 * names to option *ids* before writing, while the Fusion docs describe writing
 * names when `fieldKey=name`. Names are sent, because that is what the
 * documented request format says and what every other select-like field takes.
 *
 * plans/aitable-integration.md Wave 4 verifies this against a real datasheet
 * before writes are enabled. If ids turn out to be required, this function is
 * the only place that changes.
 */
function encodeMultiSelect(field: AitableField, value: unknown): string[] {
  const requested = Array.isArray(value) ? value : [value];
  const options = field.property?.options ?? [];

  return requested.map(entry => {
    if (typeof entry !== 'string') throw invalid(field, entry, 'option names');
    if (options.length === 0) return entry;
    const match = options.find(option => option.name === entry);
    if (!match) {
      throw new AitableFieldEncodingError(
        field.name,
        'invalid_value',
        `"${entry}" is not an option for "${field.name}". Options: ${options.map(o => o.name).join(', ')}.`,
      );
    }
    return match.name;
  });
}

/**
 * Attachments must already exist in AITable. The upload endpoint returns these
 * objects; a model cannot invent one, and a fabricated token would attach
 * nothing while appearing to succeed.
 */
function encodeAttachment(field: AitableField, value: unknown): AitableAttachmentValue[] {
  const entries = Array.isArray(value) ? value : [value];
  return entries.map(entry => {
    const attachment = entry as Partial<AitableAttachmentValue> | null;
    if (!attachment || typeof attachment !== 'object' || typeof attachment.token !== 'string') {
      throw new AitableFieldEncodingError(
        field.name,
        'invalid_value',
        `"${field.name}" takes attachments returned by the AITable upload step, not file paths or URLs.`,
      );
    }
    return attachment as AitableAttachmentValue;
  });
}

/** A link field holds record ids from the linked datasheet. */
function encodeRecordLinks(field: AitableField, value: unknown): string[] {
  const entries = Array.isArray(value) ? value : [value];
  return entries.map(entry => {
    if (typeof entry !== 'string' || !entry.trim()) {
      throw invalid(field, entry, 'record ids from the linked datasheet');
    }
    return entry;
  });
}

/**
 * Member fields hold AITable unit ids. Names are deliberately not resolved
 * here: it would take a contacts lookup this codec has no access to, and
 * guessing which "Alex" was meant is precisely the kind of silent wrong answer
 * this file exists to avoid.
 */
function encodeMembers(field: AitableField, value: unknown): string[] {
  const entries = Array.isArray(value) ? value : [value];
  return entries.map(entry => {
    if (typeof entry !== 'string' || !entry.trim()) {
      throw invalid(field, entry, 'AITable member unit ids');
    }
    return entry;
  });
}

function invalid(field: AitableField, value: unknown, expected: string): AitableFieldEncodingError {
  return new AitableFieldEncodingError(
    field.name,
    'invalid_value',
    `"${field.name}" expects ${expected}, but received ${describe(value)}.`,
  );
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `an array of ${value.length}`;
  return typeof value;
}

// ── Read side ──────────────────────────────────────────────────────────────

/**
 * A JSON Schema describing what this datasheet accepts, for the model to read
 * before composing a write.
 *
 * Unlike AITable's MCP server, a field whose type has no mapping is *described*
 * as unwritable rather than omitted. Omitting it left the model unable to see
 * that a column existed at all, while every remaining field was marked
 * required — so a partial picture was presented as a complete one.
 */
export function describeFieldsForModel(fields: readonly AitableField[]): {
  writable: Record<string, unknown>;
  readOnly: { name: string; type: string; reason: string }[];
} {
  const writable: Record<string, unknown> = {};
  const readOnly: { name: string; type: string; reason: string }[] = [];

  for (const field of fields) {
    if (AITABLE_COMPUTED_FIELD_TYPES.has(field.type)) {
      readOnly.push({ name: field.name, type: field.type, reason: 'AITable calculates this field' });
      continue;
    }
    if (field.permissionLevel === 'read') {
      readOnly.push({ name: field.name, type: field.type, reason: 'this connection cannot edit this field' });
      continue;
    }
    const schema = jsonSchemaFor(field);
    if (!schema) {
      readOnly.push({ name: field.name, type: field.type, reason: 'Divo cannot write this field type yet' });
      continue;
    }
    writable[field.name] = schema;
  }
  return { writable, readOnly };
}

function jsonSchemaFor(field: AitableField): Record<string, unknown> | null {
  const options = field.property?.options?.map(option => option.name) ?? [];
  switch (field.type) {
    case 'Text':
    case 'SingleText':
    case 'URL':
    case 'Email':
    case 'Phone':
      return { type: 'string' };
    case 'Checkbox':
      return { type: 'boolean' };
    case 'Number':
    case 'Currency':
    case 'Percent':
      return { type: 'number' };
    case 'Rating':
      return {
        type: 'integer',
        ...(typeof field.property?.max === 'number' ? { maximum: field.property.max, minimum: 0 } : {}),
      };
    case 'DateTime':
      return { type: 'string', description: 'ISO 8601 date-time, e.g. 2026-07-27T09:00:00Z' };
    case 'SingleSelect':
      return options.length ? { type: 'string', enum: options } : { type: 'string' };
    case 'MultiSelect':
      return { type: 'array', items: options.length ? { type: 'string', enum: options } : { type: 'string' } };
    case 'MagicLink':
      return { type: 'array', items: { type: 'string' }, description: 'record ids from the linked datasheet' };
    case 'Member':
      return { type: 'array', items: { type: 'string' }, description: 'AITable member unit ids' };
    case 'Attachment':
      return {
        type: 'array',
        description: 'attachment objects returned by the AITable upload step',
        items: { type: 'object', required: ['token'] },
      };
    default:
      return null;
  }
}
