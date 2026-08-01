import {
  BicepsFlexedIcon,
  BookOpenIcon,
  CalendarClockIcon,
  FilePlusIcon,
  FolderOpenIcon,
  PencilLineIcon,
  SearchIcon,
  SquareTerminalIcon,
} from 'lucide-react'
import { describe, expect, it } from 'vitest'

import {
  CanvaIcon,
  GmailIcon,
  GoogleAppsScriptIcon,
  GoogleChatIcon,
  GoogleContactsIcon,
  GoogleDocsIcon,
  GoogleFormsIcon,
  GoogleSheetsIcon,
  GoogleSlidesIcon,
  GoogleTasksIcon,
  GoogleCalendarIcon,
  GoogleDriveIcon,
  GoogleIcon,
  LarkIcon,
  SemrushIcon,
  ZohoIcon,
} from '@/components/brand-icons'
import { DivoDexMark } from '@/components/DivoDexBrand'
import { resolveToolIconComponent } from '../ToolIcon'

/** A `tools.invoke` gateway dispatch to a concrete backend tool. */
const invoke = (toolId: string) => ({
  type: 'tool-divo_gateway',
  input: { op: 'tools.invoke', payload: { toolId } },
})

/** A gateway call that is a bare op with no downstream tool. */
const gatewayOp = (op: string) => ({
  type: 'tool-divo_gateway',
  input: { op },
})

describe('resolveToolIconComponent', () => {
  it('gives every built-in verb its own glyph', () => {
    // These four are the desktop's Company allowlist; before, all of them
    // rendered the same terminal icon, so the work-log said nothing about
    // what the agent had actually done.
    const verb = (name: string) => resolveToolIconComponent({ type: `tool-${name}` })
    expect(verb('read')).toBe(BookOpenIcon)
    expect(verb('edit')).toBe(PencilLineIcon)
    expect(verb('write')).toBe(FilePlusIcon)
    expect(verb('bash')).toBe(SquareTerminalIcon)
    expect(verb('grep')).toBe(SearchIcon)
    expect(verb('glob')).toBe(FolderOpenIcon)
  })

  it('resolves verbs from dynamic-tool parts too', () => {
    expect(
      resolveToolIconComponent({ type: 'dynamic-tool', toolName: 'bash' })
    ).toBe(SquareTerminalIcon)
  })

  it('does not read a gateway op as a file verb', () => {
    // `skills.list` is a Divo capability, not a directory listing; `memory.read`
    // is a recall, not a file read.
    expect(resolveToolIconComponent(gatewayOp('skills.list'))).toBe(
      BicepsFlexedIcon
    )
    expect(resolveToolIconComponent(gatewayOp('memory.read'))).toBe(DivoDexMark)
  })

  it('gives skills the flexed arm', () => {
    expect(resolveToolIconComponent(gatewayOp('skills.list'))).toBe(
      BicepsFlexedIcon
    )
    expect(resolveToolIconComponent(gatewayOp('skills.get'))).toBe(
      BicepsFlexedIcon
    )
    // Finding a skill still reads as a lookup — the magnifier wins there.
    expect(resolveToolIconComponent(gatewayOp('skills.search'))).toBe(SearchIcon)
    expect(resolveToolIconComponent(gatewayOp('skills.resolve'))).toBe(
      SearchIcon
    )
  })

  it('maps vendor tools to their own marks', () => {
    expect(resolveToolIconComponent(invoke('zohoBooks'))).toBe(ZohoIcon)
    expect(resolveToolIconComponent(invoke('zohoCrm'))).toBe(ZohoIcon)
    expect(resolveToolIconComponent(invoke('larkMessaging'))).toBe(LarkIcon)
    expect(resolveToolIconComponent(invoke('larkApproval'))).toBe(LarkIcon)
    expect(resolveToolIconComponent(invoke('canvaDesign'))).toBe(CanvaIcon)
  })

  it('uses the specific Google surface mark where one exists', () => {
    expect(resolveToolIconComponent(invoke('googleGmail'))).toBe(GmailIcon)
    expect(resolveToolIconComponent(invoke('googleDrive'))).toBe(GoogleDriveIcon)
    expect(resolveToolIconComponent(invoke('googleCalendar'))).toBe(
      GoogleCalendarIcon
    )
  })

  it('gives every Workspace surface its own product mark', () => {
    // A shared generic G made a Docs call and a Sheets call look identical in
    // the work log, which is the one thing the mark is there to prevent.
    const marks: Array<[string, unknown]> = [
      ['googleDocs', GoogleDocsIcon],
      ['googleSheets', GoogleSheetsIcon],
      ['googleSlides', GoogleSlidesIcon],
      ['googleChat', GoogleChatIcon],
      ['googleTasks', GoogleTasksIcon],
      ['googleForms', GoogleFormsIcon],
      ['googleContacts', GoogleContactsIcon],
      ['googleAppsScript', GoogleAppsScriptIcon],
    ]
    for (const [id, mark] of marks) {
      expect(resolveToolIconComponent(invoke(id))).toBe(mark)
    }
    // Distinct components, not the same one eight times.
    expect(new Set(marks.map(([, mark]) => mark)).size).toBe(marks.length)
  })

  it('still falls back to the plain Google glyph for an unmapped surface', () => {
    // Honest generic beats a borrowed mark: a surface we have no art for must
    // not inherit whichever product happens to sort nearby.
    expect(resolveToolIconComponent(invoke('googleVault'))).toBe(GoogleIcon)
  })

  it("marks Divo's own capabilities with the Divo mark", () => {
    expect(resolveToolIconComponent(invoke('knowledge'))).toBe(DivoDexMark)
    expect(resolveToolIconComponent(gatewayOp('connections.list'))).toBe(
      DivoDexMark
    )
  })

  it('shows scheduled work as time-based automation', () => {
    expect(resolveToolIconComponent(invoke('scheduledWorkflows'))).toBe(
      CalendarClockIcon
    )
  })

  it('shows the magnifier for skill resolution and every lookup', () => {
    expect(resolveToolIconComponent(gatewayOp('skills.search'))).toBe(SearchIcon)
    expect(resolveToolIconComponent(gatewayOp('skills.resolve'))).toBe(SearchIcon)
    expect(resolveToolIconComponent(gatewayOp('persona.resolve'))).toBe(SearchIcon)
    expect(resolveToolIconComponent(invoke('contextSearch'))).toBe(SearchIcon)
    expect(resolveToolIconComponent(invoke('documentRag'))).toBe(SearchIcon)
    expect(
      resolveToolIconComponent({ type: 'tool-divo_skill_resolve' })
    ).toBe(SearchIcon)
  })

  it('keeps memory recall branded rather than treating it as a search', () => {
    // A recall is the one lookup worth showing as Divo's own doing.
    expect(
      resolveToolIconComponent(gatewayOp('memory.search'))
    ).toBe(DivoDexMark)
    expect(
      resolveToolIconComponent({ type: 'tool-divo_memory_recall' })
    ).toBe(DivoDexMark)
  })

  it('prefers the dispatched toolId over the gateway op', () => {
    // Both are present on a tools.invoke; the vendor must win, otherwise every
    // invoke would render as a generic Divo action.
    expect(resolveToolIconComponent(invoke('zohoBooks'))).not.toBe(DivoDexMark)
  })

  it('resolves from the bare tool name when there is no gateway input', () => {
    expect(
      resolveToolIconComponent({ type: 'tool-divo_memory_recall' })
    ).toBe(DivoDexMark)
  })

  it('resolves a mid-stream partial input before the JSON closes', () => {
    // Input arrives token by token; the icon must land while the call runs.
    expect(
      resolveToolIconComponent({
        type: 'tool-divo_gateway',
        input: '{"op":"tools.invoke","payload":{"toolId":"larkDoc"',
      })
    ).toBe(LarkIcon)
  })

  it('brands the gateway machinery but not the tools it dispatches to', () => {
    // A lifecycle op is Divo acting as itself. A dispatch to a tool we have no
    // glyph for is genuinely unknown — branding it would overclaim, and would
    // dilute what the mark means on a memory recall.
    expect(resolveToolIconComponent(gatewayOp('tools.preflight'))).toBe(
      DivoDexMark
    )
    expect(resolveToolIconComponent(gatewayOp('tools.commit'))).toBe(DivoDexMark)
    // Gateway call whose op has not streamed in yet.
    expect(resolveToolIconComponent({ type: 'tool-divo_gateway' })).toBe(
      DivoDexMark
    )
    expect(resolveToolIconComponent(invoke('somethingNew'))).not.toBe(
      DivoDexMark
    )
  })

  it('keeps the Semrush mark on research calls instead of the magnifier', () => {
    // Semrush IS search, so the lookup heuristic is the thing most likely to
    // steal it back. Both the bare tool and a future search-shaped op must
    // stay branded.
    expect(resolveToolIconComponent(invoke('semrush'))).toBe(SemrushIcon)
    expect(resolveToolIconComponent(invoke('semrushKeywordSearch'))).toBe(
      SemrushIcon
    )
  })

  it('does not guess for unknown tools', () => {
    const unknown = resolveToolIconComponent(invoke('customTool'))
    expect(unknown).not.toBe(GoogleIcon)
    expect(unknown).not.toBe(ZohoIcon)
    expect(unknown).not.toBe(DivoDexMark)
  })
})
