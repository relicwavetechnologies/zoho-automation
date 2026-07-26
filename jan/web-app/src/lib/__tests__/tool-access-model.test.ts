import { describe, expect, it } from 'vitest'

import type { DepartmentToolCoverage, DivoToolInventoryItem } from '../divo-tools'
import {
  ceilingState,
  coverageLabel,
  effectiveMark,
  groupMemberSummary,
  isInUse,
  toolStatus,
  whyThisAccess,
} from '../tool-access-model'

const item = (overrides: Partial<DivoToolInventoryItem> = {}) => ({
  tool: { toolId: 't', name: 'T', description: '', category: '', domain: '', hitlRequired: false },
  origins: [],
  managementScopes: [],
  readiness: 'ready',
  ...overrides,
} as DivoToolInventoryItem)

describe('toolStatus', () => {
  // A tool that cannot run is the only thing on this row worth interrupting for,
  // so it outranks "ready" even when other capabilities in the group are fine.
  it('reports a missing connection ahead of anything else', () => {
    expect(toolStatus([item(), item({ readiness: 'connection_required' })]).kind).toBe('attention')
  })

  it('treats an admin-owned missing connection the same way', () => {
    expect(toolStatus([item({ readiness: 'admin_connection_required' })]).kind).toBe('attention')
  })

  it('calls a wholly fixed tool fixed', () => {
    expect(toolStatus([item({ origins: [{ kind: 'system', allowedActions: ['read'], reason: 'r' }], readiness: 'not_applicable' })]).kind).toBe('fixed')
  })

  it('does not call a group fixed when only part of it is', () => {
    expect(toolStatus([
      item({ origins: [{ kind: 'system', allowedActions: ['read'], reason: 'r' }] }),
      item({ origins: [{ kind: 'global', allowedActions: ['read'] }] }),
    ]).kind).toBe('ready')
  })

  it('falls back to built in rather than claiming readiness it has not seen', () => {
    expect(toolStatus([item({ readiness: 'not_applicable' })]).kind).toBe('builtin')
    expect(toolStatus([]).kind).toBe('builtin')
  })
})

describe('coverageLabel', () => {
  it('says no one rather than "0 of 9"', () => {
    expect(coverageLabel(0, 9)).toBe('No one')
  })

  it('says everyone when everyone has it', () => {
    expect(coverageLabel(9, 9)).toBe('All 9 people')
  })

  it('counts the partial case', () => {
    expect(coverageLabel(5, 9)).toBe('5 of 9 people')
  })

  it('does not claim "all" for an empty department', () => {
    expect(coverageLabel(0, 0)).toBe('No one')
  })
})

describe('ceilingState', () => {
  const coverage = (blocked: string[], supported = ['read', 'create', 'update']) =>
    ({ blockedActions: blocked, supportedActions: supported }) as DepartmentToolCoverage

  it('is clear when policy blocks nothing', () => {
    expect(ceilingState(coverage([])).kind).toBe('clear')
  })

  // A ceiling that blocks everything is one sentence said once; only a partial
  // one earns a label on each switch.
  it('is total when policy blocks every action', () => {
    expect(ceilingState(coverage(['read', 'create', 'update'])).kind).toBe('total')
  })

  it('names the actions when policy blocks only some', () => {
    expect(ceilingState(coverage(['update']))).toEqual({ kind: 'partial', actions: ['update'] })
  })
})

describe('effectiveMark', () => {
  it('is allowed when it actually works', () => {
    expect(effectiveMark({ configuredAllowed: true, effectiveAllowed: true })).toBe('allowed')
  })

  // The case that made "I switched it on and nothing happened" a support
  // question: configured here, denied above.
  it('distinguishes granted-but-blocked from never-granted', () => {
    expect(effectiveMark({ configuredAllowed: true, effectiveAllowed: false })).toBe('blocked_by_company')
    expect(effectiveMark({ configuredAllowed: false, effectiveAllowed: false })).toBe('not_allowed')
  })
})

describe('whyThisAccess', () => {
  const base = { configuredAllowed: true, effectiveBlockReason: null, roleName: 'Analyst' } as const

  it('blames company policy above everything else', () => {
    expect(whyThisAccess({ ...base, configuredProvenance: 'member_override', effectiveBlockReason: 'company_action_disabled' }))
      .toBe('Blocked by company policy')
  })

  it('names an exception in both directions', () => {
    expect(whyThisAccess({ ...base, configuredProvenance: 'member_override' })).toBe('Allowed by a personal exception')
    expect(whyThisAccess({ ...base, configuredProvenance: 'member_override', configuredAllowed: false })).toBe('Removed by a personal exception')
  })

  it('credits the group when the group is the reason', () => {
    expect(whyThisAccess({ ...base, configuredProvenance: 'department_role' })).toBe('Allowed by the Analyst group')
  })

  it('explains an absence as the group not having it', () => {
    expect(whyThisAccess({ ...base, configuredProvenance: 'default', configuredAllowed: false }))
      .toBe('The Analyst group does not have this')
  })
})

describe('isInUse', () => {
  const coverage = (over: Partial<DepartmentToolCoverage>) => ({ peopleWithAccess: 0, actionsGranted: [], ...over }) as DepartmentToolCoverage

  it('is in use once anyone holds it', () => {
    expect(isInUse(coverage({ peopleWithAccess: 1 }))).toBe(true)
  })

  // A grant with nobody in the group yet is still a decision the manager made;
  // filing it under "not turned on" would hide it from them.
  it('is in use when a group was granted it but has no people yet', () => {
    expect(isInUse(coverage({ actionsGranted: ['read'] }))).toBe(true)
  })

  it('is not in use when nothing was granted', () => {
    expect(isInUse(coverage({}))).toBe(false)
  })
})

describe('groupMemberSummary', () => {
  it('names up to three and counts the rest', () => {
    expect(groupMemberSummary(['Rahul', 'Priya', 'Aman', 'Sana', 'Dev'])).toBe('Rahul, Priya, Aman +2')
  })

  it('says so when a group is empty', () => {
    expect(groupMemberSummary([])).toBe('No one yet')
  })
})
