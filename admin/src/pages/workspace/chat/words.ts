/**
 * The answer, arriving a word at a time.
 *
 * Words resolve out of blur as model deltas reach the browser, and a caret sits
 * after the last one received. Ported from the Beautiful UI `StreamingText`
 * pattern, with one substitution that decides the whole implementation.
 *
 * That component reveals a `TOKENS` array of plain strings. Ours is markdown —
 * tables, lists, headings, fenced code — and rendering a growing prefix of the
 * source fails on contact: a half-written `**bold` may briefly be incomplete and
 * a half-written table is not a table yet. So the live renderer reparses when a
 * snapshot arrives, and this gives every word in the parsed tree its own
 * element. A word that has just arrived is an element React has just mounted,
 * and `.bui-word` animates on mount — the arrival animates itself.
 *
 * ── What is deliberately not here ────────────────────────
 * This module used to also carry a *cursor*: a count of how many words had been
 * received, in a context, gating each numbered word on whether its turn had
 * come. It could not work, and the reason is worth writing down so it is not
 * rebuilt. The tree being rendered is parsed from the prefix that arrived — so
 * every word in it has already been received, by construction, and there is
 * never anything for a cursor to hold back. Its only possible effect was to
 * hide text that *had* arrived, which is what it did: the count came from
 * splitting the markdown source on whitespace while the numbering came from
 * walking the parsed tree, and the two disagree. On a link-heavy answer the tree
 * ran up to four words ahead, so the tail of the answer vanished and reappeared
 * delta by delta. On answers with a table or a fenced block the count ran so far
 * ahead that the caret's condition was never once true, and the caret had not
 * rendered at all.
 *
 * Fenced code is one word. Revealing a shell command a token at a time is how
 * you get a reader trying to copy half a line, and nobody reads code the way
 * they read prose.
 */

/** Marks the last word in the document, which is where the caret rides. */
export const TAIL_ATTR = 'data-tail'

type Node = {
  type?: string
  tagName?: string
  value?: string
  children?: Node[]
  properties?: Record<string, unknown>
}

function wordNode(value: string): Node {
  return {
    type: 'element',
    tagName: 'span',
    properties: { className: 'bui-word' },
    children: [{ type: 'text', value }],
  }
}

/**
 * Split a run of text into words and the whitespace between them.
 *
 * The whitespace is kept as its own entry rather than attached to a word: it
 * has to stay in the document as plain text, or every gap between words becomes
 * an element and the browser loses its chance to break the line there.
 */
export function splitWords(value: string): { word: string | null; text: string }[] {
  return value
    .split(/(\s+)/)
    .filter(part => part.length > 0)
    .map(part => (/^\s+$/.test(part) ? { word: null, text: part } : { word: part, text: part }))
}

/**
 * Give every word in a parsed document its own element.
 *
 * A rehype plugin, so it runs after the markdown is already a tree and cannot
 * change what the document means.
 */
export function rehypeWords() {
  return (tree: Node): void => {
    let tail: Node | undefined

    const walk = (node: Node, verbatim: boolean): void => {
      if (!node.children) return
      const next: Node[] = []

      for (const child of node.children) {
        if (child.type === 'text' && typeof child.value === 'string') {
          // Inline code is one word: it animates in whole.
          if (verbatim) {
            if (child.value) next.push(tail = wordNode(child.value))
            continue
          }
          for (const part of splitWords(child.value)) {
            if (part.word === null) next.push({ type: 'text', value: part.text })
            else next.push(tail = wordNode(part.word))
          }
          continue
        }
        if (child.type === 'element') {
          // A table is drawn from its own data rather than from the words
          // inside it, so there is nowhere to put a per-word element — and one
          // that assembled itself a cell at a time would be unreadable anyway.
          if (WHOLE_BLOCKS.has(child.tagName ?? '')) {
            next.push(child)
            continue
          }
          walk(child, verbatim || child.tagName === 'code')
        }
        next.push(child)
      }

      node.children = next
    }

    walk(tree, false)
    // Marked after the walk, because which word is last is only known once
    // there are no more. The caret rides inside it rather than after the
    // document, so it sits where the text actually stops instead of alone on a
    // line under the last block.
    if (tail) tail.properties = { ...tail.properties, [TAIL_ATTR]: 'true' }
  }
}

/** Blocks that arrive whole, with no word elements inside them. */
const WHOLE_BLOCKS = new Set(['table', 'pre'])
