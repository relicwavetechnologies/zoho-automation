import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  domainOf, isBareLink, isNavigable, sourcesIn, targetOf, tintOf,
} from './links'

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

  /* An answer that shows you a command has not consulted the host in it. The
     renderer draws a fenced block as text; the scanner used to read it as
     prose, and the two disagreed by one chip claiming a source that was never
     consulted. */
  it('does not cite a host that only appears inside a fenced block', () => {
    assert.deepEqual(sourcesIn([
      'Charge a card like this:',
      '```bash',
      'curl https://api.stripe.com/v1/charges -u sk_test:',
      '```',
    ].join('\n')), [])
  })

  it('does not cite a host inside a code span', () => {
    assert.deepEqual(sourcesIn('Point it at `https://api.stripe.com` and retry.'), [])
  })

  /* Most of a streaming code block's life is spent unclosed. Reading the rest
     of the answer as prose the moment a fence opens would make chips appear and
     vanish as the reply arrived. */
  it('treats an unclosed fence as code all the way to the end', () => {
    assert.deepEqual(sourcesIn('Run:\n```bash\ncurl https://api.stripe.com/v1'), [])
  })

  it('still reads the prose around a block', () => {
    assert.deepEqual(sourcesIn([
      'Per [Reuters](https://reuters.com/a):',
      '```bash',
      'curl https://api.stripe.com/v1/charges',
      '```',
      'and https://sec.gov/c agrees.',
    ].join('\n')).map(s => s.domain), ['reuters.com', 'sec.gov'])
  })

  /* A fence may hold unbalanced backticks. Reading spans first would pair one
     of them with a backtick further down the answer and blank the prose
     between them, losing citations that were never in code at all. */
  it('is not confused by a stray backtick inside a block', () => {
    assert.deepEqual(sourcesIn([
      '```sh',
      "echo `date` https://api.stripe.com",
      '```',
      'See [Reuters](https://reuters.com/a).',
    ].join('\n')).map(s => s.domain), ['reuters.com'])
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

describe('what a link points at', () => {
  it('reads a web address as a site', () => {
    assert.deepEqual(
      targetOf('https://books.zoho.com/app/inv/9'),
      { kind: 'site', domain: 'books.zoho.com' },
    )
  })

  it('reads a workspace path as a file, whatever shape it arrives in', () => {
    // The exact case that rendered as dead text: a filename the run wrote with
    // no scheme and no leading slash.
    for (const href of [
      'divo-test2-hsbc-bank-charges-qa.pdf',
      './out/divo-test2-hsbc-bank-charges-qa.pdf',
      '/workspace/.divo/inbox/divo-test2-hsbc-bank-charges-qa.pdf',
      'file:///workspace/divo-test2-hsbc-bank-charges-qa.pdf',
    ]) {
      assert.deepEqual(
        targetOf(href),
        { kind: 'file', name: 'divo-test2-hsbc-bank-charges-qa.pdf', family: 'doc' },
        href,
      )
    }
  })

  it('tells the families apart, because that is what the glyph is for', () => {
    const family = (href: string) => {
      const target = targetOf(href)
      return target.kind === 'file' ? target.family : null
    }
    assert.equal(family('q3.xlsx'), 'sheet')
    assert.equal(family('deck.pptx'), 'slide')
    assert.equal(family('shot.png'), 'image')
    assert.equal(family('bundle.zip'), 'archive')
    assert.equal(family('run.py'), 'code')
    // Unknown extension is still a file — it just has nothing specific to say.
    assert.equal(family('notes.xyz'), 'file')
  })

  it('reads an address as mail', () => {
    assert.deepEqual(
      targetOf('mailto:rahul@emiactech.com?subject=hi'),
      { kind: 'mail', address: 'rahul@emiactech.com' },
    )
  })

  it('claims nothing about an anchor or an undrawable scheme', () => {
    for (const href of ['#cite-1', '#section', 'tel:+911234567890', 'data:text/plain,hi', '']) {
      assert.equal(targetOf(href).kind, 'plain', href)
    }
  })

  it('does not turn a bare word into a file', () => {
    // "approve" and "Test 2" appear as link text constantly. Treating any of
    // them as a path would put a document glyph in the middle of a sentence.
    for (const href of ['approve', 'some words', 'Test 2']) {
      assert.equal(targetOf(href).kind, 'plain', href)
    }
  })
})

describe('whether the browser can follow a link', () => {
  it('follows the web and the mail client', () => {
    assert.equal(isNavigable('https://zoho.com'), true)
    assert.equal(isNavigable('mailto:a@b.com'), true)
  })

  it('will not pretend a container path is reachable', () => {
    // The file lives in the run's container, not on this origin, so navigating
    // there produces a 404 in place of an answer.
    assert.equal(isNavigable('/workspace/.divo/inbox/q3.pdf'), false)
    assert.equal(isNavigable('q3.pdf'), false)
  })
})
