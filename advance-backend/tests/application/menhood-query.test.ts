import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  menhoodQueryHasDeterministicReplayOrder,
  MenhoodQueryValidationError,
  validateMenhoodQuery,
} from '../../src/application/menhood/menhood-query.ts';

const rejects = (sql: string, code: MenhoodQueryValidationError['code'] = 'invalid_query') => {
  assert.throws(
    () => validateMenhoodQuery({ sql }),
    error => error instanceof MenhoodQueryValidationError && error.code === code,
  );
};

describe('Menhood query validation', () => {
  it('accepts filtered joins, grouping, common analytics functions, and positional values', () => {
    const query = validateMenhoodQuery({
      sql: `
        SELECT date_trunc('month', o.order_date) AS month, p.sku, count(DISTINCT o.order_number) AS orders
        FROM menhood_orders o
        JOIN menhood_products p ON p.id = o.product_id
        WHERE o.status = $1
        GROUP BY 1, 2
        ORDER BY 1 DESC
      `,
      parameters: ['Delivered'],
    });
    assert.deepEqual(query.tables, ['menhood_orders', 'menhood_products']);
    assert.equal(query.fingerprint.length, 64);
    assert.equal(query.parameters[0], 'Delivered');
    assert.equal(query.hasTopLevelOrderBy, true);
    assert.deepEqual(query.topLevelOrderBySql, ['(1)']);
    assert.equal(query.isTopLevelRowLevelSelect, false);
  });

  it('accepts read-only CTEs and the city lookup', () => {
    const query = validateMenhoodQuery({
      sql: `WITH recent AS (SELECT pincode FROM menhood_customers) SELECT c.city FROM all_cities_with_pincode c JOIN recent r ON r.pincode = c.pincode`,
    });
    assert.deepEqual(query.tables, ['all_cities_with_pincode', 'menhood_customers']);
    assert.equal(query.hasTopLevelOrderBy, false);
  });

  it('identifies deterministic replay order for truncated raw Menhood order rows', () => {
    const unsafe = validateMenhoodQuery({
      sql: 'SELECT o.order_number FROM menhood_orders o ORDER BY o.order_number',
    });
    assert.equal(unsafe.hasTopLevelOrderBy, true);
    assert.equal(unsafe.isTopLevelRowLevelSelect, true);
    assert.equal(menhoodQueryHasDeterministicReplayOrder(unsafe), false);

    const safe = validateMenhoodQuery({
      sql: 'SELECT o.order_number FROM menhood_orders o ORDER BY o.order_date, o.order_number, o.id',
    });
    assert.deepEqual(safe.topLevelOrderBySql, ['o .order_date', 'o .order_number', 'o .id']);
    assert.equal(menhoodQueryHasDeterministicReplayOrder(safe), true);
  });

  it('rejects multiple statements and every direct write family', () => {
    rejects('SELECT * FROM menhood_orders; SELECT * FROM menhood_customers');
    rejects("INSERT INTO menhood_orders (id) VALUES ('x')");
    rejects("UPDATE menhood_orders SET status = 'Delivered'");
    rejects('DELETE FROM menhood_orders');
    rejects('TRUNCATE menhood_orders');
    rejects('MERGE INTO menhood_orders o USING menhood_customers c ON o.customer_id = c.id WHEN MATCHED THEN DELETE');
    rejects('COPY menhood_orders TO STDOUT');
    rejects('SELECT * INTO copied_orders FROM menhood_orders');
    rejects('CREATE TABLE copy AS SELECT * FROM menhood_orders');
    rejects("SET application_name = 'menhood'");
    rejects('CALL refresh_orders()');
    rejects("DO $$ BEGIN RAISE NOTICE 'x'; END $$");
  });

  it('rejects data-modifying and recursive CTEs', () => {
    rejects('WITH changed AS (DELETE FROM menhood_orders RETURNING *) SELECT * FROM changed');
    rejects('WITH RECURSIVE n AS (SELECT 1 UNION ALL SELECT 2) SELECT * FROM n');
  });

  it('rejects unapproved schemas and tables, including advertisement costs', () => {
    rejects('SELECT * FROM private.menhood_orders', 'forbidden_table');
    rejects('SELECT * FROM pg_catalog.pg_roles', 'forbidden_table');
    rejects('SELECT * FROM menhood_advertisement_costs', 'forbidden_table');
  });

  it('rejects row locks and functions used as relations', () => {
    rejects('SELECT * FROM menhood_orders FOR UPDATE');
    rejects('SELECT * FROM generate_series(1, 10)');
  });

  it('blocks server, file, large-object, and configuration functions', () => {
    rejects("SELECT pg_read_file('/etc/passwd')");
    rejects("SELECT CASE WHEN true THEN pg_read_file('/etc/passwd') ELSE '' END");
    rejects("SELECT lo_import('/tmp/file')");
    rejects("SELECT dblink_exec('x', 'delete from y')");
    rejects("SELECT current_setting('data_directory')");
  });

  it('requires supplied positional values to match SQL parameters exactly', () => {
    rejects('SELECT * FROM menhood_orders WHERE status = $1');
    assert.throws(
      () => validateMenhoodQuery({ sql: 'SELECT * FROM menhood_orders', parameters: ['unused'] }),
      MenhoodQueryValidationError,
    );
    assert.throws(
      () => validateMenhoodQuery({ sql: 'SELECT * FROM menhood_orders WHERE status = $2', parameters: ['a', 'b'] }),
      MenhoodQueryValidationError,
    );
    assert.doesNotThrow(() => validateMenhoodQuery({
      sql: 'SELECT count(*) FILTER (WHERE status = $1) FROM menhood_orders',
      parameters: ['Delivered'],
    }));
  });

  it('keeps parameter values out of the fingerprint', () => {
    const first = validateMenhoodQuery({ sql: 'SELECT * FROM menhood_orders WHERE status = $1', parameters: ['Delivered'] });
    const second = validateMenhoodQuery({ sql: 'SELECT * FROM menhood_orders WHERE status = $1', parameters: ['Cancelled'] });
    assert.equal(first.fingerprint, second.fingerprint);
    assert.equal(
      validateMenhoodQuery({
        sql: 'SELECT * FROM menhood_orders WHERE status = $1',
        parameters: ["'; DELETE FROM menhood_orders; --"],
      }).parameters.length,
      1,
    );
  });

  it('bounds SQL, parameters, and export titles', () => {
    rejects('');
    rejects(`SELECT '${'x'.repeat(32_001)}'`);
    assert.throws(
      () => validateMenhoodQuery({ sql: 'SELECT 1', parameters: Array.from({ length: 101 }, () => 1) }),
      MenhoodQueryValidationError,
    );
    assert.throws(
      () => validateMenhoodQuery({ sql: 'SELECT 1', parameters: ['x'.repeat(4_001)] }),
      MenhoodQueryValidationError,
    );
    assert.throws(
      () => validateMenhoodQuery({
        sql: 'SELECT 1',
        parameters: Array.from({ length: 9 }, () => 'x'.repeat(4_000)),
      }),
      MenhoodQueryValidationError,
    );
  });
});
