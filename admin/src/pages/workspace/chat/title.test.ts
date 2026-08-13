import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cleanTitle } from './title'

/*
 * Everything here is something a model has actually returned when asked for a
 * short title. The output goes straight into the rail and the browser tab, so
 * this is the only thing standing between a one-line request and a row of
 * markdown, a stray quote, or three sentences of reasoning.
 */
describe('making a model\'s answer usable as a name', () => {
  it('keeps a plain answer as it stands', () => {
    assert.equal(cleanTitle('Recent Manode orders'), 'Recent Manode orders')
  })

  it('strips the dressing a model adds to a one-line answer', () => {
    assert.equal(cleanTitle('  "Recent Manode orders."  '), 'Recent Manode orders')
    assert.equal(cleanTitle('**Recent Manode orders**'), 'Recent Manode orders')
    assert.equal(cleanTitle('Recent\n  Manode\torders'), 'Recent Manode orders')
  })

  /* A reasoning model answers inside its own tags. Printing the reasoning as
     the name is the loudest possible way to leak that a model was involved. */
  it('takes the answer out of a reasoning block, not the reasoning', () => {
    assert.equal(
      cleanTitle('<think>The user wants orders. Maybe "orders"?</think>Recent Manode orders'),
      'Recent Manode orders',
    )
    // Only a closing tag: the answer is whatever follows it.
    assert.equal(cleanTitle('weighing options</thinking> Recent Manode orders'), 'Recent Manode orders')
  })

  /* An unclosed opener means the budget ran out mid-thought and there is no
     answer in there at all. Better no name than the model's notes. */
  it('gives up on output that never left its own reasoning', () => {
    assert.equal(cleanTitle('<think>Let me consider what they meant'), null)
  })

  it('refuses anything that is not a name', () => {
    assert.equal(cleanTitle(''), null)
    assert.equal(cleanTitle('   '), null)
    assert.equal(cleanTitle('"."'), null)
    // One character is a typo, not a title.
    assert.equal(cleanTitle('A'), null)
  })

  /* The bar and the rail row are one line. A model that ignores "2 to 8 words"
     and writes a sentence must not be able to set the width of either. */
  it('will not let a sentence become a title', () => {
    const long = 'Check the recent orders from Manode and reconcile them against the bank statement please'
    const title = cleanTitle(long)!
    assert.equal(title.split(' ').length, 10)
    assert.ok(long.startsWith(title), title)
  })

  /* A title is data the model wrote from data the user wrote, so the prompt is
     reachable from here. Only reasoning blocks lose their contents; every other
     tag loses just its brackets, and what was inside stays as ordinary words.
     That is the guarantee worth having — not that the text is gone, but that
     nothing survives which could act. The worst an injected instruction can do
     is name the chat after itself. */
  it('reduces an injected instruction to inert words', () => {
    assert.equal(
      cleanTitle('Ignore previous instructions. <script>alert(1)</script> DROP TABLE users;'),
      'Ignore previous instructions alert1 DROP TABLE users',
    )
    // No angle brackets, quotes, semicolons or parentheses survive anywhere.
    assert.match(cleanTitle('<img src=x onerror="go()">Report')!, /^[\p{L}\p{N} ]+$/u)
  })

  // Names and products are the useful part of a title, in any script.
  it('keeps letters that are not ascii', () => {
    assert.equal(cleanTitle('飞书 审批 待办'), '飞书 审批 待办')
    assert.equal(cleanTitle('Résumé für Manode'), 'Résumé für Manode')
  })
})
