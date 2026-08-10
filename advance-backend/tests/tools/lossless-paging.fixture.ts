import assert from 'node:assert/strict';

export interface LosslessPage<Row, Cursor> {
  readonly rows: readonly Row[];
  readonly hasMore: boolean;
  readonly nextCursor?: Cursor;
}

/**
 * Provider-neutral proof for a terminal-safe source contract.
 *
 * Providers keep their own page/cursor shapes. This fixture checks only the
 * invariants Pi must be able to trust: every row appears exactly once, order is
 * preserved, and every non-final page supplies a new continuation.
 */
export async function assertLosslessPagingFixture<Row, Cursor>(input: {
  readonly expectedIds: readonly string[];
  readonly initialCursor: Cursor;
  readonly readPage: (cursor: Cursor) => Promise<LosslessPage<Row, Cursor>>;
  readonly rowId: (row: Row) => string;
  readonly cursorKey?: (cursor: Cursor) => string;
  readonly maxPages?: number;
}): Promise<{ readonly pageSizes: readonly number[]; readonly rows: readonly Row[] }> {
  const cursorKey = input.cursorKey ?? (cursor => JSON.stringify(cursor));
  const maxPages = input.maxPages ?? 1_000;
  const visitedCursors = new Set<string>();
  const seenRows = new Set<string>();
  const rows: Row[] = [];
  const pageSizes: number[] = [];
  let cursor = input.initialCursor;

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    const currentKey = cursorKey(cursor);
    assert.equal(visitedCursors.has(currentKey), false, `continuation loop at ${currentKey}`);
    visitedCursors.add(currentKey);

    const page = await input.readPage(cursor);
    pageSizes.push(page.rows.length);
    for (const row of page.rows) {
      const id = input.rowId(row);
      assert.ok(id, `page ${pageNumber} returned a row without an identity`);
      assert.equal(seenRows.has(id), false, `duplicate row ${id}`);
      seenRows.add(id);
      rows.push(row);
    }

    if (!page.hasMore) {
      assert.equal(page.nextCursor, undefined, 'final page returned a stale continuation');
      assert.deepEqual(rows.map(input.rowId), input.expectedIds);
      return { pageSizes, rows };
    }

    assert.ok(page.rows.length > 0, `page ${pageNumber} claimed more data but returned no rows`);
    assert.notEqual(page.nextCursor, undefined, `page ${pageNumber} omitted its continuation`);
    cursor = page.nextCursor!;
  }

  assert.fail(`paging exceeded the ${maxPages}-page fixture guard`);
}
