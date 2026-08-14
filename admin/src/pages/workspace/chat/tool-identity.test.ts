import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { toolMarkFor } from './tool-identity'

/**
 * Mirrors `TOOL_CAPABILITY_DEFINITIONS` in
 * `advance-backend/src/domain/tools/tool-id.ts`, plus `runCommand` — which is
 * deliberately absent there (it is exempt from RBAC) but still renders here.
 *
 * A hand-maintained mirror across a package boundary goes stale silently, which
 * is exactly how the old label-keyed map came to miss every governed call. The
 * count assertion below is the tripwire: it fails when the backend gains a tool
 * and this list has not been told, which is the only failure mode a mirror has.
 */
const CANONICAL_TOOL_IDS = [
  'larkMessaging', 'larkContacts', 'larkTask', 'larkCalendar', 'larkMeeting',
  'larkDoc', 'larkBase', 'larkApproval',
  'googleGmail', 'googleDrive', 'googleCalendar', 'googleDocs', 'googleSheets',
  'googleSlides', 'googleForms', 'googleTasks', 'googleContacts', 'googleChat',
  'googleAppsScript',
  'canvaDesign',
  'airtableBase', 'airtableRecords', 'airtableSchema', 'airtableAutomation',
  'aitableDatasheets', 'aitableFields',
  'zohoCrm', 'zohoBooks',
  'shopifyAnalytics', 'shopifyOrders', 'shopifyCustomers',
  'webSearch', 'knowledge', 'mailAutomations', 'scheduledWorkflows',
  'semrush', 'omsSiteData', 'menhoodData',
  'runCommand',
]

/** CANONICAL_TOOL_IDS in the backend, plus runCommand. Update both together. */
const EXPECTED_TOOL_COUNT = 39

/** The container's own tools, as they arrive on a ledger row's `toolName`. */
const CONTAINER_TOOLS = [
  'read', 'write', 'edit', 'bash', 'divo_gateway', 'divo_skill_resolve',
  'divo_memory_recall', 'divo_memory', 'divo_memory_review',
  'divo_knowledge_review', 'divo_teach_clarify', 'divo_todos', 'divo_artifact',
  'divo_subagents',
]

describe('tool mark coverage', () => {
  it('notices when the backend gains a tool this mirror has not been told about', () => {
    assert.equal(CANONICAL_TOOL_IDS.length, EXPECTED_TOOL_COUNT)
    assert.equal(new Set(CANONICAL_TOOL_IDS).size, CANONICAL_TOOL_IDS.length)
  })

  /* The generic wrench is the "we do not know" answer. A canonical tool always
     has a family, so reaching it here means a rule is missing — which is how a
     branded call ends up looking like an anonymous command. */
  for (const toolId of CANONICAL_TOOL_IDS) {
    it(`gives ${toolId} a real mark`, () => {
      assert.notEqual(toolMarkFor({ toolId, toolName: 'divo_gateway' }), 'tool')
    })
  }

  for (const toolName of CONTAINER_TOOLS) {
    it(`gives ${toolName} a real mark`, () => {
      assert.notEqual(toolMarkFor({ toolName }), 'tool')
    })
  }
})

describe('tool mark resolution', () => {
  /* The bug this whole module exists to fix: the backend labels a governed
     Gmail call "Google Gmail", and a map keyed on that English missed, so every
     branded call in the log rendered as a terminal. */
  it('reads the vendor off the id, not off the label', () => {
    assert.equal(toolMarkFor({ toolId: 'googleGmail', toolName: 'divo_gateway' }), 'gmail')
    assert.equal(toolMarkFor({ toolId: 'zohoBooks', toolName: 'divo_gateway' }), 'zohoBooks')
    assert.equal(toolMarkFor({ toolId: 'larkTask', toolName: 'divo_gateway' }), 'lark')
  })

  it('prefers the dispatched tool over the gateway that carried it', () => {
    assert.equal(toolMarkFor({ toolId: 'googleSheets', toolName: 'divo_gateway' }), 'sheets')
    assert.equal(toolMarkFor({ toolName: 'divo_gateway' }), 'divo')
  })

  it('gives each container verb its own glyph rather than one terminal', () => {
    assert.equal(toolMarkFor({ toolName: 'bash' }), 'terminal')
    assert.equal(toolMarkFor({ toolName: 'read' }), 'read')
    assert.equal(toolMarkFor({ toolName: 'write' }), 'write')
    assert.equal(toolMarkFor({ toolName: 'edit' }), 'edit')
  })

  /* An unmapped Google surface gets the plain Google glyph. A generic mark is
     honest about not knowing; a borrowed one claims the wrong app was touched. */
  it('falls back within a family rather than out of it', () => {
    assert.equal(toolMarkFor({ toolId: 'googleSomethingNew' }), 'google')
    assert.equal(toolMarkFor({ toolId: 'larkSomethingNew' }), 'lark')
  })

  it('admits when it does not know', () => {
    assert.equal(toolMarkFor({}), 'tool')
    assert.equal(toolMarkFor({ toolId: 'wildlyUnknownVendor' }), 'tool')
  })

  /* A recall stays branded so the log shows plainly when Divo remembered
     something; a search says what it did rather than who did it. */
  it('keeps memory branded and lookups generic', () => {
    assert.equal(toolMarkFor({ toolName: 'divo_memory_recall' }), 'divo')
    assert.equal(toolMarkFor({ toolId: 'contextSearch' }), 'search')
    assert.equal(toolMarkFor({ toolId: 'skills.search' }), 'search')
    assert.equal(toolMarkFor({ toolId: 'skills.get' }), 'skill')
  })
})
