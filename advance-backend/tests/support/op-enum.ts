import assert from 'node:assert/strict';

/**
 * A tool's `op` enum reaches the model twice: once in the serialized argsSchema
 * that becomes the tool's `parameters`, and once as prose in `parameterDocs`.
 * The second is a copy, and copies drift — `zohoBooks` documented an op line
 * with no `stage_invoice` while its enum had one, so the documented surface and
 * the validated surface disagreed about whether an invoice could be staged.
 *
 * `parameterDocs.includes(op)` does not catch that: op names are ordinary words
 * that recur in the surrounding prose, so "create", "list", "update" and
 * "delete" pass against docs whose op line has been truncated.
 */
export function operationOptions(schema: unknown): readonly string[] {
  type SchemaNode = {
    _def?: {
      schema?: SchemaNode;
      shape?: (() => { op?: { options?: readonly string[] } }) | { op?: { options?: readonly string[] } };
    };
  };
  let node = schema as SchemaNode;
  while (node._def?.schema) node = node._def.schema;
  const rawShape = node._def?.shape;
  const shape = typeof rawShape === 'function' ? rawShape() : rawShape;
  assert(shape?.op?.options, 'tool schema must expose an op enum');
  return shape.op.options;
}

/** The ops a tool writes into `parameterDocs`, read off its `op:` line. */
export function documentedOperations(parameterDocs: string): readonly string[] {
  const line = parameterDocs.match(/(?:^|\n)[-\s]*op:\s*([^\n.]+)/)?.[1];
  assert(line, 'parameterDocs must declare an op line');
  return line.split('|').map(op => op.trim());
}

/**
 * Compared as sets: `larkMessaging` documents its ops in a different order than
 * the schema declares them, and reading order carries no meaning.
 */
export function assertOpEnumMatchesDocs(
  tool: { id: unknown; argsSchema: unknown; parameterDocs: string },
): void {
  assert.deepEqual(
    [...documentedOperations(tool.parameterDocs)].sort(),
    [...operationOptions(tool.argsSchema)].sort(),
    `${String(tool.id)} op drift between parameterDocs and schema`,
  );
}
