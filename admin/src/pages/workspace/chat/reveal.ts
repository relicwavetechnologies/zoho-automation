/**
 * The answer, arriving a word at a time.
 *
 * Words resolve out of blur as model deltas reach the browser, and a caret sits
 * after the last fragment received. Ported from the Beautiful UI
 * `StreamingText` pattern, with one substitution that decides the whole
 * implementation.
 *
 * That component reveals a `TOKENS` array of plain strings. Ours is markdown —
 * tables, lists, headings, fenced code — and the obvious approach, rendering
 * markdown of a growing prefix of the source, fails on contact: a half-written
 * `**bold` may briefly be incomplete and a half-written table is not a table
 * yet. The live renderer reparses only when a real snapshot arrives, then this
 * plugin indexes the words inside the parsed tree so the new tail can animate
 * without a client-side typing clock.
 *
 * Fenced code is one word. Revealing a shell command a token at a time is how
 * you get a reader trying to copy half a line, and nobody reads code the way
 * they read prose.
 */

import { createContext, useContext } from 'react'

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
          // Inline code is revealed whole: one index for the whole span.
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
          if (WHOLE_BLOCKS.has(child.tagName ?? '')) {
            child.properties = { ...child.properties, [WORD_ATTR]: String(index) }
            index += Math.max(1, countWords(child))
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
  }
}

/**
 * Blocks that arrive whole, carrying their index on themselves.
 *
 * A table is drawn from its own data rather than from the words inside it, so
 * there is nowhere to put a per-word index — and a table that assembled itself
 * a cell at a time would be unreadable anyway. It takes the index the cursor
 * has reached and then consumes as many as it holds words, so everything after
 * it still arrives at the pace it reads at rather than racing ahead.
 */
const WHOLE_BLOCKS = new Set(['table', 'pre'])

function countWords(node: Node): number {
  if (node.type === 'text') {
    return splitWords(node.value ?? '').filter(part => part.word !== null).length
  }
  let total = 0
  for (const child of node.children ?? []) total += countWords(child)
  return total
}

/** How far the reveal has got. Read by the words, and by the whole blocks. */
export const RevealCursor = createContext({
  shown: Number.POSITIVE_INFINITY,
  streaming: false,
})

/** Whether a numbered thing's turn has come. Unnumbered things are simply there. */
export function useRevealedIndex(index: number | null): boolean {
  const { shown } = useContext(RevealCursor)
  return index === null || shown > index
}

/** Whether a whole block's turn has come. Unnumbered blocks are simply there. */
export function useRevealed(properties: Record<string, unknown> | undefined): boolean {
  return useRevealedIndex(wordIndexOf(properties))
}

/**
 * The index of the first word inside something.
 *
 * A link drawn as a chip replaces the words it was made of, so it has to take
 * their place in the reveal too — otherwise a paragraph that is nothing but a
 * link contains no numbered word at all, and the rule that hides blocks nobody
 * has reached yet would hide it forever.
 */
export function firstWordIn(node: Node | undefined): number | null {
  if (!node) return null
  const own = wordIndexOf(node.properties)
  if (own !== null) return own
  for (const child of node.children ?? []) {
    const found = firstWordIn(child)
    if (found !== null) return found
  }
  return null
}

/** The index a rendered element carries, or null if it is not a word. */
export function wordIndexOf(properties: Record<string, unknown> | undefined): number | null {
  const raw = properties?.[WORD_ATTR] ?? properties?.['dataWord']
  if (raw === undefined || raw === null) return null
  const index = Number(raw)
  return Number.isInteger(index) && index >= 0 ? index : null
}
