import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createZohoContactService } from '../../src/application/zoho/zoho-contact.service.ts';
import type { ZohoBooksPaginatedClient } from '../../src/infrastructure/zoho/zoho-books-paginated.client.ts';

const context = {
  companyId: 'co-1',
  userId: 'user-1',
  connectionId: 'conn-1',
};

describe('Zoho contact service', () => {
  it('creates a contact through the shared Books write path', async () => {
    let mutation: any;
    const booksClient = {
      listOrganizations: async () => [{ organizationId: 'org-1', isDefault: true, name: 'Relicwave' }],
      mutate: async (input: any) => {
        mutation = input;
        return {
          organizationId: 'org-1',
          payload: { contact: { contact_id: 'contact-1', contact_name: 'Acme Ltd' } },
        };
      },
    } as unknown as ZohoBooksPaginatedClient;

    const service = createZohoContactService({ booksClient, appBaseUrl: 'https://books.zoho.com' });
    const result = await service.create({ ...context, fields: { contact_name: 'Acme Ltd' } });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(mutation.path, '/contacts');
    assert.deepEqual(mutation.body, { contact_name: 'Acme Ltd' });
    assert.equal(result.value.record['contact_id'], 'contact-1');
    assert.match(result.value.summary.message, /Contact Acme Ltd created in Zoho Books/);
  });

  it('refuses to create the Zoho organization itself as a contact', async () => {
    let mutations = 0;
    const booksClient = {
      listOrganizations: async () => [{ organizationId: 'org-1', isDefault: true, name: 'Relicwave Pvt Ltd' }],
      mutate: async () => {
        mutations += 1;
        return { organizationId: 'org-1', payload: {} };
      },
    } as unknown as ZohoBooksPaginatedClient;

    const service = createZohoContactService({ booksClient, appBaseUrl: 'https://books.zoho.com' });
    const result = await service.create({
      ...context,
      fields: { contact_name: 'Relicwave Limited', contact_type: 'vendor' },
    });

    assert.equal(result.ok, false);
    assert.equal(mutations, 0);
    assert.match((result as any).error.payload.message, /own vendor/i);
  });
});
