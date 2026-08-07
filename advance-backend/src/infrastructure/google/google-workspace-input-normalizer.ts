/**
 * The upstream Google Workspace MCP names this argument `range_name`. Every
 * other Sheets surface a model has ever read — the Google API itself, gspread,
 * the Sheets docs — calls it `range`, so `range` is what gets sent, and the
 * provider rejects it with a pydantic `unexpected_keyword_argument`. The model
 * then has to guess the synonym from an error that does not name it.
 *
 * That happened twice in one Menhood run and cost two turns before the sheet
 * was read at all. Nothing is being inferred here: `range` carries no meaning
 * in the provider schema, so accepting it as a spelling of `range_name` cannot
 * change the semantics of a call that would otherwise have worked. An explicit
 * `range_name` always wins, and nothing else is touched.
 */

const RANGE_ALIAS_TOOLS: ReadonlySet<string> = new Set([
  'read_sheet_values',
  'modify_sheet_values',
  'clear_sheet_values',
]);

export function normalizeGoogleWorkspaceInput(
  nativeTool: string,
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (!RANGE_ALIAS_TOOLS.has(nativeTool)) return input;
  if (!('range' in input)) return input;
  if (input['range_name'] !== undefined) {
    const { range: _discarded, ...rest } = input;
    return rest;
  }
  const { range, ...rest } = input;
  return { ...rest, range_name: range };
}
