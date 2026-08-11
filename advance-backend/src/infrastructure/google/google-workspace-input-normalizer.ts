/** Narrow compatibility fixes at the pinned Google Workspace MCP boundary. */

const RANGE_ALIAS_TOOLS: ReadonlySet<string> = new Set([
  'read_sheet_values',
  'modify_sheet_values',
  'clear_sheet_values',
]);

export function normalizeGoogleWorkspaceInput(
  nativeTool: string,
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  let normalized = input;

  // The upstream MCP calls the universal Sheets `range` argument
  // `range_name`. An explicit provider spelling always wins.
  if (RANGE_ALIAS_TOOLS.has(nativeTool) && 'range' in normalized) {
    const { range, ...rest } = normalized;
    normalized = normalized['range_name'] !== undefined
      ? rest
      : { ...rest, range_name: range };
  }

  // Divo accepts ordinary Sheet scalars. The pinned MCP's Pydantic contract
  // accepts only strings, so adapt that wire quirk here once instead of making
  // every generated workflow rediscover it from an error.
  if (nativeTool === 'modify_sheet_values' && Array.isArray(normalized['values'])) {
    normalized = {
      ...normalized,
      values: normalized['values'].map(row => Array.isArray(row)
        ? row.map(cell => {
            if (cell === null) return '';
            if (typeof cell === 'number' || typeof cell === 'boolean') return String(cell);
            return cell;
          })
        : row),
    };
  }

  return normalized;
}
