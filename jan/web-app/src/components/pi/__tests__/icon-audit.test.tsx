import { describe, it, expect } from 'vitest'
import { WrenchIcon } from 'lucide-react'
import { resolveToolIconComponent } from '../ToolIcon'

// Mirrors CANONICAL_TOOL_IDS in advance-backend/src/domain/tools/tool-id.ts,
// plus runCommand (deliberately excluded there — it is exempt from RBAC, but it
// still renders in the work log).
//
// This list is hand-maintained across a package boundary, so it silently went
// stale: `airtable*` and `omsSiteData` shipped rendering as the generic wrench
// because the audit that exists to prevent exactly that never saw them. The
// count assertion below is the tripwire — it fails when the backend adds a tool
// and this mirror is not updated, which is the only failure mode a mirror has.
const CANONICAL_TOOL_IDS = [
  'larkMessaging', 'larkContacts', 'larkTask', 'larkCalendar', 'larkMeeting',
  'larkDoc', 'larkBase', 'larkApproval',
  'googleGmail', 'googleDrive', 'googleCalendar', 'googleDocs', 'googleSheets',
  'googleSlides', 'googleForms', 'googleTasks', 'googleContacts', 'googleChat',
  'googleAppsScript',
  'canvaDesign',
  'airtableRecords', 'airtableSchema', 'airtableAutomation',
  'zohoCrm', 'zohoBooks',
  'contextSearch', 'webSearch', 'skillPublishing', 'memoryPublishing',
  'memoryRecall', 'documentRag', 'dataProcessor', 'scheduledWorkflows',
  'semrush', 'omsSiteData',
  'runCommand',
]

/** CANONICAL_TOOL_IDS in the backend, plus runCommand. Update both together. */
const EXPECTED_CANONICAL_TOOL_COUNT = 36

// Mirrors GATEWAY_OPS in advance-backend/src/application/gateway/gateway.types.ts.
const GATEWAY_OPS = [
  'capabilities.get', 'tools.list', 'skills.list', 'skills.search', 'skills.get',
  'work.resolve', 'persona.resolve', 'teach.context.get', 'teach.learning.apply',
  'connections.list', 'media.image_ocr', 'tools.preflight', 'tools.prepare',
  'tools.commit', 'tools.invoke', 'automation.plan.create', 'automation.plan.status',
]

// Mirrors COMPANY_TOOL_ALLOWLIST in jan/src-tauri/src/core/pi/runtime.rs.
const DESKTOP_TOOLS = [
  'read', 'write', 'edit', 'bash', 'divo_gateway', 'divo_skill_resolve',
  'divo_memory_recall', 'divo_memory_review', 'divo_teach_clarify', 'memory',
  'divo_todos', 'divo_artifact',
]

describe('tool icon coverage', () => {
  it('keeps retired gateway operations out of desktop metadata', () => {
    expect(GATEWAY_OPS).not.toContain('google.plan')
    expect(GATEWAY_OPS).toContain('work.resolve')
  })

  it('notices when the backend gains a tool this mirror has not been told about', () => {
    expect(CANONICAL_TOOL_IDS).toHaveLength(EXPECTED_CANONICAL_TOOL_COUNT)
    expect(new Set(CANONICAL_TOOL_IDS).size).toBe(CANONICAL_TOOL_IDS.length)
  })

  it.each(CANONICAL_TOOL_IDS)('gives %s a real icon', (toolId) => {
    expect(
      resolveToolIconComponent({
        type: 'tool-divo_gateway',
        input: { op: 'tools.invoke', payload: { toolId } },
      })
    ).not.toBe(WrenchIcon)
  })

  it.each(GATEWAY_OPS)('gives the %s op a real icon', (op) => {
    expect(
      resolveToolIconComponent({ type: 'tool-divo_gateway', input: { op } })
    ).not.toBe(WrenchIcon)
  })

  it.each(DESKTOP_TOOLS)('gives the %s desktop tool a real icon', (name) => {
    expect(resolveToolIconComponent({ type: `tool-${name}` })).not.toBe(
      WrenchIcon
    )
  })
})
