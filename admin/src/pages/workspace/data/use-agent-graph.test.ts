/**
 * The agent map's one promise, under test.
 *
 * The page says "lit edges are permissions the backend would really grant
 * today". Everything that claim rests on is `buildAgents`, and it ran untested
 * inside a `useMemo` — reachable only by loading the page against a live
 * department and reading a picture. A wrong edge here is not cosmetic: it tells
 * an admin that somebody can do something they cannot, or the reverse, on the
 * screen they open to answer exactly that.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildAgents } from './use-agent-graph'
import type { ToolScopeSnapshot, MemberActionState } from './use-team'
import type { AgentDefinition } from './agent-store'

const ME = 'u-me'
const OTHER = 'u-other'

const state = (over: Partial<MemberActionState> & { actionGroup: string }): MemberActionState => ({
  userId: ME,
  configuredAllowed: true,
  configuredProvenance: 'department_role',
  effectiveAllowed: true,
  effectiveBlockReason: null,
  storedOverride: null,
  provenance: 'inherited',
  ...over,
} as MemberActionState)

const tool = (toolId: string, states: MemberActionState[], name = toolId): ToolScopeSnapshot => ({
  tool: { toolId, name, description: null },
  supportedActions: ['read', 'write'],
  actionLabels: { read: 'Read', write: 'Write' },
  roles: [],
  members: [],
  memberActionStates: states,
  roleActionStates: [],
  companyCeiling: [],
})

const draft = (over: Partial<AgentDefinition> & { id: string; name: string }): AgentDefinition => ({
  toolIds: [],
  systemPrompt: '',
  modelId: 'deepseek-chat',
  container: { mode: 'shared', cpu: 2, memoryMb: 2048, idleStopMinutes: 45 },
  memory: { scope: 'company', retentionDays: null, learning: true },
  ...over,
} as AgentDefinition)

describe('buildAgents — reachability', () => {
  it('lights a tool only when some action actually survives', () => {
    const [agent] = buildAgents([tool('airtableRecords', [state({ actionGroup: 'read' })])], ME, {})
    assert.equal(agent?.reachable, true)
    assert.deepEqual(agent?.allowedActions, ['read'])
  })

  /*
   * The distinction the whole map turns on. `configuredAllowed` is what an
   * admin granted; `effectiveAllowed` is what the runtime would really do
   * after the company ceiling clamps it. Reading the first would draw an edge
   * the backend refuses.
   */
  it('does not light a grant the ceiling has clamped', () => {
    const [agent] = buildAgents(
      [tool('airtableRecords', [state({ actionGroup: 'write', configuredAllowed: true, effectiveAllowed: false })])],
      ME,
      {},
    )
    assert.equal(agent?.reachable, false)
    assert.deepEqual(agent?.allowedActions, [])
    assert.deepEqual(agent?.tools[0]?.blockedActions, ['write'])
  })

  /*
   * Blocked means "granted and then taken away", which is worth showing an
   * admin. Never granted at all is not blocked — counting it would report
   * every ungranted tool in the company as an active clamp.
   */
  it('counts a clamped tool as blocked, and an ungranted one as neither', () => {
    const agents = buildAgents([
      tool('airtableRecords', [state({ actionGroup: 'write', configuredAllowed: true, effectiveAllowed: false })]),
      tool('airtableSchema', [state({ actionGroup: 'write', configuredAllowed: false, effectiveAllowed: false })]),
    ], ME, {})
    const airtable = agents.find((a) => a.family === 'airtable')
    assert.equal(airtable?.reachable, false)
    assert.equal(airtable?.blockedToolCount, 1, 'only the clamped one counts as blocked')
    assert.equal(airtable?.reachableToolCount, 0)
  })

  it('ignores another person’s grants entirely', () => {
    const [agent] = buildAgents(
      [tool('airtableRecords', [state({ userId: OTHER, actionGroup: 'read' })])],
      ME,
      {},
    )
    assert.equal(agent?.reachable, false)
  })

  /*
   * With nobody chosen the map is a catalogue, not a verdict. Every tool must
   * come back unreachable so the screen cannot imply the department can do all
   * of it — the caption promises nothing is lit until a person is picked.
   */
  it('lights nothing when no person is chosen', () => {
    const [agent] = buildAgents([tool('airtableRecords', [state({ actionGroup: 'read' })])], undefined, {})
    assert.equal(agent?.reachable, false)
    assert.deepEqual(agent?.allowedActions, [])
  })
})

describe('buildAgents — grouping', () => {
  it('gathers a family under one agent', () => {
    const agents = buildAgents([
      tool('airtableRecords', [state({ actionGroup: 'read' })]),
      tool('airtableSchema', [state({ actionGroup: 'read' })]),
      tool('googleGmail', [state({ actionGroup: 'read' })]),
    ], ME, {})
    assert.equal(agents.length, 2)
    assert.equal(agents.find((a) => a.family === 'airtable')?.tools.length, 2)
    assert.equal(agents.find((a) => a.family === 'google')?.tools.length, 1)
  })

  /*
   * A claimed tool must leave its family. Appearing in both would draw the same
   * capability twice and misreport who runs it.
   */
  it('moves a claimed tool out of its family, never into both', () => {
    const agents = buildAgents([
      tool('airtableRecords', [state({ actionGroup: 'read' })]),
      tool('airtableSchema', [state({ actionGroup: 'read' })]),
    ], ME, {
      'agent:finance': draft({ id: 'agent:finance', name: 'Finance desk', toolIds: ['airtableRecords'] }),
    })

    const authored = agents.find((a) => a.id === 'agent:finance')
    const family = agents.find((a) => a.family === 'airtable')
    assert.deepEqual(authored?.tools.map((t) => t.toolId), ['airtableRecords'])
    assert.deepEqual(family?.tools.map((t) => t.toolId), ['airtableSchema'])
    assert.equal(agents.flatMap((a) => a.tools).filter((t) => t.toolId === 'airtableRecords').length, 1)
  })

  it('names an unknown tool after itself rather than dropping it', () => {
    const [agent] = buildAgents([tool('somethingBrandNew', [state({ actionGroup: 'read' })])], ME, {})
    assert.equal(agent?.family, 'somethingBrandNew')
    assert.equal(agent?.tools.length, 1)
  })

  it('dedupes an action shared across a family’s tools', () => {
    const [agent] = buildAgents([
      tool('airtableRecords', [state({ actionGroup: 'read' })]),
      tool('airtableSchema', [state({ actionGroup: 'read' })]),
    ], ME, {})
    assert.deepEqual(agent?.allowedActions, ['read'], 'read on two tools is one capability')
  })
})

describe('buildAgents — provenance and order', () => {
  /*
   * Naming the strongest grant is how an admin knows where to go to change it.
   * A member override beats a role grant beats a default.
   */
  it('reports the strongest grant that actually landed', () => {
    const [agent] = buildAgents([
      tool('airtableRecords', [
        state({ actionGroup: 'read', configuredProvenance: 'department_role' }),
        state({ actionGroup: 'write', configuredProvenance: 'member_override' }),
      ]),
    ], ME, {})
    assert.equal(agent?.tools[0]?.provenance, 'member_override')
  })

  it('takes provenance from a grant that survived, not one that was clamped', () => {
    const [agent] = buildAgents([
      tool('airtableRecords', [
        state({ actionGroup: 'read', configuredProvenance: 'department_role' }),
        state({ actionGroup: 'write', configuredProvenance: 'member_override', effectiveAllowed: false }),
      ]),
    ], ME, {})
    assert.equal(agent?.tools[0]?.provenance, 'department_role')
  })

  it('puts authored agents first, then reachable ones', () => {
    const agents = buildAgents([
      tool('googleGmail', [state({ actionGroup: 'read' })]),
      tool('zohoCrm', [state({ actionGroup: 'read', effectiveAllowed: false, configuredAllowed: false })]),
      tool('airtableRecords', [state({ actionGroup: 'read' })]),
    ], ME, {
      'agent:desk': draft({ id: 'agent:desk', name: 'Desk', toolIds: ['airtableRecords'] }),
    })
    assert.equal(agents[0]?.kind, 'authored')
    assert.equal(agents[agents.length - 1]?.family, 'zoho', 'the unreachable one sinks to the end')
  })
})
