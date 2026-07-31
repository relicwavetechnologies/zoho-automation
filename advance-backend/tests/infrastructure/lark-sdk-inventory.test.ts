import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createLarkSdkInventory,
  LARK_SDK_PARITY_BASELINE,
} from '../../src/infrastructure/channels/lark/lark-sdk-inventory.ts';

describe('Lark SDK parity inventory', () => {
  const inventory = createLarkSdkInventory();

  it('matches the reviewed SDK endpoint baseline', () => {
    assert.deepEqual(
      {
        packageName: inventory.packageName,
        version: inventory.version,
        endpointCount: inventory.endpointCount,
        serviceCount: inventory.serviceCount,
        sha256: inventory.sha256,
      },
      LARK_SDK_PARITY_BASELINE,
    );
  });

  it('is deterministic and contains unique canonical endpoints', () => {
    const ids = inventory.endpoints.map(endpoint => endpoint.id);
    assert.deepEqual(ids, [...ids].sort());
    assert.equal(new Set(ids).size, ids.length);
    for (const endpoint of inventory.endpoints) {
      assert.deepEqual(endpoint.sdkPaths, [...endpoint.sdkPaths].sort());
      assert.ok(endpoint.sdkPaths.length > 0);
      assert.ok(endpoint.services.length > 0);
    }
  });

  it('collapses generated version aliases onto one HTTP endpoint', () => {
    const createDocument = inventory.endpoints.find(
      endpoint => endpoint.id === 'POST /open-apis/docx/v1/documents',
    );
    assert.ok(createDocument);
    assert.ok(createDocument.sdkPaths.includes('docx.document.create'));
    assert.ok(createDocument.sdkPaths.includes('docx.v1.document.create'));
  });

  it('captures the native document block endpoint used for todo blocks', () => {
    assert.ok(inventory.endpoints.some(
      endpoint =>
        endpoint.id
        === 'POST /open-apis/docx/v1/documents/:document_id/blocks/:block_id/children',
    ));
  });
});
