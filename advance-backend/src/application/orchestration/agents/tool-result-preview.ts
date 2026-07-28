/** Extracts a compact one-line preview from a tool result for the status timeline. */

const DECORATOR_RE = /[*_~`>#]+/g;
/** Hyphens are only markdown at the start of a line — elsewhere they carry meaning. */
const RULE_RE        = /^\s*-{3,}\s*$/gm;
const LIST_MARKER_RE = /^\s*[-–—]\s+/gm;
const LINK_RE      = /\[(.*?)\]\((.*?)\)/g;
const TAG_RE       = /<[^>]+>/g;
const WS_RE        = /\s+/g;
const PREVIEW_MAX  = 80;

function strip(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(LINK_RE, '$1')
    .replace(TAG_RE, ' ')
    .replace(RULE_RE, ' ')
    .replace(LIST_MARKER_RE, ' ')
    .replace(DECORATOR_RE, ' ')
    .replace(WS_RE, ' ')
    .trim();
}

export function previewToolResult(toolName: string, output: unknown): string {
  const raw = typeof output === 'string' ? output : JSON.stringify(output ?? '');
  const stripped = strip(raw);
  if (!stripped) return '';
  return stripped.length <= PREVIEW_MAX ? stripped : `${stripped.slice(0, PREVIEW_MAX - 1)}…`;
}
