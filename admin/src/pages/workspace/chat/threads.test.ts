import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  startedThreads, threadRenamed, threadSettled, threadStarted, withStartedThreads,
  type StartedThread, type ThreadSummary,
} from './threads'

const server = (threadId: string, over: Partial<ThreadSummary> = {}): ThreadSummary => ({
  threadId,
  title: `Server name for ${threadId}`,
  createdAt: '2026-08-12T09:00:00.000Z',
  updatedAt: '2026-08-12T09:00:00.000Z',
  preview: '',
  messageCount: 2,
  ...over,
})

const claim = (threadId: string, startedAt: number): StartedThread => ({
  threadId, title: `Ask on ${threadId}`, startedAt,
})

describe('a chat that exists before the server knows it', () => {
  /* The gap this closes: a run creates its own thread, so between pressing
     Enter and the round trip finishing there is nothing on the server to list —
     and the rail is exactly where somebody looks to check their question
     landed. */
  it('shows a just-started chat at the top, marked as working', () => {
    const rows = withStartedThreads([server('web_old')], [claim('web_new', 1_000)])
    assert.deepEqual(rows.map(r => r.threadId), ['web_new', 'web_old'])
    assert.equal(rows[0]!.running, true)
    assert.equal(rows[0]!.title, 'Ask on web_new')
  })

  /* A claim is what the browser knows that the server does not — so the moment
     the server has its own row, that row is used untouched. Keeping the claim
     on top would leave a chat marked as working for as long as the tab lives,
     on the strength of it having once pressed send. */
  it('stands down completely as soon as the server has the thread', () => {
    const settled = server('web_new', { title: 'Unpaid invoices', running: false })
    const rows = withStartedThreads([settled], [claim('web_new', 1_000)])
    assert.deepEqual(rows, [settled])
  })

  it('orders several claims newest first, above everything the server has', () => {
    const rows = withStartedThreads(
      [server('web_old')],
      [claim('web_a', 1_000), claim('web_b', 5_000)],
    )
    assert.deepEqual(rows.map(r => r.threadId), ['web_b', 'web_a', 'web_old'])
  })

  it('changes nothing when there is nothing to claim', () => {
    const list = [server('web_one'), server('web_two')]
    assert.deepEqual(withStartedThreads(list, []), list)
    assert.deepEqual(withStartedThreads([], []), [])
  })

  /* The rail sorts nothing and renders what it is handed, so a synthetic row
     has to be a complete summary — a missing timestamp reaches `shortAgo` and
     comes back "NaNm". */
  it('gives the claimed row a real timestamp', () => {
    const [row] = withStartedThreads([], [claim('web_new', Date.parse('2026-08-12T10:30:00.000Z'))])
    assert.equal(row!.createdAt, '2026-08-12T10:30:00.000Z')
    assert.equal(row!.updatedAt, '2026-08-12T10:30:00.000Z')
  })
})

/*
 * One chat, one name, in both places that show it.
 *
 * A claim is named with the raw ask, because at the moment it is made that is
 * all anybody knows. A moment later a small model writes a real name, the
 * header switches to it, and the rail used to go on showing the sentence until
 * the renamed server row came back — one chat under two names, a centimetre
 * apart, for the length of a round trip.
 */
describe('renaming a chat the server does not know about yet', () => {
  it('renames the claim the rail is drawing', () => {
    threadStarted('web_a', 'check the recent orders from Manode and tell me which are late')
    threadRenamed('web_a', 'Late Manode orders')
    const [row] = withStartedThreads([], startedThreads())
    assert.equal(row!.title, 'Late Manode orders')
    threadSettled('web_a')
  })

  /* The ordinary case. Once a real row exists it answers for the thread on its
     own, so a late rename has nothing to correct and must not resurrect a claim
     that has already been dropped. */
  it('does nothing for a thread that has no claim', () => {
    threadRenamed('web_b', 'A name for nothing')
    assert.deepEqual(startedThreads(), [])
  })

  it('leaves the claim otherwise as it was', () => {
    threadStarted('web_c', 'the ask')
    const before = startedThreads().find(t => t.threadId === 'web_c')!
    threadRenamed('web_c', 'The name')
    const after = startedThreads().find(t => t.threadId === 'web_c')!
    assert.equal(after.startedAt, before.startedAt)
    assert.equal(after.threadId, 'web_c')
    threadSettled('web_c')
  })
})
