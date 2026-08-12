import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { rehypeWords, splitWords, wordIndexOf } from './reveal'

/* A stand-in for the tree react-markdown hands a rehype plugin. */
const el = (tagName: string, ...children: unknown[]) =>
  ({ type: 'element', tagName, children }) as never
const text = (value: string) => ({ type: 'text', value }) as never

type Node = { type?: string; tagName?: string; value?: string; children?: Node[]; properties?: Record<string, unknown> }

/** Every word element in the tree, in reading order. */
function words(tree: Node): { index: number | null; text: string }[] {
  const out: { index: number | null; text: string }[] = []
  const walk = (node: Node) => {
    for (const child of node.children ?? []) {
      const index = wordIndexOf(child.properties)
      if (index !== null) out.push({ index, text: String(child.children?.[0]?.value ?? '') })
      else walk(child)
    }
  }
  walk(tree)
  return out
}

describe('numbering an answer word by word', () => {
  it('gives each word its own element, numbered in reading order', () => {
    const tree = { type: 'root', children: [el('p', text('Pistachio is your fastest-growing flavor'))] } as Node
    rehypeWords()(tree as never)

    assert.deepEqual(words(tree).map(w => w.text), [
      'Pistachio', 'is', 'your', 'fastest-growing', 'flavor',
    ])
    assert.deepEqual(words(tree).map(w => w.index), [0, 1, 2, 3, 4])
  })

  /* Numbering runs across the whole document, not per block — the cursor is one
     number, so a word in the second paragraph has to sort after every word in
     the first. */
  it('keeps numbering across blocks and into nested markup', () => {
    const tree = {
      type: 'root',
      children: [
        el('p', text('sales are '), el('strong', text('up 23%')), text(' today')),
        el('p', text('margins beat vanilla')),
      ],
    } as Node
    rehypeWords()(tree as never)

    assert.deepEqual(words(tree).map(w => w.text), [
      'sales', 'are', 'up', '23%', 'today', 'margins', 'beat', 'vanilla',
    ])
    assert.deepEqual(words(tree).map(w => w.index), [0, 1, 2, 3, 4, 5, 6, 7])
  })

  /* Nobody reads code the way they read prose, and revealing a shell command a
     token at a time is how a reader ends up copying half a line. */
  it('treats a code block as a single word', () => {
    const tree = {
      type: 'root',
      children: [el('pre', el('code', text('rm -rf ./build && npm run build')))],
    } as Node
    rehypeWords()(tree as never)

    const found = words(tree)
    assert.equal(found.length, 1)
    assert.equal(found[0]!.text, 'rm -rf ./build && npm run build')
  })

  /* The whitespace has to survive as its own node. Attached to the word after
     it, the last visible word would sit jammed against the caret; dropped
     entirely, the answer would reflow every word together as it finished. */
  it('keeps the spacing between words', () => {
    const tree = { type: 'root', children: [el('p', text('one two'))] } as Node
    rehypeWords()(tree as never)
    const kinds = (tree.children![0]!.children ?? []).map(c => c.type === 'text' ? c.value : 'word')
    assert.deepEqual(kinds, ['word', ' ', 'word'])
  })

  it('leaves a document with no text alone', () => {
    const tree = { type: 'root', children: [el('hr')] } as Node
    rehypeWords()(tree as never)
    assert.deepEqual(words(tree), [])
  })
})

describe('splitting a run of text', () => {
  it('separates words from the space between them', () => {
    assert.deepEqual(splitWords('up 23%'), [
      { word: 'up', text: 'up' },
      { word: null, text: ' ' },
      { word: '23%', text: '23%' },
    ])
  })

  it('keeps a newline as spacing rather than as a word', () => {
    assert.deepEqual(splitWords('a\n\nb').filter(p => p.word === null), [
      { word: null, text: '\n\n' },
    ])
  })

  it('has nothing to split in an empty string', () => {
    assert.deepEqual(splitWords(''), [])
  })
})

/* The count the cursor runs to is computed separately from the numbering the
   parser does. If the two ever disagreed about what a word is, the last word
   would never reveal and the caret would sit there forever. */
describe('the cursor and the numbering agree on what a word is', () => {
  const countedByRenderer = (value: string) =>
    value.split(/(\s+)/).filter(part => part.trim().length > 0).length

  for (const sample of [
    'Pistachio is your fastest-growing flavor',
    'sales are up 23%  today',
    'one\ntwo\n\nthree',
    '  leading and trailing  ',
    'single',
  ]) {
    it(`agrees on ${JSON.stringify(sample)}`, () => {
      const tree = { type: 'root', children: [el('p', text(sample))] } as Node
      rehypeWords()(tree as never)
      assert.equal(words(tree).length, countedByRenderer(sample))
    })
  }
})
