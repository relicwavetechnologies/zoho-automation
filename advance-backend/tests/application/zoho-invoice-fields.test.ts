/**
 * The invoice that was refused in production said `payment_terms: "Net 15"`,
 * and Zoho answered `{"code":2,"message":"Invalid value passed for Payment
 * Terms"}`. Both halves of that failure are pinned here: the wording is
 * translated rather than rejected, and Zoho's own sentence survives the trip
 * back instead of being replaced by a status line that named nothing.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInvoiceFields } from '../../src/application/zoho/zoho-invoice-fields.ts';
import { mapZohoError } from '../../src/application/zoho/zoho-error.utils.ts';

const unwrap = (fields: Record<string, unknown>): Record<string, unknown> => {
  const result = normalizeInvoiceFields(fields);
  assert.equal(result.ok, true, `expected ok, refused with: ${result.ok ? '' : result.message}`);
  return result.ok ? result.fields : {};
};

const refusal = (fields: Record<string, unknown>): string => {
  const result = normalizeInvoiceFields(fields);
  assert.equal(result.ok, false, 'expected this payload to be refused');
  return result.ok ? '' : result.message;
};

describe('payment terms in the vocabulary the member used', () => {
  it('translates the wording that production actually sent', () => {
    const fields = unwrap({ customer_id: '311', payment_terms: 'Net 15' });
    assert.equal(fields['payment_terms'], 15);
    assert.equal(fields['payment_terms_label'], 'Net 15');
  });

  it('reads every spelling of the same term', () => {
    for (const [input, days] of [
      ['Net 15', 15], ['net-15', 15], ['NET15', 15],
      ['15 days', 15], ['15', 15],
      ['Due on Receipt', 0], ['immediate', 0],
    ] as const) {
      assert.equal(unwrap({ payment_terms: input })['payment_terms'], days, `for ${input}`);
    }
  });

  it('leaves a number that was already correct exactly as it was', () => {
    const fields = unwrap({ payment_terms: 30 });
    assert.equal(fields['payment_terms'], 30);
    // Nothing to label — the member never used words.
    assert.equal(fields['payment_terms_label'], undefined);
  });

  it('does not overwrite a label the caller set deliberately', () => {
    const fields = unwrap({ payment_terms: 'Net 15', payment_terms_label: 'Fifteen days' });
    assert.equal(fields['payment_terms'], 15);
    assert.equal(fields['payment_terms_label'], 'Fifteen days');
  });

  it('refuses a term it cannot read rather than dropping it', () => {
    // Silently discarding this would change when the invoice falls due while
    // reporting success — the failure worth having a test for.
    assert.match(refusal({ payment_terms: 'end of next quarter' }), /whole number of days/);
  });

  it('refuses a date dressed as a term', () => {
    // "15th of next month" carries exactly one digit run, so a "contains one
    // number" rule read it as 15 days and set a due date nobody asked for.
    for (const phrase of ['15th of next month', '1st of the next month', 'Net 15 days from EOM']) {
      assert.match(refusal({ payment_terms: phrase }), /whole number of days/, `for ${phrase}`);
    }
  });

  it('refuses a negative written as text rather than dropping its sign', () => {
    // "-5" once parsed to 5: the sign vanished and the invoice fell due early.
    refusal({ payment_terms: '-5' });
  });

  it('refuses a discount schedule instead of picking one of its numbers', () => {
    // "2/10 net 30" means 2% off if paid within 10 days, otherwise 30 days.
    // Reading either number as the due date would be a guess reported as fact.
    refusal({ payment_terms: '2/10 net 30' });
  });

  it('refuses a negative or fractional day count', () => {
    refusal({ payment_terms: -5 });
    refusal({ payment_terms: 7.5 });
  });

  it('leaves a payload with no payment terms untouched', () => {
    assert.deepEqual(
      unwrap({ customer_id: '311', due_date: '2026-08-23' }),
      { customer_id: '311', due_date: '2026-08-23' },
    );
  });

  it('reports what it re-read, so the member can be shown it', () => {
    const result = normalizeInvoiceFields({ payment_terms: 'Net 15' });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.notes.length, 1);
    assert.match(result.notes[0]!, /15 days/);
  });

  it('says nothing when it changed nothing', () => {
    const result = normalizeInvoiceFields({ payment_terms: 30 });
    assert.deepEqual(result.ok ? result.notes : null, []);
  });

  it('does not mutate the payload it was handed', () => {
    const original: Record<string, unknown> = { payment_terms: 'Net 15', line_items: [{ rate: 1 }] };
    normalizeInvoiceFields(original);
    assert.equal(original['payment_terms'], 'Net 15');
    assert.equal(original['payment_terms_label'], undefined);
  });
});

describe('Zoho keeps the last word on its own failures', () => {
  // Verbatim from the live 400 that refused the production invoice.
  const rejection = new Error(
    'Zoho Books 400 : {"code":2,"message":"Invalid value passed for Payment Terms"}',
  );

  it('surfaces the sentence that names the field', () => {
    assert.equal(
      mapZohoError(rejection),
      'Zoho Books says: "Invalid value passed for Payment Terms".',
    );
  });

  it('does not fall back to the generic status line when Zoho explained itself', () => {
    assert.doesNotMatch(mapZohoError(rejection), /Check the fields and try again/);
  });

  it('prefers Zoho over a code gloss that would contradict it', () => {
    // Zoho reuses 1002 for an inaccessible customer as well as for auth
    // failures. The gloss says "reconnect", which here would be false, and
    // would send a member to fix a connection that was working.
    const reused = new Error(
      'Zoho Books 404 : {"code":1002,"message":"The Customer is not accessible."}',
    );
    const mapped = mapZohoError(reused);
    assert.match(mapped, /The Customer is not accessible/);
    assert.doesNotMatch(mapped, /Reconnect/);
  });

  it('still tells a member to reconnect when the status really is 401', () => {
    const expired = new Error('Zoho Books 401 : {"code":57,"message":"Invalid OAuth token."}');
    assert.match(mapZohoError(expired), /Reconnect Zoho Books/);
  });

  it('reads a body the client truncated mid-object', () => {
    // The client keeps only the first 300 characters, so a long envelope
    // arrives as invalid JSON.
    const truncated = new Error(
      'Zoho Books 400 : {"code":2,"message":"Invalid value passed for Payment Terms","detai',
    );
    assert.match(mapZohoError(truncated), /Invalid value passed for Payment Terms/);
  });

  it('falls back to the code gloss when there is no body to read', () => {
    assert.equal(
      mapZohoError(new Error('Zoho Books 404 Not Found: ')),
      'Zoho Books could not find the requested record.',
    );
  });

  it('names the product that actually failed', () => {
    // mapZohoError is shared with the CRM tool, whose client throws "Zoho CRM".
    // Branding a CRM failure as Books sends the member to reconnect the wrong
    // connection.
    const crm = new Error('Zoho CRM 401 Unauthorized: {"code":"INVALID_TOKEN","message":"invalid oauth token"}');
    const mapped = mapZohoError(crm);
    assert.doesNotMatch(mapped, /Zoho Books/);
    assert.match(mapped, /Zoho CRM says: "invalid oauth token"/);
    assert.match(mapped, /Reconnect Zoho CRM/);
  });

  it('falls back in the right product name too', () => {
    assert.match(mapZohoError(new Error('Zoho CRM 404 Not Found: ')), /^Zoho CRM/);
  });

  it('still has something to say when nothing is recognisable', () => {
    // Neutral, not "Books": with nothing to read, naming a product would be a
    // guess, and it is the guess that misdirects a member.
    const mapped = mapZohoError(undefined);
    assert.match(mapped, /^Zoho request failed/);
    assert.doesNotMatch(mapped, /Zoho Books|Zoho CRM/);
  });
});
