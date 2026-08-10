import { createHash } from 'node:crypto';
import { parse, toSql, type Expr, type From, type SelectStatement, type Statement } from 'pgsql-ast-parser';
import { z } from 'zod';

export const MENHOOD_TABLES = [
  'menhood_orders',
  'menhood_customers',
  'menhood_products',
  'all_cities_with_pincode',
] as const;

const TABLES = new Set<string>(MENHOOD_TABLES);
const MAX_SQL_BYTES = 32_000;
const MAX_PARAMETER_BYTES = 32_000;

const queryParameter = z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string().max(4_000),
]);

export const MenhoodQueryRequestSchema = z.object({
  sql: z.string().min(1).refine(sql => Buffer.byteLength(sql, 'utf8') <= MAX_SQL_BYTES, {
    message: `SQL must be at most ${MAX_SQL_BYTES} bytes`,
  }),
  parameters: z.array(queryParameter).max(100).optional(),
}).superRefine((request, ctx) => {
  if (Buffer.byteLength(JSON.stringify(request.parameters ?? []), 'utf8') > MAX_PARAMETER_BYTES) {
    ctx.addIssue({ code: 'custom', path: ['parameters'], message: 'Query parameters are too large' });
  }
});

export type MenhoodQueryRequest = z.infer<typeof MenhoodQueryRequestSchema>;
export type MenhoodQueryErrorCode =
  | 'invalid_query'
  | 'forbidden_table'
  | 'timeout'
  | 'unavailable_connection'
  | 'provider_failure';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
const jsonValue: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string(),
  z.array(jsonValue),
  z.record(jsonValue),
]));

export const MenhoodQueryResultSchema = z.object({
  columns: z.array(z.object({ name: z.string(), dataTypeId: z.number().int().nonnegative() })),
  rows: z.array(z.record(jsonValue)).max(25),
  coverage: z.object({ returnedRows: z.number().int().nonnegative(), truncated: z.boolean() }),
  elapsedMs: z.number().nonnegative(),
  queryFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});

export type MenhoodQueryResult = z.infer<typeof MenhoodQueryResultSchema>;

export class MenhoodQueryValidationError extends Error {
  constructor(readonly code: Extract<MenhoodQueryErrorCode, 'invalid_query' | 'forbidden_table'>, message: string) {
    super(message);
    this.name = 'MenhoodQueryValidationError';
  }
}

export type ValidatedMenhoodQuery = {
  readonly normalizedSql: string;
  readonly parameters: NonNullable<MenhoodQueryRequest['parameters']>;
  readonly tables: readonly string[];
  readonly fingerprint: string;
  readonly hasTopLevelOrderBy: boolean;
  readonly topLevelOrderBySql: readonly string[];
  readonly isTopLevelRowLevelSelect: boolean;
  /**
   * The caller's own `LIMIT n`, when it wrote one. A grouped query carrying a
   * LIMIT returns the top n of an unknown total, and the rows it returns look
   * exactly like a complete breakdown — nothing in the result set says the tail
   * was cut. Asked for channel performance, a `LIMIT 10` over 27 utm_source
   * values was rendered as the channel mix, missing bucket and all, and the
   * recommendation to cut a channel followed from it.
   */
  readonly topLevelLimit?: number;
};

export function validateMenhoodQuery(input: unknown): ValidatedMenhoodQuery {
  const request = MenhoodQueryRequestSchema.safeParse(input);
  if (!request.success) {
    throw new MenhoodQueryValidationError('invalid_query', request.error.issues[0]?.message ?? 'Invalid query');
  }

  let statements: Statement[];
  try {
    statements = parse(request.data.sql);
  } catch {
    throw new MenhoodQueryValidationError('invalid_query', 'SQL could not be parsed');
  }
  if (statements.length !== 1) {
    throw new MenhoodQueryValidationError('invalid_query', 'Exactly one SQL statement is required');
  }
  const statement = statements[0];
  if (!statement) {
    throw new MenhoodQueryValidationError('invalid_query', 'Exactly one SQL statement is required');
  }

  const tables = new Set<string>();
  const parameters = new Set<number>();
  validateStatement(statement, new Set(), tables, parameters);
  const parameterValues = request.data.parameters ?? [];
  const expectedParameters = Array.from({ length: parameterValues.length }, (_, index) => index + 1);
  if (JSON.stringify([...parameters].sort((a, b) => a - b)) !== JSON.stringify(expectedParameters)) {
    throw new MenhoodQueryValidationError('invalid_query', 'SQL parameters must match the supplied positional values');
  }

  const normalizedSql = toSql.statement(statement);
  const topLevel = topLevelSelect(statement);
  const topLevelOrderBySql = topLevelOrderBySqlFor(topLevel);
  const topLevelLimit = topLevelLimitOf(topLevel);
  const parameterTypes = parameterValues.map(value => value === null ? 'null' : typeof value);
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ sql: normalizedSql, parameterTypes }))
    .digest('hex');
  return {
    normalizedSql,
    parameters: parameterValues,
    tables: [...tables].sort(),
    fingerprint,
    hasTopLevelOrderBy: topLevelOrderBySql.length > 0,
    topLevelOrderBySql,
    isTopLevelRowLevelSelect: isRowLevelSelect(topLevel),
    ...(topLevelLimit === undefined ? {} : { topLevelLimit }),
  };
}

/** Only a literal integer LIMIT is reportable; an expression or parameter is not a number we can name back. */
function topLevelLimitOf(statement: Statement | null | undefined): number | undefined {
  if (!statement || statement.type !== 'select') return undefined;
  const limit = statement.limit?.limit;
  if (!limit || limit.type !== 'integer') return undefined;
  return limit.value;
}

export function menhoodQueryHasDeterministicReplayOrder(query: ValidatedMenhoodQuery): boolean {
  if (!query.hasTopLevelOrderBy) return false;
  if (!query.tables.includes('menhood_orders') || !query.isTopLevelRowLevelSelect) return true;
  return query.topLevelOrderBySql.some(expression => /(^|[^a-z0-9_])id([^a-z0-9_]|$)/i.test(expression));
}

function topLevelSelect(statement: Statement): Statement | null {
  if (statement.type === 'with') return topLevelSelect(statement.in);
  return statement.type === 'select' ? statement : null;
}

function topLevelOrderBySqlFor(statement: Statement | null): readonly string[] {
  const orderBy = (statement as { readonly orderBy?: readonly { readonly by: Expr }[] } | null)?.orderBy ?? [];
  return orderBy.map(order => toSql.expr(order.by));
}

function isRowLevelSelect(statement: Statement | null): boolean {
  const select = statement as { readonly groupBy?: readonly unknown[]; readonly distinct?: unknown } | null;
  return Boolean(statement && !select?.groupBy?.length && !select?.distinct);
}

function validateStatement(
  statement: Statement,
  inheritedCtes: ReadonlySet<string>,
  tables: Set<string>,
  parameters: Set<number>,
): void {
  if (statement.type === 'with recursive') {
    throw new MenhoodQueryValidationError('invalid_query', 'Recursive CTEs are not allowed');
  }
  if (statement.type === 'with') {
    const ctes = new Set(inheritedCtes);
    for (const binding of statement.bind) ctes.add(binding.alias.name.toLowerCase());
    for (const binding of statement.bind) validateStatement(binding.statement, ctes, tables, parameters);
    validateStatement(statement.in, ctes, tables, parameters);
    return;
  }
  if (statement.type === 'union' || statement.type === 'union all') {
    validateStatement(statement.left, inheritedCtes, tables, parameters);
    validateStatement(statement.right, inheritedCtes, tables, parameters);
    return;
  }
  if (statement.type !== 'select') {
    throw new MenhoodQueryValidationError('invalid_query', 'Only SELECT and read-only WITH queries are allowed');
  }
  if (statement.for || statement.skip) {
    throw new MenhoodQueryValidationError('invalid_query', 'Row-locking clauses are not allowed');
  }

  for (const from of statement.from ?? []) validateFrom(from, inheritedCtes, tables, parameters);
  for (const column of statement.columns ?? []) validateExpr(column.expr, inheritedCtes, tables, parameters);
  if (statement.where) validateExpr(statement.where, inheritedCtes, tables, parameters);
  for (const expr of statement.groupBy ?? []) validateExpr(expr, inheritedCtes, tables, parameters);
  if (statement.having) validateExpr(statement.having, inheritedCtes, tables, parameters);
  if (statement.limit?.limit) validateExpr(statement.limit.limit, inheritedCtes, tables, parameters);
  if (statement.limit?.offset) validateExpr(statement.limit.offset, inheritedCtes, tables, parameters);
  for (const order of statement.orderBy ?? []) validateExpr(order.by, inheritedCtes, tables, parameters);
  if (Array.isArray(statement.distinct)) {
    for (const expr of statement.distinct) validateExpr(expr, inheritedCtes, tables, parameters);
  }
}

function validateFrom(
  from: From,
  ctes: ReadonlySet<string>,
  tables: Set<string>,
  parameters: Set<number>,
): void {
  if (from.type === 'call') {
    throw new MenhoodQueryValidationError('invalid_query', 'Functions cannot be used as query relations');
  }
  if (from.type === 'statement') {
    validateStatement(from.statement, ctes, tables, parameters);
  } else {
    const name = from.name.name.toLowerCase();
    if (from.name.schema && from.name.schema.toLowerCase() !== 'public') {
      throw new MenhoodQueryValidationError('forbidden_table', 'Only the public schema is allowed');
    }
    if (!ctes.has(name)) {
      if (!TABLES.has(name)) {
        throw new MenhoodQueryValidationError('forbidden_table', `Table ${name} is not available`);
      }
      tables.add(name);
    }
  }
  if (from.join?.on) validateExpr(from.join.on, ctes, tables, parameters);
}

function validateExpr(
  expr: Expr,
  ctes: ReadonlySet<string>,
  tables: Set<string>,
  parameters: Set<number>,
): void {
  if (expr.type === 'parameter') {
    const index = Number(expr.name.startsWith('$') ? expr.name.slice(1) : expr.name);
    if (!Number.isInteger(index) || index < 1) {
      throw new MenhoodQueryValidationError('invalid_query', 'Only positional SQL parameters are allowed');
    }
    parameters.add(index);
    return;
  }
  if (expr.type === 'select' || expr.type === 'union' || expr.type === 'union all' || expr.type === 'with' || expr.type === 'with recursive') {
    validateStatement(expr as SelectStatement, ctes, tables, parameters);
    return;
  }
  if (expr.type === 'call') {
    const name = expr.function.name.toLowerCase();
    const schema = expr.function.schema?.toLowerCase();
    if (schema && schema !== 'public') {
      throw new MenhoodQueryValidationError('invalid_query', 'Schema-qualified functions are not allowed');
    }
    if (
      name.startsWith('pg_')
      || name.startsWith('lo_')
      || name.startsWith('dblink')
      || ['current_setting', 'set_config', 'query_to_xml', 'database_to_xml'].includes(name)
    ) {
      throw new MenhoodQueryValidationError('invalid_query', `Function ${name} is not allowed`);
    }
  }
  for (const value of Object.values(expr)) validateNestedExpr(value, ctes, tables, parameters);
}

function isExpr(value: unknown): value is Expr {
  return Boolean(value && typeof value === 'object' && 'type' in value);
}

function validateNestedExpr(
  value: unknown,
  ctes: ReadonlySet<string>,
  tables: Set<string>,
  parameters: Set<number>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) validateNestedExpr(item, ctes, tables, parameters);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (isExpr(value)) {
    validateExpr(value, ctes, tables, parameters);
    return;
  }
  for (const nested of Object.values(value)) validateNestedExpr(nested, ctes, tables, parameters);
}
