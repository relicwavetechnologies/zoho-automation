import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDatasetPreview,
  DATASET_PREVIEW_ROW_LIMIT,
} from '../../src/application/provider-data/dataset-preview.ts';

describe('createDatasetPreview', () => {
  it('keeps a complete result at or below the 25-row model limit', () => {
    const rows = Array.from({ length: DATASET_PREVIEW_ROW_LIMIT }, (_, index) => ({
      id: index,
      name: `Row ${index}`,
    }));

    const preview = createDatasetPreview({
      rows,
      coverage: { kind: 'complete', totalRows: rows.length },
    });

    assert.equal(preview.rows.length, DATASET_PREVIEW_ROW_LIMIT);
    assert.deepEqual(preview.columns, ['id', 'name']);
    assert.deepEqual(preview.coverage, { kind: 'complete', totalRows: 25 });
  });

  it('caps an oversized complete result and reports the known total truthfully', () => {
    const rows = Array.from({ length: 26 }, (_, index) => ({ id: index }));

    const preview = createDatasetPreview({
      rows,
      coverage: { kind: 'complete', totalRows: rows.length },
    });

    assert.equal(preview.rows.length, DATASET_PREVIEW_ROW_LIMIT);
    assert.deepEqual(preview.coverage, {
      kind: 'truncated',
      returnedRows: 25,
      knownTotal: 26,
      reason: 'model_preview_limit',
    });
  });

  it('preserves provider-limited and unknown coverage without inventing completeness', () => {
    const providerRows = Array.from({ length: 100 }, (_, id) => ({ id }));
    const providerLimited = createDatasetPreview({
      rows: providerRows,
      coverage: { kind: 'provider_limited', returnedRows: 100, reason: 'provider_cap' },
    });
    assert.equal(providerLimited.rows.length, 25);
    assert.deepEqual(providerLimited.coverage, {
      kind: 'provider_limited',
      returnedRows: 100,
      reason: 'provider_cap',
    });
    const unknown = createDatasetPreview({
      rows: providerRows,
      coverage: { kind: 'unknown', returnedRows: 100 },
    });
    assert.equal(unknown.rows.length, 25);
    assert.deepEqual(unknown.coverage, { kind: 'unknown', returnedRows: 100 });
  });
});
