import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TAIL_ATTR, rehypeWords, splitWords } from './words'

type Node = {
  type?: string
  tagName?: string
  value?: string
  children?: Node[]
  properties?: Record<string, unknown>
}

const text = (value: string): Node => ({ type: 'text', value })
const el = (tagName: string, ...children: Node[]): Node => ({ type: 'element', tagName, children })
const run = (tree: Node): Node => { rehypeWords()(tree); return tree }

/** The document flattened to what it will actually put on the page. */
const shape = (node: Node): string => {
  if (node.type === 'text') return JSON.stringify(node.value)
  if (node.tagName === 'span' && node.properties?.['className'] === 'bui-word') {
    const tail = node.properties[TAIL_ATTR] ? '<' : ''
    return `word(${(node.children ?? []).map(c => c.value).join('')})${tail}`
  }
  return `${node.tagName}[${(node.children ?? []).map(shape).join(' ')}]`
}

describe('splitting a run of text', () => {
  /* The gaps stay plain text. Made into elements, the browser loses the place
     it is allowed to break the line and a long answer stops wrapping. */
  it('keeps the whitespace between words, as text', () => {
    assert.deepEqual(splitWords('two  words\n'), [
      { word: 'two', text: 'two' },
      { word: null, text: '  ' },
      { word: 'words', text: 'words' },
      { word: null, text: '\n' },
    ])
  })

  it('has nothing to split in nothing', () => {
    assert.deepEqual(splitWords(''), [])
  })
})

describe('giving each word its own element', () => {
  it('wraps the words and leaves the gaps alone', () => {
    const tree = run({ type: 'root', children: [el('p', text('Three are overdue'))] })
    assert.equal(shape(tree.children![0]!), 'p[word(Three) " " word(are) " " word(overdue)<]')
  })

  /* The whole reason the words are elements: React mounts one for a word that
     has just arrived, and `.bui-word` animates on mount. A word already on the
     page keeps its element and does not animate again. */
  it('reuses nothing and invents nothing — a word is a word', () => {
    const grown = run({ type: 'root', children: [el('p', text('Three are overdue now'))] })
    assert.equal(
      shape(grown.children![0]!),
      'p[word(Three) " " word(are) " " word(overdue) " " word(now)<]',
    )
  })

  it('reaches words nested inside emphasis and links', () => {
    const tree = run({
      type: 'root',
      children: [el('p', text('Ask '), el('strong', text('Acme Corp')), text(' first'))],
    })
    assert.equal(
      shape(tree.children![0]!),
      'p[word(Ask) " " strong[word(Acme) " " word(Corp)] " " word(first)<]',
    )
  })

  /* Nobody reads a command the way they read prose, and a reader trying to copy
     one that is still assembling itself gets half a line. */
  it('treats code as one word, however many spaces are in it', () => {
    const tree = run({ type: 'root', children: [el('code', text('pnpm dev --port 5173'))] })
    assert.equal(shape(tree.children![0]!), 'code[word(pnpm dev --port 5173)<]')
  })

  /* A table is drawn from its own data rather than from the words inside it, so
     there is nowhere to put a per-word element — and one that assembled itself a
     cell at a time would be unreadable. */
  it('leaves a table and a fenced block untouched', () => {
    for (const tag of ['table', 'pre']) {
      const tree = run({ type: 'root', children: [el(tag, text('Customer Amount'))] })
      assert.equal(shape(tree.children![0]!), `${tag}["Customer Amount"]`, tag)
    }
  })
})

describe('where the caret sits', () => {
  /* On the last word, so it lands where the text stops rather than alone on a
     line under whatever block happened to end the answer. */
  it('marks the last word in the document, wherever it is nested', () => {
    const tree = run({
      type: 'root',
      children: [el('p', text('First line')), el('ul', el('li', text('last item')))],
    })
    assert.equal(shape(tree.children![1]!), 'ul[li[word(last) " " word(item)<]]')
    assert.equal(shape(tree.children![0]!), 'p[word(First) " " word(line)]')
  })

  it('marks exactly one word, and none at all in a document with no words', () => {
    const marked = (node: Node): number =>
      (node.properties?.[TAIL_ATTR] ? 1 : 0)
      + (node.children ?? []).reduce((total, child) => total + marked(child), 0)

    assert.equal(marked(run({ type: 'root', children: [el('p', text('a b c'))] })), 1)
    assert.equal(marked(run({ type: 'root', children: [el('table', text('x'))] })), 0)
    assert.equal(marked(run({ type: 'root', children: [] })), 0)
  })
})
