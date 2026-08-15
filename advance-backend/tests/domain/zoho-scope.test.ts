import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hasZohoScope, zohoServicesForScopes } from '../../src/domain/zoho/zoho-scope.ts';

describe('Zoho scope classification', () => {
  it('distinguishes CRM from Books connections case-insensitively', () => {
    assert.deepEqual(zohoServicesForScopes(['ZohoBooks.fullaccess.READ']), ['books']);
    assert.deepEqual(zohoServicesForScopes(['ZohoCRM.modules.ALL']), ['crm']);
    assert.deepEqual(
      zohoServicesForScopes(['zohocrm.modules.read', 'zohobooks.fullaccess.all']),
      ['crm', 'books'],
    );
  });

  it('requires a write-capable product scope for mutations', () => {
    assert.equal(hasZohoScope(['ZohoCRM.modules.READ'], 'crm', 'read'), true);
    assert.equal(hasZohoScope(['ZohoCRM.modules.READ'], 'crm', 'update'), false);
    assert.equal(hasZohoScope(['ZohoCRM.modules.UPDATE'], 'crm', 'update'), true);
    assert.equal(hasZohoScope(['ZohoBooks.fullaccess.READ'], 'books', 'read'), true);
    assert.equal(hasZohoScope(['ZohoBooks.fullaccess.READ'], 'books', 'create'), false);
    assert.equal(hasZohoScope(['ZohoBooks.fullaccess.all'], 'books', 'create'), true);
  });

  it('accepts only the matching module scope for Books mutations', () => {
    assert.equal(hasZohoScope(['ZohoBooks.bills.CREATE'], 'books', 'create', 'bills'), true);
    assert.equal(hasZohoScope(['ZohoBooks.bills.ALL'], 'books', 'create', 'bills'), true);
    assert.equal(hasZohoScope(['ZohoBooks.bills.CREATE'], 'books', 'create', 'invoices'), false);
    assert.equal(hasZohoScope(['ZohoBooks.invoices.CREATE'], 'books', 'create', 'invoices'), true);
    assert.equal(hasZohoScope(['ZohoBooks.purchaseorders.CREATE'], 'books', 'create', 'purchaseorders'), true);
    assert.equal(hasZohoScope(['ZohoBooks.purchaseorders.READ'], 'books', 'create', 'purchaseorders'), false);
  });
});
