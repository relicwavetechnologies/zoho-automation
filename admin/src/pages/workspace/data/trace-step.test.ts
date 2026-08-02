/**
 * Run with: npm run test:unit  (node's own runner via tsx — no framework)
 *
 * Every payload below is a real one, copied from ExecutionEvent rows of run
 * d0e758b5 rather than invented, because the bug this module fixes was a wrong
 * assumption about the shape: the screen trusted `actorKey`, which is the
 * transport for every vendor call, and rendered five distinct actions as five
 * identical rows.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { actionOf, foldRepeats, humanizeId, readStep } from './trace-step'

describe('readStep', () => {
  it('names the tool inside a gateway dispatch, not the gateway', () => {
    const view = readStep('divo_gateway', {
      op: 'tools.invoke',
      payload: {
        toolId: 'semrush',
        skillId: '5c11a025-c696-d2bf-b6d0-f051a96b717c',
        args: { limit: 50, domain: 'hdfcergo.com', database: 'in', operation: 'organic_positions' },
      },
    })

    assert.equal(view.title, 'Semrush')
    assert.equal(view.operation, 'organic positions')
    assert.equal(view.detail, 'hdfcergo.com')
    assert.equal(view.viaGateway, true)
  })

  it('never captions a row with the transport verb', () => {
    // `tools.invoke` is the gateway's own op. Showing it is exactly how every
    // vendor call ended up with the same subtitle.
    const view = readStep('divo_gateway', {
      op: 'tools.invoke',
      payload: { toolId: 'webSearch', args: { limit: 6, query: 'IRDAI claim settlement ratio 2026' } },
    })

    assert.notEqual(view.operation, 'tools.invoke')
    assert.equal(view.operation, null)
    assert.equal(view.detail, 'IRDAI claim settlement ratio 2026')
  })

  it('surfaces a list argument as the subject', () => {
    // The keyword-gap step compares four competitors and is the most
    // interesting call in the run; keyed only on `targets`, it showed nothing.
    const view = readStep('divo_gateway', {
      op: 'tools.invoke',
      payload: {
        toolId: 'semrush',
        args: {
          database: 'in',
          operation: 'keyword_gap',
          targets: ['hdfcergo.com', 'icicilombard.com', 'bajajallianz.com', 'policybazaar.com'],
        },
      },
    })

    assert.equal(view.detail, 'hdfcergo.com, icicilombard.com, bajajallianz.com, policybazaar.com')
  })

  it('shortens a bare uuid instead of spending the row on it', () => {
    const view = readStep('divo_skill_view', { skillId: '5c11a025-c696-d2bf-b6d0-f051a96b717c' })

    assert.equal(view.title, 'Skill view')
    assert.equal(view.detail, '5c11a025…')
  })

  it('truncates a subject rather than letting it wrap the row', () => {
    const view = readStep('divo_gateway', {
      op: 'tools.invoke',
      payload: { toolId: 'webSearch', args: { query: 'x'.repeat(400) } },
    })

    assert.ok(view.detail!.length <= 96)
    assert.ok(view.detail!.endsWith('…'))
  })

  it('reads a payload that was persisted as a json string', () => {
    const view = readStep('divo_gateway', JSON.stringify({
      op: 'tools.invoke',
      payload: { toolId: 'semrush', args: { domain: 'hdfcergo.com', operation: 'domain_overview' } },
    }))

    assert.equal(view.title, 'Semrush')
    assert.equal(view.detail, 'hdfcergo.com')
  })

  it('degrades to the tool name rather than throwing on an unreadable payload', () => {
    // Persisted JSON spans a week of schema changes, and this runs inside a
    // render — a throw here blanks the whole trace.
    for (const bad of [null, undefined, 42, '{ not json', [], { payload: 'scalar' }]) {
      const view = readStep('divo_skill_view', bad)
      assert.equal(view.title, 'Skill view')
    }
  })
})

describe('actionOf', () => {
  it('marks a write as a write', () => {
    assert.equal(actionOf('googleGmail', 'send_message'), 'write')
    assert.equal(actionOf('larkTask', 'create'), 'write')
  })

  it('says nothing when it cannot tell', () => {
    // The old badge derived from the transport name, so every row claimed READ
    // — including the writes. A wrong safety label is worse than none.
    assert.equal(actionOf('divo_gateway', null), null)
    assert.equal(actionOf('someNewTool', 'frobnicate'), null)
  })
})

describe('foldRepeats', () => {
  it('collapses consecutive identical steps and counts them', () => {
    const folded = foldRepeats(['a', 'a', 'a', 'b', 'a'], (s) => s)

    assert.deepEqual(folded, [
      { step: 'a', count: 3 },
      { step: 'b', count: 1 },
      { step: 'a', count: 1 },
    ])
  })

  it('never reorders, so a poll-then-act sequence still reads in order', () => {
    const folded = foldRepeats(['read', 'read', 'write'], (s) => s)
    assert.deepEqual(folded.map((f) => f.step), ['read', 'write'])
  })
})

describe('humanizeId', () => {
  it('turns wire identifiers into words', () => {
    assert.equal(humanizeId('divo_skill_view'), 'Skill view')
    assert.equal(humanizeId('webSearch'), 'Web search')
    assert.equal(humanizeId('organic_positions'), 'Organic positions')
  })
})
