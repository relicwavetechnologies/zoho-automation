import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { agentRunOf, agentRunStatus, isAgentRow } from './agents'
import type { LedgerChild, LedgerRow } from './stream'

const row = (over: Partial<LedgerRow> = {}): LedgerRow => ({
  label: 'Subagents', count: 1, status: 'running', toolName: 'divo_subagents', ...over,
})

const child = (over: Partial<LedgerChild> = {}): LedgerChild => ({
  label: 'worker', status: 'running', ...over,
})

describe('which row spawned agents', () => {
  it('knows the tool by name', () => {
    assert.equal(isAgentRow(row()), true)
    assert.equal(isAgentRow(row({ toolName: 'divo_gateway' })), false)
  })

  /* A run recorded before the ledger carried tool names still has its agents
     sitting in the row. Without this they would come back as a bare step with
     nothing under it, and every older conversation would quietly lose them. */
  it('knows it by its children when the name was never written down', () => {
    assert.equal(isAgentRow(row({ toolName: undefined, children: [child()] })), true)
    assert.equal(isAgentRow(row({ toolName: undefined })), false)
  })
})

describe('reading the agents under a row', () => {
  it('carries each agent’s role, task and clock', () => {
    const run = agentRunOf(row({
      children: [child({ label: 'scout', outcome: 'read the export', elapsed: '12s' })],
    }))
    assert.deepEqual(run.agents, [
      { role: 'scout', task: 'read the export', elapsed: '12s', state: 'working' },
    ])
  })

  /* Pending and running are the same news — it has not finished — and the card
     says so once. Cancelled is not a quiet success: the work did not happen. */
  it('narrows five wire states to the three a reader acts on', () => {
    const states = (['pending', 'running', 'done', 'failed', 'skipped'] as const)
      .map(status => agentRunOf(row({ children: [child({ status })] })).agents[0]!.state)
    assert.deepEqual(states, ['working', 'working', 'done', 'failed', 'failed'])
  })

  /* The container settles children on the way out, so a parent marked done
     above a child still marked running is a frame that genuinely arrives.
     Taking the parent's word for it draws a finished card over live rows. */
  it('asks the agents whether the work is over, not the row above them', () => {
    const run = agentRunOf(row({
      status: 'done',
      children: [child({ status: 'done' }), child({ status: 'running' })],
    }))
    assert.equal(run.running, true)
    assert.deepEqual([run.done, run.total, run.active], [1, 2, 1])
  })

  /* The first frame arrives before the agents do. "Ran subagents · 0/0" is a
     card that is wrong at the one moment it is most obviously wrong. */
  it('is still working when the agents have not arrived yet', () => {
    const run = agentRunOf(row({ status: 'running' }))
    assert.equal(run.running, true)
    assert.equal(agentRunStatus(run), 'Starting')
  })
})

describe('what the header says', () => {
  const runOf = (...statuses: LedgerChild['status'][]) =>
    agentRunOf(row({ children: statuses.map(status => child({ status })) }))

  it('counts what is still going while anything is', () => {
    assert.equal(agentRunStatus(runOf('done', 'running', 'running')), '1/3 complete · 2 active')
  })

  /* An agent that failed has stopped, but it did not finish the work. Counting
     it complete gave "2/2 complete · 1 failed" — a header that contradicts
     itself inside one sentence. */
  it('counts what broke once nothing is, without counting it as done', () => {
    assert.equal(agentRunStatus(runOf('done', 'failed')), '1/2 complete · 1 failed')
  })

  it('says only the fraction when every agent finished', () => {
    assert.equal(agentRunStatus(runOf('done', 'done')), '2/2 complete')
  })
})
