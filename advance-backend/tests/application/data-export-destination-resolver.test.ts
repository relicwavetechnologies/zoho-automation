import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { selectDataExportDestination } from '../../src/application/data-export/data-export-destination-resolver.ts';

describe('data export destination selection', () => {
  it('always selects the administrator-approved company destination', () => {
    assert.deepEqual(selectDataExportDestination({
      companyDestination: { connectionId: 'company-1' },
    }), {
      status: 'selected',
      target: { kind: 'company_google', connectionId: 'company-1' },
    });
  });

  it('accepts only the exact configured company connection when a caller supplies one', () => {
    assert.deepEqual(selectDataExportDestination({
      companyDestination: { connectionId: 'company-1' },
      connectionId: 'company-1',
    }), {
      status: 'selected',
      target: { kind: 'company_google', connectionId: 'company-1' },
    });

    assert.deepEqual(selectDataExportDestination({
      companyDestination: { connectionId: 'company-1' },
      connectionId: 'personal-1',
    }), {
      status: 'unavailable',
      message: 'Personal Google accounts cannot override the company export destination.',
    });
  });

  it('fails closed when the company destination is unavailable', () => {
    assert.deepEqual(selectDataExportDestination({}), {
      status: 'unavailable',
      message: 'Company data export is not configured by an administrator.',
    });
    assert.deepEqual(selectDataExportDestination({
      unavailableReason: 'The company Google export account is disconnected.',
    }), {
      status: 'unavailable',
      message: 'The company Google export account is disconnected.',
    });
  });
});
