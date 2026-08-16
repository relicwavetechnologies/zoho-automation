import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CompanyOmsSiteDataService } from '../../src/application/oms/company-oms-site-data.service.ts';
import { OmsSiteDataServiceError } from '../../src/application/oms/oms-site-data.types.ts';
import { ok } from '../../src/shared/result.ts';
import { noopLogger } from '../tools/tool-test.helpers.ts';

describe('CompanyOmsSiteDataService', () => {
  it('sanitizes website inputs without requiring a company OMS connection', async () => {
    const { service, calls } = makeService({ noConnection: true });
    const preflight = await service.preflight('co-1', { operation: 'sanitize_website_inputs', inputs: ['sales@example.com'] });
    const result = await service.execute({ companyId: 'co-1', args: { operation: 'sanitize_website_inputs', inputs: ['sales@example.com', 'bad'] } });

    assert.equal(preflight.connectionSource, 'none');
    assert.equal(result.status, 'complete');
    assert.deepEqual(result.coverage, {
      source: 'Divo OMS input sanitizer',
      inputCount: 2,
      candidateCount: 2,
      sanitizedRows: 1,
      invalidRows: 1,
    });
    assert.equal(result.rows[0]?.website, 'www.example.com');
    assert.equal(calls.fetch, 0);
  });

  it('preflights an active company connection without fetching provider data', async () => {
    const { service, calls } = makeService();
    const result = await service.preflight('co-1', { operation: 'search_sites', niche: 'Technology' });
    assert.equal(result.configured, true);
    assert.deepEqual(result.limits, { maxRowsPerResponse: 100, maxProfileWebsites: 20 });
    assert.equal(calls.fetch, 0);
  });

  it('marks provider auth failure unavailable after one attempt', async () => {
    const { service, calls } = makeService({ authFailure: true });
    await assert.rejects(
      () => service.execute({ companyId: 'co-1', args: { operation: 'get_site_profiles', websites: ['example.com'] } }),
      (error: unknown) => error instanceof OmsSiteDataServiceError && error.code === 'provider_auth_failed',
    );
    assert.equal(calls.fetch, 1);
    assert.equal(calls.failure[0]?.code, 'provider_auth_failed');
    assert.ok(calls.failure[0]?.unavailableUntil instanceof Date);
  });

  it('requires a verified proof bound to the same company, user, and key before save', async () => {
    const { service } = makeService();
    await assert.rejects(
      () => service.saveVerified({ companyId: 'co-1', userId: 'user-1', label: 'OMS', apiKey: 'key', verificationToken: 'missing' }),
      /Test this exact OMS Site Data API key/i,
    );
  });

  it('uses the server environment key only when no company connection exists', async () => {
    const { service, calls } = makeService({ noConnection: true, environmentApiKey: 'environment-key' });
    const preflight = await service.preflight('co-1', { operation: 'search_sites', niche: 'Technology' });
    const result = await service.execute({ companyId: 'co-1', args: { operation: 'search_sites', niche: 'Technology' } });
    assert.equal(preflight.connectionSource, 'environment');
    assert.equal(result.status, 'complete');
    assert.equal(calls.fetch, 1);
  });
});

function makeService(options: { authFailure?: boolean; noConnection?: boolean; environmentApiKey?: string } = {}) {
  const calls = { fetch: 0, failure: [] as Array<{ code: string; unavailableUntil?: Date }> };
  const cacheStore = new Map<string, unknown>();
  const cache = {
    get: async (key: string) => ok(cacheStore.get(key) ?? null),
    set: async (key: string, value: unknown) => { cacheStore.set(key, value); return ok(undefined); },
    setNx: async () => ok(true),
    del: async (key: string) => { cacheStore.delete(key); return ok(undefined); },
    scanDel: async () => ok(0),
  };
  const repository = {
    findActive: async () => options.noConnection ? null : ({ id: 'connection-1', apiKey: 'secret', status: 'connected' }),
    hasConfiguredConnection: async () => false,
    markSuccess: async () => {},
    markFailure: async (_id: string, code: string, unavailableUntil?: Date) => { calls.failure.push({ code, unavailableUntil }); },
  };
  const client = {
    verifyKey: async () => {},
    fetch: async () => {
      calls.fetch += 1;
      if (options.authFailure) throw new OmsSiteDataServiceError('provider_auth_failed', 'Denied.');
      return { operation: 'search_sites', status: 'complete' as const, coverage: {}, rows: [{ website: 'example.com' }] };
    },
  };
  return { service: new CompanyOmsSiteDataService(repository as never, client as never, cache as never, noopLogger, options.environmentApiKey ?? ''), calls };
}
