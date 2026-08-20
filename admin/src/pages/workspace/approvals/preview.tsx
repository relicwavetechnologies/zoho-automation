/**
 * The same team policy, seen by three different people.
 *
 * Side by side because the confusion this screen exists to end is not "what is
 * the policy" — it is that one policy produces three completely different lived
 * experiences, and nothing anywhere said so. A member gets stopped, the manager
 * who wrote the policy gets stopped by nothing, and the manager with the test
 * flag on gets stopped by their own rule.
 *
 * Development only and fixture-driven, the same arrangement as the other
 * preview routes. The personal picks are live state here rather than a fixture,
 * because the thing worth checking by eye is what happens to the bands when you
 * tick a row: an action moves out of "runs straight away" and into the band at
 * the top, which is the whole design.
 */
import { useState } from 'react'
import { ApprovalsSkeleton } from './screen'
import { PersonalForecast, TeamForecast, type ForecastRow } from './forecast.view'
import type { GatePolicy } from './forecast'
import { NO_PERSONAL_GATE, togglePersonalAction, type PersonalGate } from './personal-gate'

/** What Abhishek ticked on 2026-08-19, as the screenshot showed it. */
const POLICY: GatePolicy = {
  enabled: true,
  requiredActions: [
    { toolId: 'larkTask', actions: ['delete'] },
    { toolId: 'larkCalendar', actions: ['create', 'update'] },
  ],
}

const ROWS: ForecastRow[] = [
  { toolId: 'larkTask', action: 'update', toolName: 'Lark Task', actionLabel: 'Edit tasks', brand: 'lark' },
  { toolId: 'larkTask', action: 'delete', toolName: 'Lark Task', actionLabel: 'Delete tasks', brand: 'lark' },
  { toolId: 'larkCalendar', action: 'create', toolName: 'Lark Calendar', actionLabel: 'Add events', brand: 'lark' },
  { toolId: 'larkCalendar', action: 'update', toolName: 'Lark Calendar', actionLabel: 'Edit events', brand: 'lark' },
  { toolId: 'larkCalendar', action: 'delete', toolName: 'Lark Calendar', actionLabel: 'Delete events', brand: 'lark' },
  { toolId: 'zohoBooks', action: 'create', toolName: 'Zoho Books', actionLabel: 'Add invoices', brand: 'zohoBooks' },
  { toolId: 'zohoBooks', action: 'update', toolName: 'Zoho Books', actionLabel: 'Edit invoices', brand: 'zohoBooks' },
  { toolId: 'googleGmail', action: 'send', toolName: 'Gmail', actionLabel: 'Send email', brand: 'gmail' },
  { toolId: 'googleGmail', action: 'create', toolName: 'Gmail', actionLabel: 'Draft email', brand: 'gmail' },
  { toolId: 'googleSheets', action: 'read', toolName: 'Google Sheets', actionLabel: 'Read sheets', brand: 'googleSheets' },
  { toolId: 'googleSheets', action: 'update', toolName: 'Google Sheets', actionLabel: 'Edit sheets', brand: 'googleSheets' },
  { toolId: 'googleDrive', action: 'create', toolName: 'Google Drive', actionLabel: 'Upload files', brand: 'googleDrive' },
]

const VIEWS = [
  {
    key: 'member',
    who: 'Priya — a member of the team',
    note: 'Not the approver. The policy applies to her exactly as written.',
    askerIsApprover: false,
    selfBypassDisabled: false,
  },
  {
    key: 'manager-today',
    who: 'Abhishek — the manager, as things stand today',
    note: 'Every gate he ticked runs for him, in its own band saying so. This is the state that made no sense from the outside.',
    askerIsApprover: true,
    selfBypassDisabled: false,
  },
  {
    key: 'manager-flagged',
    who: 'Abhishek — with DIVO_HITL_TEST_DISABLE_MANAGER_SELF_BYPASS on',
    note: 'His own rule now applies to him, which is what makes the card testable.',
    askerIsApprover: true,
    selfBypassDisabled: true,
  },
] as const

export function ApprovalForecastPreview() {
  const [personal, setPersonal] = useState<PersonalGate>(NO_PERSONAL_GATE)

  return (
    /* `cur` because the real page renders inside the settings shell, which
       carries it, and several workspace styles are scoped under it. Without it
       the preview silently drops them: the skeletons came out transparent and
       unanimated here while being correct in the app. */
    <div className="cur min-h-screen bg-page px-6 py-8">
      <header className="mx-auto mb-6 max-w-[1240px]">
        <h1 className="text-[15px] font-medium text-ink">Will this stop and ask me?</h1>
        <p className="mt-1 text-[12px] text-ink-3">
          One policy, three people. The rows are identical; only who is asking changes.
          Ticking “Ask me” moves that action up into the first band, in all three at once,
          because the picks belong to the reader rather than to a team.
        </p>
      </header>

      <div
        className="mx-auto grid max-w-[1240px] items-start gap-5"
        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))' }}
      >
        {VIEWS.map((view) => (
          <div key={view.key}>
            <p className="mb-1 text-[12px] font-medium text-ink">{view.who}</p>
            <p className="mb-2 text-[11.5px] leading-snug text-ink-3">{view.note}</p>
            <PersonalForecast
              rows={ROWS}
              policy={POLICY}
              channel="web"
              askerIsApprover={view.askerIsApprover}
              selfBypassDisabled={view.selfBypassDisabled}
              approverExists
              approverName="Abhishek"
              personal={personal}
              onToggle={(toolId, action) =>
                setPersonal((was) => togglePersonalAction(was, toolId, action))}
            />
            <div style={{ height: 12 }} />
            <TeamForecast
              rows={ROWS}
              policy={POLICY}
              channel="web"
              askerIsApprover={view.askerIsApprover}
              selfBypassDisabled={view.selfBypassDisabled}
              approverExists
              approverName="Abhishek"
              personal={personal}
              {...(view.askerIsApprover ? { onToggle: () => undefined } : {})}
            />
          </div>
        ))}
      </div>

      {/* The state nobody designs and everybody sees. It shipped as a title
          over an empty screen, so a slow read looked like a broken page. Here
          so it can be looked at rather than only reasoned about. */}
      <div className="mx-auto mt-10 max-w-[620px] border-t border-line pt-6">
        <p className="mb-1 text-[12px] font-medium text-ink">While it loads</p>
        <p className="mb-3 text-[11.5px] leading-snug text-ink-3">
          Shape-matched to what lands, so nothing jumps when it does.
        </p>
        <ApprovalsSkeleton />
      </div>
    </div>
  )
}
