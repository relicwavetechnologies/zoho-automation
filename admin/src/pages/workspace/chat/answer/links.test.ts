import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { domainOf, isBareLink, sourcesIn, tintOf } from './links'

describe('the site a link points at', () => {
  it('reads the host and drops what is not part of it', () => {
    assert.equal(domainOf('https://www.reuters.com/world/india/story-123?utm=x'), 'reuters.com')
    assert.equal(domainOf('http://books.zoho.com:8080/inv/9'), 'books.zoho.com')
  })

  it('has no site for something that is not a web address', () => {
    for (const href of ['mailto:a@b.com', '/local/path', 'https://localhost/x', '']) {
      assert.equal(domainOf(href), null, href)
    }
  })
})

describe('whether a link has words worth keeping', () => {
  const href = 'https://reuters.com/world/india/story-123'

  it('treats an address, or its own domain, as saying nothing', () => {
    assert.equal(isBareLink(href, href), true)
    assert.equal(isBareLink('reuters.com', href), true)
    assert.equal(isBareLink('', href), true)
  })

  it('keeps prose the model actually wrote', () => {
    assert.equal(isBareLink('last quarter’s filing', href), false)
  })
})

describe('the sources under an answer', () => {
  const answer = [
    'Growth is [up 23%](https://reuters.com/a) this quarter.',
    'The [filing](https://reuters.com/b) and https://sec.gov/c agree.',
  ].join('\n')

  /* One entry per site. An answer citing six pages of the same filing has one
     source, and a strip that said "6" would be flattering itself. */
  it('names each site once, in the order it was cited', () => {
    assert.deepEqual(sourcesIn(answer).map(s => s.domain), ['reuters.com', 'sec.gov'])
  })

  it('keeps the first address it saw for a site', () => {
    assert.equal(sourcesIn(answer)[0]!.href, 'https://reuters.com/a')
  })

  it('has nothing to show for an answer that cited nothing', () => {
    assert.deepEqual(sourcesIn('Pistachio is your fastest-growing flavor.'), [])
  })
})

/* The tile colour is identity, not measurement — but it has to be the same
   colour for the same site every time, or the strip becomes a lucky dip. */
describe('the tint on a site with no mark of its own', () => {
  it('is stable per domain', () => {
    assert.equal(tintOf('reuters.com'), tintOf('reuters.com'))
    assert.notEqual(tintOf('reuters.com'), tintOf('sec.gov'))
  })
})
