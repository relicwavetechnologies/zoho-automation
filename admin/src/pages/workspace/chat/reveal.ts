/**
 * The answer, arriving a word at a time.
 *
 * Words resolve out of blur, one after another, and a caret sits after the last
 * one until the text runs out. Ported from the Beautiful UI `StreamingText`
 * pattern, with one substitution that decides the whole implementation.
 *
 * That component reveals a `TOKENS` array of plain strings. Ours is markdown —
 * tables, lists, headings, fenced code — and the obvious approach, rendering
 * markdown of a growing prefix of the source, fails on contact: a half-written
 * `**bold` prints its asterisks, a half-written table prints a wall of pipes,
 * and every tick re-parses the document into a different shape. So the document
 * is parsed ONCE, in full, and the reveal happens inside the parsed tree: every
 * word becomes its own element with an index, and rendering stops at a cursor.
 * The structure is always valid markdown because it is always the whole
 * document; only how much of it is drawn changes.
 *
 * Fenced code is one word. Revealing a shell command a token at a time is how
 * you get a reader trying to copy half a line, and nobody reads code the way
 * they read prose.
 */

/** A word every 55ms, from the pattern this is ported from. */
export const WORD_MS = 55

/** Where a word index is carried between the parser and the renderer. */
export const WORD_ATTR = 'data-word'

type Node = {
  type?: string
  tagName?: string
  value?: string
  children?: Node[]
  properties?: Record<string, unknown>
}

function wordNode(value: string, index: number): Node {
  return {
    type: 'element',
    tagName: 'span',
    properties: { [WORD_ATTR]: String(index) },
    children: [{ type: 'text', value }],
  }
}

/**
 * Split a run of text into words and the whitespace between them.
 *
 * The whitespace is kept as its own entry rather than attached to a word: it
 * has to stay in the document even when the word after it has not been revealed
 * yet, or the last visible word ends up jammed against the caret.
 */
export function splitWords(value: string): { word: string | null; text: string }[] {
  return value
    .split(/(\s+)/)
    .filter(part => part.length > 0)
    .map(part => (/^\s+$/.test(part) ? { word: null, text: part } : { word: part, text: part }))
}

/**
 * Give every word in a parsed document its own element, numbered in reading
 * order. A rehype plugin, so it runs after the markdown is already a tree and
 * cannot change what the document means.
 */
export function rehypeWords() {
  return (tree: Node): void => {
    let index = 0

    const walk = (node: Node, verbatim: boolean): void => {
      if (!node.children) return
      const next: Node[] = []

      for (const child of node.children) {
        if (child.type === 'text' && typeof child.value === 'string') {
          // Code is revealed whole: one index for the entire block.
          if (verbatim) {
            if (child.value) next.push(wordNode(child.value, index++))
            continue
          }
          for (const part of splitWords(child.value)) {
            next.push(part.word === null
              ? { type: 'text', value: part.text }
              : wordNode(part.word, index++))
          }
          continue
        }
        if (child.type === 'element') {
          const tag = child.tagName
          walk(child, verbatim || tag === 'code' || tag === 'pre')
        }
        next.push(child)
      }

      node.children = next
    }

    walk(tree, false)
  }
}

/** The index a rendered element carries, or null if it is not a word. */
export function wordIndexOf(properties: Record<string, unknown> | undefined): number | null {
  const raw = properties?.[WORD_ATTR] ?? properties?.['dataWord']
  if (raw === undefined || raw === null) return null
  const index = Number(raw)
  return Number.isInteger(index) && index >= 0 ? index : null
}
