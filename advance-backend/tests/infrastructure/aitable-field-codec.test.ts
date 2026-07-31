import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeCellValue,
  encodeRecordFields,
  describeFieldsForModel,
  AitableFieldEncodingError,
  AITABLE_FIELD_TYPES,
  AITABLE_COMPUTED_FIELD_TYPES,
  type AitableField,
} from '../../src/infrastructure/aitable/aitable-field-codec.ts';

const field = (type: string, over: Partial<AitableField> = {}): AitableField => ({
  id: 'fld1',
  name: over.name ?? `${type} field`,
  type,
  ...over,
});

const encodingError = (reason: string) => (e: unknown) =>
  e instanceof AitableFieldEncodingError && e.reason === reason;

describe('AITable field encoding', () => {
  it('covers all 23 declared field types', () => {
    assert.equal(AITABLE_FIELD_TYPES.length, 23);
    assert.equal(AITABLE_COMPUTED_FIELD_TYPES.size, 7);
  });

  // The failure this whole file exists to prevent. AITable's own MCP server
  // dropped values it could not convert and reported success, so a caller
  // setting six fields could have four written and be told all six landed.
  it('refuses a computed field rather than dropping it silently', () => {
    for (const type of AITABLE_COMPUTED_FIELD_TYPES) {
      assert.throws(
        () => encodeCellValue(field(type), 'anything'),
        encodingError('computed_field'),
        type,
      );
    }
  });

  it('refuses a field this connection may only read', () => {
    assert.throws(
      () => encodeCellValue(field('Text', { permissionLevel: 'read' }), 'hello'),
      encodingError('read_only_field'),
    );
  });

  it('refuses a type it has no mapping for, instead of guessing', () => {
    assert.throws(
      () => encodeCellValue(field('SomeFutureType'), 'x'),
      encodingError('unsupported_type'),
    );
  });

  it('passes null through, because clearing a cell is a real write', () => {
    assert.equal(encodeCellValue(field('Text'), null), null);
    assert.equal(encodeCellValue(field('Number'), null), null);
  });

  it('encodes the plain text-shaped types', () => {
    for (const type of ['Text', 'SingleText', 'URL', 'Email', 'Phone']) {
      assert.equal(encodeCellValue(field(type), 'hello'), 'hello', type);
    }
    assert.equal(encodeCellValue(field('Text'), 42), '42');
  });

  it('encodes numbers and rejects strings that are not numbers', () => {
    assert.equal(encodeCellValue(field('Number'), 12.5), 12.5);
    assert.equal(encodeCellValue(field('Currency'), '99'), 99);
    // "12abc" → NaN and "" → 0 under a naive Number(), and both would be
    // written as data the caller never supplied.
    assert.throws(() => encodeCellValue(field('Number'), '12abc'), encodingError('invalid_value'));
    assert.throws(() => encodeCellValue(field('Number'), ''), encodingError('invalid_value'));
    assert.throws(() => encodeCellValue(field('Number'), NaN), encodingError('invalid_value'));
  });

  // Boolean(value) would turn the string "false" into true and 0 into false —
  // both the opposite of what was asked.
  it('encodes checkboxes without coercing surprising values', () => {
    assert.equal(encodeCellValue(field('Checkbox'), true), true);
    assert.equal(encodeCellValue(field('Checkbox'), 'false'), false);
    assert.throws(() => encodeCellValue(field('Checkbox'), 0), encodingError('invalid_value'));
    assert.throws(() => encodeCellValue(field('Checkbox'), 'yes'), encodingError('invalid_value'));
  });

  it('accepts both an ISO string and a timestamp for a date', () => {
    assert.equal(encodeCellValue(field('DateTime'), '2026-07-27T09:00:00Z'), '2026-07-27T09:00:00.000Z');
    assert.equal(encodeCellValue(field('DateTime'), 1_764_000_000_000), 1_764_000_000_000);
    assert.throws(() => encodeCellValue(field('DateTime'), 'next Tuesday'), encodingError('invalid_value'));
    // An empty date string became null in AITable's converter and was then
    // dropped from the write entirely.
    assert.throws(() => encodeCellValue(field('DateTime'), ''), encodingError('invalid_value'));
  });

  // Clamping would record a score nobody asked for. The upstream MCP server
  // told the model to "reduce to max" and then wrote whatever it received.
  it('refuses a rating above the field maximum instead of clamping', () => {
    const rating = field('Rating', { property: { max: 5 } });
    assert.equal(encodeCellValue(rating, 4), 4);
    assert.throws(() => encodeCellValue(rating, 9), encodingError('invalid_value'));
    assert.throws(() => encodeCellValue(rating, 2.5), encodingError('invalid_value'));
  });

  it('validates a select value against the declared options', () => {
    const select = field('SingleSelect', { property: { options: [{ id: 'o1', name: 'Open' }] } });
    assert.equal(encodeCellValue(select, 'Open'), 'Open');
    assert.throws(() => encodeCellValue(select, 'Closed'), encodingError('invalid_value'));
  });

  // An absent option list means the schema did not carry one, not that the
  // field has no options — so the value must pass rather than be rejected.
  it('does not invent a constraint when the schema carries no options', () => {
    assert.equal(encodeCellValue(field('SingleSelect'), 'Anything'), 'Anything');
  });

  it('encodes multi-select as a list, accepting a bare value', () => {
    const multi = field('MultiSelect', {
      property: { options: [{ id: 'o1', name: 'A' }, { id: 'o2', name: 'B' }] },
    });
    assert.deepEqual(encodeCellValue(multi, ['A', 'B']), ['A', 'B']);
    assert.deepEqual(encodeCellValue(multi, 'A'), ['A']);
    assert.throws(() => encodeCellValue(multi, ['A', 'Z']), encodingError('invalid_value'));
  });

  it('requires attachments to come from the AITable upload step', () => {
    const attachment = field('Attachment');
    const uploaded = { token: 'tok', name: 'a.png', size: 1, mimeType: 'image/png', url: 'https://x/a.png' };
    assert.deepEqual(encodeCellValue(attachment, uploaded), [uploaded]);
    // A URL or path looks plausible and would attach nothing.
    assert.throws(() => encodeCellValue(attachment, 'https://x/a.png'), encodingError('invalid_value'));
    assert.throws(() => encodeCellValue(attachment, { name: 'a.png' }), encodingError('invalid_value'));
  });

  it('takes record ids for a link field and member ids for a member field', () => {
    assert.deepEqual(encodeCellValue(field('MagicLink'), 'rec1'), ['rec1']);
    assert.deepEqual(encodeCellValue(field('Member'), ['unit1', 'unit2']), ['unit1', 'unit2']);
    // Names are not resolved: guessing which "Alex" was meant is exactly the
    // silent wrong answer this codec refuses to produce.
    assert.throws(() => encodeCellValue(field('Member'), { name: 'Alex' }), encodingError('invalid_value'));
    assert.throws(() => encodeCellValue(field('MagicLink'), ''), encodingError('invalid_value'));
  });
});

describe('AITable record encoding', () => {
  const fields: AitableField[] = [
    field('Text', { name: 'Title' }),
    field('Number', { name: 'Score' }),
    field('Formula', { name: 'Computed' }),
  ];

  it('encodes every supplied field', () => {
    assert.deepEqual(
      encodeRecordFields(fields, { Title: 'Launch', Score: 3 }),
      { Title: 'Launch', Score: 3 },
    );
  });

  // Ignoring an unknown name is how a model comes to believe it set a value it
  // never set.
  it('refuses a field name the datasheet does not have', () => {
    assert.throws(
      () => encodeRecordFields(fields, { Titel: 'typo' }),
      encodingError('unknown_field'),
    );
  });

  it('names the available fields when rejecting an unknown one', () => {
    assert.throws(
      () => encodeRecordFields(fields, { Nope: 1 }),
      (e: unknown) => e instanceof AitableFieldEncodingError && e.message.includes('Title'),
    );
  });

  // All-or-nothing: one bad value must not leave a partially-encoded record
  // that a caller could still decide to send.
  it('fails the whole record when one value cannot be encoded', () => {
    assert.throws(
      () => encodeRecordFields(fields, { Title: 'ok', Computed: 'nope' }),
      encodingError('computed_field'),
    );
  });

  it('skips undefined without treating it as a value', () => {
    assert.deepEqual(encodeRecordFields(fields, { Title: 'ok', Score: undefined }), { Title: 'ok' });
  });
});

describe('AITable schema description for the model', () => {
  // The upstream server omitted unmapped fields entirely and marked every
  // survivor required, presenting a partial picture as a complete one.
  it('lists unwritable fields rather than hiding them', () => {
    const described = describeFieldsForModel([
      field('Text', { name: 'Title' }),
      field('Formula', { name: 'Total' }),
      field('Text', { name: 'Locked', permissionLevel: 'read' }),
      field('SomeFutureType', { name: 'Exotic' }),
    ]);

    assert.deepEqual(Object.keys(described.writable), ['Title']);
    assert.deepEqual(
      described.readOnly.map(entry => entry.name).sort(),
      ['Exotic', 'Locked', 'Total'],
    );
  });

  it('gives each read-only field a reason a person can act on', () => {
    const described = describeFieldsForModel([field('Formula', { name: 'Total' })]);
    assert.match(described.readOnly[0]!.reason, /calculates/i);
  });

  it('carries select options and rating bounds into the schema', () => {
    const described = describeFieldsForModel([
      field('SingleSelect', { name: 'Stage', property: { options: [{ id: 'o1', name: 'Open' }] } }),
      field('Rating', { name: 'Score', property: { max: 5 } }),
    ]);

    assert.deepEqual((described.writable['Stage'] as any).enum, ['Open']);
    assert.equal((described.writable['Score'] as any).maximum, 5);
  });

  // Email fields vanished from the upstream schema because of a trailing space
  // in a type name, while every remaining field was still marked required.
  it('describes every writable type, including the ones upstream lost', () => {
    const writableTypes = AITABLE_FIELD_TYPES.filter(type => !AITABLE_COMPUTED_FIELD_TYPES.has(type));
    const described = describeFieldsForModel(writableTypes.map(type => field(type, { name: type })));

    assert.deepEqual(described.readOnly, [], 'no writable type should be reported as unwritable');
    assert.equal(Object.keys(described.writable).length, writableTypes.length);
  });
});
