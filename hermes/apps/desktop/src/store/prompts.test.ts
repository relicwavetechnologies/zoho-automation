import { afterEach, describe, expect, it } from 'vitest'

import {
  $approvalRequest,
  $secretRequest,
  $sudoRequest,
  clearAllPrompts,
  clearApprovalRequest,
  clearSecretRequest,
  clearSudoRequest,
  setApprovalRequest,
  setSecretRequest,
  setSudoRequest
} from './prompts'

afterEach(() => {
  clearAllPrompts()
})

describe('approval prompt store', () => {
  it('holds the most recent session-keyed approval request', () => {
    setApprovalRequest({ command: 'rm -rf /tmp/x', description: 'recursive delete', sessionId: 's1' })

    expect($approvalRequest.get()).toEqual({
      command: 'rm -rf /tmp/x',
      description: 'recursive delete',
      sessionId: 's1'
    })
  })

  it('clears unconditionally (approval is session-keyed, no request id)', () => {
    setApprovalRequest({ command: 'x', description: 'd', sessionId: 's1' })
    clearApprovalRequest()

    expect($approvalRequest.get()).toBeNull()
  })
})

describe('sudo prompt store', () => {
  it('clears only when the request id matches the in-flight prompt', () => {
    setSudoRequest({ requestId: 'abc' })

    // A stale clear for a different request must NOT drop the live prompt —
    // otherwise a late response to a prior sudo ask would dismiss the current
    // one and leave the agent blocked.
    clearSudoRequest('stale')
    expect($sudoRequest.get()).toEqual({ requestId: 'abc' })

    clearSudoRequest('abc')
    expect($sudoRequest.get()).toBeNull()
  })

  it('clears unconditionally when no request id is given', () => {
    setSudoRequest({ requestId: 'abc' })
    clearSudoRequest()

    expect($sudoRequest.get()).toBeNull()
  })
})

describe('secret prompt store', () => {
  it('carries env var and prompt, and clears on id match', () => {
    setSecretRequest({ requestId: 'r1', envVar: 'OPENAI_API_KEY', prompt: 'Paste your key' })

    expect($secretRequest.get()).toEqual({
      requestId: 'r1',
      envVar: 'OPENAI_API_KEY',
      prompt: 'Paste your key'
    })

    clearSecretRequest('mismatch')
    expect($secretRequest.get()).not.toBeNull()

    clearSecretRequest('r1')
    expect($secretRequest.get()).toBeNull()
  })
})

describe('clearAllPrompts', () => {
  it('drops every in-flight prompt at once (turn end / interrupt)', () => {
    setApprovalRequest({ command: 'x', description: 'd', sessionId: 's1' })
    setSudoRequest({ requestId: 'abc' })
    setSecretRequest({ requestId: 'r1', envVar: 'E', prompt: 'p' })

    clearAllPrompts()

    expect($approvalRequest.get()).toBeNull()
    expect($sudoRequest.get()).toBeNull()
    expect($secretRequest.get()).toBeNull()
  })

  it('is idempotent when nothing is pending (safe to call on session switch)', () => {
    // Calling when already empty must not throw
    clearAllPrompts()

    expect($approvalRequest.get()).toBeNull()
    expect($sudoRequest.get()).toBeNull()
    expect($secretRequest.get()).toBeNull()
  })
})

describe('session-switch prompt clearing (plan §3)', () => {
  it('approval from old session does not survive a session switch', () => {
    // Session A had a dangerous-command approval in-flight
    setApprovalRequest({ command: 'rm -rf /data', description: 'risky', sessionId: 'session-A' })
    expect($approvalRequest.get()?.sessionId).toBe('session-A')

    // User opens a new chat — startFreshSessionDraft calls clearAllPrompts
    clearAllPrompts()

    // New session (session-B) starts clean
    expect($approvalRequest.get()).toBeNull()
  })

  it('new session can immediately receive its own approval without old session bleed', () => {
    setApprovalRequest({ command: 'old cmd', description: 'old', sessionId: 'session-A' })
    clearAllPrompts()

    // Session B raises its own approval
    setApprovalRequest({ command: 'new cmd', description: 'new', sessionId: 'session-B' })

    const current = $approvalRequest.get()
    expect(current?.sessionId).toBe('session-B')
    expect(current?.command).toBe('new cmd')
  })

  it('clearAllPrompts on reconnect leaves no stale approval from dropped connection', () => {
    // Simulates gateway drop: approval was pending before sleep/drop
    setApprovalRequest({ command: 'danger', description: 'risky', sessionId: 'pre-drop-session' })
    setSudoRequest({ requestId: 'sudo-pre-drop' })

    // attemptReconnect fires clearAllPrompts before refreshing sessions
    clearAllPrompts()

    // Reconnected gateway re-emits events only for still-in-flight turns;
    // timed-out / completed turns produce no re-emission — slate is clean
    expect($approvalRequest.get()).toBeNull()
    expect($sudoRequest.get()).toBeNull()
  })
})
