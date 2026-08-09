/**
 * A company cannot owe itself money.
 *
 * Asked to create an invoice from a PDF the company had issued, Divo loaded the
 * bill workflow, read the letterhead as the supplier, created the organisation
 * as a vendor of itself, and booked 59,000 payable to it. Zoho accepted every
 * step, because nothing about it was invalid.
 *
 * The routing mistake is fixable by instruction. These pin the wall behind the
 * instruction: whichever workflow is loaded, the party on the other side of a
 * transaction cannot be the organisation the books belong to.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { refuseSelfDealing, selfDealingReason } from '../../src/application/zoho/zoho-self-dealing.ts';

// Verbatim from the run: the organisation, and the vendor it created of itself.
const RELICWAVE = { name: 'Relicwave', gstNo: '08AABCD1234E1Z8' };

describe('the organisation cannot be its own counterparty', () => {
  it('refuses the vendor that was actually created', () => {
    const refusal = refuseSelfDealing({
      organization: RELICWAVE,
      party: { name: 'Relicwave', gstNo: '08AABCD1234E1Z8' },
      role: 'vendor',
      act: 'Recording this bill',
    });
    assert.ok(refusal, 'expected a refusal');
    assert.match(refusal, /own vendor/);
    // The refusal has to point at the way out, not merely forbid.
    assert.match(refusal, /zoho-books-invoice/);
  });

  it('recognises it by GST registration even under another name', () => {
    // Entered as a trading name, same registration. The number is the identity.
    const reason = selfDealingReason(RELICWAVE, { name: 'RW Consulting', gstNo: '08aabcd1234e1z8' });
    assert.match(String(reason), /GST registration/);
  });

  it('recognises it by name even when no GSTIN was given', () => {
    // The bill path resolves a vendor that may carry no registration at all.
    const reason = selfDealingReason(RELICWAVE, { name: 'relicwave' });
    assert.match(String(reason), /name of the organisation/);
  });

  it('sees through a difference of legal form', () => {
    assert.ok(selfDealingReason(RELICWAVE, { name: 'Relicwave Pvt. Ltd.' }));
  });

  it('lets a genuine supplier through', () => {
    // The cost of a false positive is a refused legitimate write, so the match
    // is exact — sharing a word is not sharing an identity.
    assert.equal(selfDealingReason(RELICWAVE, { name: 'Relicwave Partners', gstNo: '08AAFCN3333K1ZG' }), null);
    assert.equal(selfDealingReason(RELICWAVE, { name: 'Nimbus Cloud Services', gstNo: '08AAFCN3333K1ZG' }), null);
  });

  it('does not treat an unknown organisation as a match', () => {
    // Zoho does not always report the organisation's own GSTIN. Not knowing who
    // we are must never block a write on its own.
    assert.equal(selfDealingReason(undefined, { name: 'Relicwave' }), null);
    assert.equal(selfDealingReason({}, { name: 'Relicwave' }), null);
  });

  it('does not match two parties that merely both lack a GSTIN', () => {
    // Empty equals empty is the classic way a guard like this starts refusing
    // everything.
    assert.equal(selfDealingReason({ name: 'Relicwave' }, { name: 'Someone Else' }), null);
    assert.equal(selfDealingReason({ gstNo: '' }, { gstNo: '' }), null);
  });

  it('words a customer refusal for a customer', () => {
    const refusal = refuseSelfDealing({
      organization: RELICWAVE,
      party: { name: 'Relicwave' },
      role: 'customer',
      act: 'Creating this contact',
    });
    assert.match(String(refusal), /own customer/);
  });
});
