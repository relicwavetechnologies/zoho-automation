/**
 * The opening of a document, as a person would read it.
 *
 * This exists because "the first 400 characters" is not the opening of a
 * document — it is the first 400 characters of a file. Every HTML artifact this
 * runtime writes opens with a stylesheet: measured on real rows, the first word
 * of actual text begins between 3.7 and 4.4 thousand characters in. A list that
 * cut from the front would have shown four cards of CSS.
 *
 * So the cut happens *after* the markup is gone, and it happens here rather
 * than in the reader. What a document says is the server's answer; how a card
 * draws it is the reader's. A browser that had to un-HTML a document before it
 * could name it would also be a browser holding the document, which is the one
 * thing a summary exists not to send.
 *
 * Deliberately not a renderer. At list size the difference between a heading
 * and a paragraph is a line of text either way, and the only thing markup would
 * contribute is itself.
 */

/** How much of a document a summary carries. Enough to recognise, never to read. */
export const ARTIFACT_PREVIEW_CHARS = 400;

/**
 * How much of the stored body is read to find that much text.
 *
 * A bound, not a budget: it keeps a list of fifty from pulling fifty whole
 * documents out of Postgres, while still clearing the widest stylesheet we have
 * measured with room to spare. A document whose text begins after this is one
 * whose preview is empty — which is the honest answer for a file that is
 * nothing but markup for eight thousand characters.
 */
export const ARTIFACT_PREVIEW_SOURCE_CHARS = 8_192;

/** Tags that end a line when they close. Everything else runs on. */
const BLOCK_END = /<br\s*\/?>|<\/(p|div|h[1-6]|li|tr|section|article|blockquote|pre)>/gi;

/** Markup that is punctuation at full size and noise at list size. */
function flattenLine(line: string): string {
  return line
    // Images first: `![alt](src)` would otherwise leave its alt text behind as
    // a sentence the document never had.
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s{0,3}>\s?/, '')
    .replace(/^\s{0,3}([-*+]|\d+[.)])\s+/, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A line that is only structure — a rule, a fence, a table's divider. */
function isStructure(line: string): boolean {
  return /^\s*(```|~~~|([-*_=]\s*){3,}|\|[\s|:-]*\|)\s*$/.test(line);
}

/**
 * The named entities a generated document actually uses.
 *
 * Not a table of all 2,231 of them. What these pages contain is arrows and
 * dashes in figure captions — `&#9660; &minus;9.1%` reached a card as those
 * eleven characters, which is worse than the markup we were stripping to
 * avoid. Numeric references are handled generically below, so this list only
 * has to cover the names, and an unknown name is left exactly as written
 * rather than guessed at.
 */
const NAMED: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  minus: '−', ndash: '–', mdash: '—', hellip: '…', times: '×',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', deg: '°', euro: '€', pound: '£',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{2,8});/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      // Anything outside Unicode, and the surrogate range, is left as written:
      // `String.fromCodePoint` throws on both, and a preview is not worth an
      // exception thrown from a list query.
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      if (code >= 0xd800 && code <= 0xdfff) return whole;
      return String.fromCodePoint(code);
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });
}

function htmlToText(source: string): string {
  return decodeEntities(
    source
      // Script and style go whole, bodies included — they are not the
      // document's text, and dropping the tags alone would leave the code where
      // the prose should be. `$` closes an element the read was cut in the
      // middle of.
      .replace(/<(script|style)\b[^>]*>[\s\S]*?(<\/\1>|$)/gi, '')
      .replace(BLOCK_END, '\n')
      .replace(/<[^>]*>/g, ''),
  );
}

/**
 * A document's opening lines, plain, bounded.
 *
 * Lines are kept as lines. A card draws them as a document — a first line and
 * the ones under it — and joining them into a paragraph here would throw away
 * the one thing that makes a thumbnail recognisable at a glance.
 */
export function previewOf(body: string, mime: string, max = ARTIFACT_PREVIEW_CHARS): string {
  const source = body.slice(0, ARTIFACT_PREVIEW_SOURCE_CHARS);
  const text = mime === 'text/html' ? htmlToText(source) : source;

  const lines: string[] = [];
  let spent = 0;
  for (const raw of text.split('\n')) {
    if (isStructure(raw)) continue;
    const line = flattenLine(raw);
    if (!line) continue;
    lines.push(line.slice(0, max - spent));
    spent += line.length + 1;
    if (spent >= max) break;
  }
  return lines.join('\n');
}
