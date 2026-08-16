import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { dueLabel } from './use-my-tasks'

const NOW = new Date('2026-08-16T09:00:00Z')
const task = (dueDate?: string) => ({
  taskId: 't', title: 'T', overdue: false, ...(dueDate ? { dueDate } : {}),
})

describe('how a deadline reads', () => {
  it('says nothing when there is no deadline to report', () => {
    // Most real tasks have no date. "No due date" as a label is noise on every
    // row; the absence is better said by an empty column.
    assert.equal(dueLabel(task(), NOW), null)
  })

  it('counts days, not hours', () => {
    /* It is nine in the morning on the 16th. Work due today is due today, not
       fifteen hours late — the comparison is between calendar dates. */
    assert.equal(dueLabel(task('2026-08-16'), NOW), 'Due today')
    assert.equal(dueLabel(task('2026-08-17'), NOW), 'Due tomorrow')
    assert.equal(dueLabel(task('2026-08-19'), NOW), 'Due in 3 days')
  })

  it('says how late, because late is the part worth acting on', () => {
    assert.equal(dueLabel(task('2026-08-15'), NOW), '1 day late')
    assert.equal(dueLabel(task('2026-08-09'), NOW), '7 days late')
  })
})
