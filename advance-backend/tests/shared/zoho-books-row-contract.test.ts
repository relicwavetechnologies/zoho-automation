import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ZOHO_BOOKS_CONTACT_OUTSTANDING_RULE,
  ZOHO_BOOKS_OUTSTANDING_RULE,
} from '../../src/shared/zoho-books-row-contract.ts';

describe('zoho-books row contract', () => {
  it('keeps bill-row and contact-level outstanding guidance separate', () => {
    assert.match(ZOHO_BOOKS_OUTSTANDING_RULE, /_balance_inr/);
    assert.match(ZOHO_BOOKS_CONTACT_OUTSTANDING_RULE, /get_contact/);
    assert.match(ZOHO_BOOKS_CONTACT_OUTSTANDING_RULE, /outstanding_payable_amount/);
    assert.match(ZOHO_BOOKS_CONTACT_OUTSTANDING_RULE, /opening-balance/);
    assert.doesNotMatch(ZOHO_BOOKS_OUTSTANDING_RULE, /get_contact/);
  });
});
