export function normalizeExportCell(value: unknown): unknown {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return typeof value === 'string' && /^[=+\-@]/.test(value) ? `'${value}` : value;
  }
  return JSON.stringify(value);
}
