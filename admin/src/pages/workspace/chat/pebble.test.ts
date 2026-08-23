import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { tintFor, tintForDomain, tintForLink } from './pebble'

describe('tintFor', () => {
  test('gives an app its own colour', () => {
    assert.equal(tintFor('gmail'), '#EA4335')
    assert.equal(tintFor('lark'), '#4C6FFB')
  })

  test('has none for an app with no vendor colour', () => {
    assert.equal(tintFor(null), null)
    assert.equal(tintFor('web' as never), null)
  })

  test('keeps Drive and Sheets apart, which is why Drive is not green', () => {
    assert.notEqual(tintFor('drive'), tintFor('sheets'))
  })
})

describe('tintForDomain', () => {
  test('gives the same site the same colour every time', () => {
    assert.equal(tintForDomain('example.com'), tintForDomain('example.com'))
  })

  test('gives different sites different colours', () => {
    assert.notEqual(tintForDomain('example.com'), tintForDomain('another.com'))
  })

  test('stays inside the hue range, so the colour is always a colour', () => {
    for (const domain of ['a', 'zzzzzzzzzzzz.co.uk', '', 'x'.repeat(400)]) {
      const match = /^hsl\((\d+) 62% 52%\)$/.exec(tintForDomain(domain))
      assert.ok(match, `${domain} produced ${tintForDomain(domain)}`)
      const hue = Number(match[1])
      assert.ok(hue >= 0 && hue < 360, `hue ${hue} out of range`)
    }
  })

  test('never returns a near-grey, because that reads as a failed load', () => {
    /* Saturation and lightness are fixed for exactly this reason. If someone
       hashes them later, this is the test that should stop them. */
    assert.ok(tintForDomain('anything.com').includes('62% 52%'))
  })
})

describe('tintForLink', () => {
  test('a known vendor wins over the domain hash', () => {
    /* Otherwise a Google Sheet in the transcript would be a different colour
       from the Sheets mention in the composer. */
    assert.equal(tintForLink('sheets', 'docs.google.com'), tintFor('sheets'))
  })

  test('an unknown site falls back to its stable hue', () => {
    assert.equal(tintForLink(null, 'example.com'), tintForDomain('example.com'))
  })

  test('a key with no colour of its own still gets one from the domain', () => {
    assert.equal(tintForLink('web' as never, 'example.com'), tintForDomain('example.com'))
  })
})
