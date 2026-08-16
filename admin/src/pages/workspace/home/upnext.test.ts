import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { lateCount, upNext } from './upnext'
import type { OpenTask } from '../data/use-my-tasks'
import type { Decision } from '../decisions/decision'

const NOW = new Date('2026-08-17T15:00:00Z')

const task = (over: Partial<OpenTask> & { taskId: string; title: string }): OpenTask =>
  ({ overdue: false, ...over })

const approval = (over: Partial<Decision> & { id: string }): Decision => ({
  title: 'Send a reply to 4 customers',
  source: 'Aleem',
  questions: [],
  requestedAt: NOW.toISOString(),
  expiresAt: null,
  threadId: null,
  ...over,
})

describe('upNext', () => {
  it('puts what is late above what is merely due', () => {
    const items = upNext([
      task({ taskId: 'a', title: 'Later', dueDate: '2026-08-30' }),
      task({ taskId: 'b', title: 'Late one', dueDate: '2026-08-12' }),
      task({ taskId: 'c', title: 'Today', dueDate: '2026-08-17' }),
    ], [], 6, NOW)

    assert.deepEqual(items.map((i) => i.title), ['Late one', 'Today', 'Later'])
    assert.deepEqual(items.map((i) => i.urgency), ['late', 'today', 'later'])
  })

  it('reads Lark as the authority on overdue, not the date', () => {
    /* A task can be overdue in Lark with no due date at all — a recurring one
       whose window closed. Deriving urgency from `dueDate` alone filed those
       under "later", which is the opposite of true. */
    const [item] = upNext([task({ taskId: 'a', title: 'No date', overdue: true })], [], 6, NOW)

    assert.equal(item!.urgency, 'late')
    assert.equal(item!.when, 'Overdue')
  })

  it('ranks an approval above a task when both are as urgent', () => {
    /* An approval is somebody else stopped mid-run waiting on this person. A
       task is this person's own work. Both are "today"; only one is blocking
       another human. */
    const items = upNext(
      [task({ taskId: 'a', title: 'Aaa first alphabetically', dueDate: '2026-08-17' })],
      [approval({ id: 'x', expiresAt: '2026-08-17T20:00:00Z' })],
      6, NOW,
    )

    assert.deepEqual(items.map((i) => i.kind), ['approval', 'task'])
  })

  it('orders by title so a re-read cannot reshuffle the list', () => {
    /* Two polls returning the same rows in a different sequence would otherwise
       rearrange the page under the reader every few seconds. */
    const rows = [
      task({ taskId: 'a', title: 'Banana', dueDate: '2026-08-17' }),
      task({ taskId: 'b', title: 'Apple', dueDate: '2026-08-17' }),
    ]
    const forwards = upNext(rows, [], 6, NOW).map((i) => i.id)
    const backwards = upNext([...rows].reverse(), [], 6, NOW).map((i) => i.id)

    assert.deepEqual(forwards, backwards)
    assert.deepEqual(forwards, ['task:b', 'task:a'])
  })

  it('measures an approval in hours and a task in days', () => {
    const [soon, later] = upNext(
      [task({ taskId: 'a', title: 'T', dueDate: '2026-08-19' })],
      [approval({ id: 'x', expiresAt: '2026-08-17T19:00:00Z' })],
      6, NOW,
    )

    assert.equal(soon!.when, 'Expires in 4h')
    assert.equal(later!.when, 'Due in 2 days')
  })

  it('calls an approval that has run out late rather than hiding it', () => {
    const [item] = upNext([], [approval({ id: 'x', expiresAt: '2026-08-17T09:00:00Z' })], 6, NOW)

    assert.equal(item!.urgency, 'late')
    assert.equal(item!.when, 'Expired')
  })

  it('trims to the limit after ordering, never before', () => {
    const items = upNext([
      task({ taskId: 'a', title: 'One', dueDate: '2026-08-30' }),
      task({ taskId: 'b', title: 'Two', dueDate: '2026-08-30' }),
      task({ taskId: 'c', title: 'Late', dueDate: '2026-08-01' }),
    ], [], 2, NOW)

    assert.deepEqual(items.map((i) => i.title), ['Late', 'One'])
  })

  it('counts what is late over everything it was given', () => {
    /* Over the merged list, not the trimmed one: a header agreeing with the cut
       would under-report the day. */
    const all = upNext([
      task({ taskId: 'a', title: 'A', overdue: true }),
      task({ taskId: 'b', title: 'B', overdue: true }),
      task({ taskId: 'c', title: 'C', dueDate: '2026-08-30' }),
    ], [], 99, NOW)

    assert.equal(lateCount(all), 2)
  })

  it('takes the title the decision already carries, not a tool call', () => {
    /* `title` is what `describeToolAction` produced — "Send email" — and it
       arrives ready to read. The band used to reach for a `description.summary`
       field the endpoint never sent, and fell through to printing the raw
       action group. */
    const [a] = upNext([], [approval({ id: 'x', title: 'Send email' })], 6, NOW)
    assert.equal(a!.title, 'Send email')
  })
})
