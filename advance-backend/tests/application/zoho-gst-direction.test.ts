/**
 * The GST direction rule, on the payload it actually has to judge.
 *
 * It was written against a created invoice, where Zoho has expanded taxes into
 * named components — and then pointed at a draft, which carries `tax_id` and
 * nothing else. So it read no taxes, decided neither direction applied, and
 * skipped itself. An interstate sale carrying CGST/SGST passed with no findings
 * at the one moment it could still be stopped.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkInvoice } from '../../src/application/zoho/zoho-invoice-checks.ts';

const HOME = 'RJ';

// Ids as Zoho issues them, with its own inter/intra classification.
const IGST18 = '4058746000000034220';
const GST18  = '4058746000000034300';
const taxDirectionById = { [IGST18]: 'inter', [GST18]: 'intra' } as const;

const line = { name: 'Consulting retainer', quantity: 1, rate: 50000, item_total: 50000 };

const draft = (placeOfSupply: string, taxId: string) => ({
  customer_id: '4058746000000038007',
  place_of_supply: placeOfSupply,
  line_items: [{ ...line, tax_id: taxId }],
});

const codesFor = (invoice: Record<string, unknown>): string[] =>
  checkInvoice({ invoice, homeGstStateCode: HOME, taxDirectionById }).map(f => `${f.severity}:${f.code}`);

describe('GST direction on a staged draft, which names no taxes', () => {
  it('catches an interstate sale charged as CGST/SGST', () => {
    // Karnataka customer, Rajasthan seller, intra-state tax group. Before this
    // fix the draft passed clean and Zoho computed the wrong tax faithfully.
    assert.deepEqual(codesFor(draft('KA', GST18)), ['blocking:gst_should_be_igst']);
  });

  it('catches an intrastate sale charged as IGST', () => {
    assert.deepEqual(codesFor(draft('RJ', IGST18)), ['blocking:gst_should_be_split']);
  });

  it('passes the two correct combinations', () => {
    assert.deepEqual(codesFor(draft('KA', IGST18)), []);
    assert.deepEqual(codesFor(draft('RJ', GST18)), []);
  });

  it('says so when the selling state is unknown, rather than staying silent', () => {
    const findings = checkInvoice({ invoice: draft('KA', GST18), taxDirectionById });
    assert.deepEqual(findings.map(f => f.code), ['gst_direction_unchecked']);
  });

  it('will not compare a numeric state code against a lettered one', () => {
    // The GSTIN prefix ("08") and Zoho's place_of_supply ("RJ") are two
    // spellings of Rajasthan that never match each other. Comparing across them
    // does not fail safely: every intra-state sale reads as inter-state and the
    // finding is *blocking*, so the model is told to switch a correct
    // CGST/SGST invoice to IGST. A mismatched pair is the absence of an answer.
    const findings = checkInvoice({
      invoice: draft('RJ', GST18), homeGstStateCode: '08', taxDirectionById,
    });
    assert.deepEqual(findings.map(f => f.code), ['gst_direction_unchecked']);
  });

  it('still compares two numeric codes with each other', () => {
    const findings = checkInvoice({
      invoice: { customer_id: 'c1', place_of_supply: '29', line_items: [{ ...line, tax_id: GST18 }] },
      homeGstStateCode: '08', taxDirectionById,
    });
    assert.deepEqual(findings.map(f => f.code), ['gst_should_be_igst']);
  });

  it('refuses a draft carrying both directions at once', () => {
    const invoice = {
      customer_id: 'c1',
      place_of_supply: 'KA',
      line_items: [{ ...line, tax_id: IGST18 }, { ...line, tax_id: GST18 }],
    };
    const codes = checkInvoice({ invoice, homeGstStateCode: HOME, taxDirectionById }).map(f => f.code);
    assert.ok(codes.includes('mixed_gst'), `expected mixed_gst, got ${codes.join(', ')}`);
  });

  it('still reads a created invoice, where Zoho supplies names and no map', () => {
    // The same rule has to serve the post-creation drift check, which sees
    // names like "CGST9" and no tax ids we could look up.
    const created = {
      customer_id: 'c1',
      place_of_supply: 'KA',
      line_items: [{ ...line, tax_name: 'GST18' }],
      taxes: [{ tax_name: 'CGST9' }, { tax_name: 'SGST9' }],
    };
    assert.deepEqual(
      checkInvoice({ invoice: created, homeGstStateCode: HOME }).map(f => f.code),
      ['gst_should_be_igst'],
    );
  });

  it('leaves an invoice with no tax alone', () => {
    // Not every organisation charges GST, and "no tax" is not a wrong tax.
    const untaxed = { customer_id: 'c1', place_of_supply: 'KA', line_items: [line] };
    assert.deepEqual(checkInvoice({ invoice: untaxed, homeGstStateCode: HOME, taxDirectionById }), []);
  });

  it('ignores a tax id Zoho did not classify', () => {
    // An id absent from the map means unknown, which must not be read as a
    // direction — that would invent a finding from missing data.
    const unknown = { customer_id: 'c1', place_of_supply: 'KA', line_items: [{ ...line, tax_id: 'not-in-map' }] };
    assert.deepEqual(checkInvoice({ invoice: unknown, homeGstStateCode: HOME, taxDirectionById }), []);
  });
});
