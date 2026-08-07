/**
 * Automations — the list, and one automation.
 *
 * The layout is borrowed from the reference's agent page; the contents are not.
 * Most of what that page shows has no counterpart here — there are no
 * repositories, no sandbox size, no model picker (Divo resolves the model from
 * the grant on every call), and no Save, because nothing on this screen can be
 * written yet. What Divo has instead is a timezone, a department, the set of
 * tools the workflow was compiled against, and an approval grant: which is to
 * say, governance where the reference has infrastructure.
 *
 * The two texts are the thing worth getting right. `userIntent` is what the
 * person asked for, in their words. `compiledPrompt` is what Divo turned that
 * into and what actually runs. Showing only the first would hide what the
 * machine will really do; showing only the second would hide whether it
 * understood. They sit one above the other.
 *
 * Everything here is fixtures — see the note at the top of `use-automations`.
 */
import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  AlertTriangle, Ban, Bot, CalendarClock, Check, ChevronRight, CircleDashed,
  Clock, Pause, Play, SkipForward,
} from 'lucide-react'
import {
  SCHEDULE_LABEL, STATUS_LABEL, useAutomation, useAutomations,
  type Automation, type AutomationRun, type AutomationRunStatus, type AutomationStatus,
} from './data/use-automations'
import { ago } from './data/use-approvals'
import { DetailPage, RailChip, RailEmpty, RailRow, RailSection } from './detail'
import { DataNote, Empty, Fade, PageHeader, Panel, SkelRows, type Toast } from './ui'

type ScreenProps = { replay: number; toast: Toast; go: (screen: string) => void }

/** Nothing on this screen can be written until the routes exist. One sentence,
 *  used by every control that would otherwise look pressable. */
const NO_WRITE = 'Automations can only be changed by asking Divo — the web app has no route for this yet.'

const STATUS_TONE: Record<AutomationStatus, 'ok' | 'warn' | 'off'> = {
  draft: 'off',
  published: 'ok',
  active: 'ok',
  scheduled_active: 'ok',
  paused: 'warn',
  archived: 'off',
}

const StatusBadge = ({ status }: { status: AutomationStatus }) => {
  const tone = STATUS_TONE[status]
  return (
    <span className={`badge ${tone === 'ok' ? 'b-ok' : tone === 'warn' ? 'b-warn' : 'b-off'}`}>
      <span className="dot" />{STATUS_LABEL[status]}
    </span>
  )
}

const RUN_ICON: Record<AutomationRunStatus, typeof Check> = {
  queued: Clock,
  running: CircleDashed,
  succeeded: Check,
  failed: AlertTriangle,
  cancelled: Ban,
  skipped: SkipForward,
  blocked: Ban,
}

/** "in 14 hours" / "3 hours ago", or a plain dash when there is no time at all. */
function whenLabel(iso: string | null): string {
  if (!iso) return '—'
  const delta = new Date(iso).getTime() - Date.now()
  if (delta <= 0) return ago(iso)
  const mins = Math.round(delta / 60_000)
  if (mins < 60) return `in ${mins}m`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `in ${hours}h`
  return `in ${Math.round(hours / 24)}d`
}

/* ══ List ══════════════════════════════════════════════ */

export function Automations({ replay, go }: ScreenProps) {
  const { automations, loading } = useAutomations()
  void replay

  return (
    <>
      <PageHeader
        eyebrow="Your workspace"
        title="Automations"
        description="Work Divo does on a schedule without being asked each time."
      />

      <Panel source="automations">
        {loading ? <SkelRows n={3} /> : automations.length === 0 ? (
          <Empty
            icon={Bot}
            title="No automations yet"
            body="Ask Divo to do something on a schedule — “every weekday at 8am, check for overdue invoices” — and it appears here."
          />
        ) : (
          <Fade>
            <div className="ws-rows">
              {automations.map((a) => (
                <button
                  type="button"
                  className="ws-row auto-row"
                  key={a.id}
                  onClick={() => go(`automation:${a.id}`)}
                >
                  <span className="ws-ic"><Bot size={14} /></span>
                  <div className="ws-row-main">
                    <b>{a.name}</b>
                    <p>
                      {SCHEDULE_LABEL[a.scheduleType]}
                      {a.nextRunAt ? ` · next ${whenLabel(a.nextRunAt)}` : ' · not scheduled'}
                      {a.departmentName ? ` · ${a.departmentName}` : ''}
                    </p>
                  </div>
                  <div className="ws-row-act">
                    <StatusBadge status={a.status} />
                    <ChevronRight size={15} className="ws-chev" />
                  </div>
                </button>
              ))}
            </div>
          </Fade>
        )}
      </Panel>
    </>
  )
}

/* ══ Detail ════════════════════════════════════════════ */

export function AutomationDetail({ toast, go }: ScreenProps) {
  const { automationId } = useParams()
  const navigate = useNavigate()
  const { automation, loading } = useAutomation(automationId)

  if (loading) {
    return <div className="page"><SkelRows n={4} /></div>
  }

  if (!automation) {
    return (
      <div className="page">
        <Empty
          icon={Bot}
          title="No such automation"
          body="It may have been archived, or the link may be out of date."
          action={<button type="button" className="btn" onClick={() => go('automations')}>All automations</button>}
        />
      </div>
    )
  }

  const a = automation
  const paused = a.status === 'paused'

  return (
    <DetailPage
      onBack={() => navigate('/me/automations')}
      title={a.name}
      badge={<StatusBadge status={a.status} />}
      meta={`Edited ${ago(a.updatedAt)}`}
      actions={
        <>
          {/* Both of these exist on ScheduledWorkflowControlService — pause(),
              resume() and runNow() are written and used by the agent's tool
              surface. They are disabled here because no HTTP route reaches
              them, not because the behaviour is missing. */}
          <button type="button" className="btn" disabled title={NO_WRITE}>
            {paused ? <Play size={14} /> : <Pause size={14} />}
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button type="button" className="btn primary" disabled title={NO_WRITE}>
            <Play size={14} /> Run now
          </button>
        </>
      }
      rail={<AutomationRail automation={a} toast={toast} />}
    >
      <DataNote source="automations" />

      <section className="dt-block">
        <h2>What you asked for</h2>
        <p className="dt-sub">In your words, as it was captured when this was set up.</p>
        <div className="dt-prose">{a.userIntent}</div>
      </section>

      <section className="dt-block">
        <h2>What Divo will actually do</h2>
        <p className="dt-sub">
          Divo compiles your request into the instruction it runs. This is the one that executes — read it if the
          results are not what you expected.
        </p>
        {a.compiledPrompt ? (
          <div className="dt-prose">{a.compiledPrompt}</div>
        ) : (
          <div className="dt-prose dt-prose-empty">
            Not compiled yet. A draft has been described but not turned into a runnable instruction, so this
            automation would do nothing if it fired.
          </div>
        )}
      </section>
    </DetailPage>
  )
}

function AutomationRail({ automation: a, toast }: { automation: Automation; toast: Toast }) {
  return (
    <>
      <RailSection title="Schedule">
        <RailRow label="Repeats"><RailChip>{SCHEDULE_LABEL[a.scheduleType]}</RailChip></RailRow>
        <RailRow label="Timezone"><RailChip>{a.timezone}</RailChip></RailRow>
        <RailRow label="Next run">
          <RailChip tone={a.nextRunAt ? undefined : 'plain'}>
            {a.nextRunAt ? whenLabel(a.nextRunAt) : 'Not scheduled'}
          </RailChip>
        </RailRow>
        <RailRow label="Last run">
          <RailChip tone="plain">{a.lastRunAt ? ago(a.lastRunAt) : 'Never'}</RailChip>
        </RailRow>
      </RailSection>

      <RailSection title="Properties">
        <RailRow label="Author"><RailChip tone="plain">{a.createdByName}</RailChip></RailRow>
        <RailRow label="Department">
          <RailChip tone="plain">{a.departmentName ?? 'Not set'}</RailChip>
        </RailRow>
        <RailRow label="State"><RailChip>{STATUS_LABEL[a.status]}</RailChip></RailRow>
        {/*
          Delivery is stated, not offered. `ScheduleCreateInput.delivery` is
          documented in the service as "accepted and ignored" — every scheduled
          result goes to whoever created it, in their own Lark DM. A dropdown
          here would be a choice the backend throws away.
        */}
        <RailRow label="Result goes to">
          <RailChip tone="plain">Your Lark DM</RailChip>
        </RailRow>
      </RailSection>

      <RailSection title="What it may use" defaultOpen={a.capabilities.length > 0}>
        {a.capabilities.length === 0 ? (
          <RailEmpty>
            Nothing yet. Divo works out which tools a workflow needs when it compiles it.
          </RailEmpty>
        ) : (
          <div className="dt-caps">
            {a.capabilities.map((c) => <span className="ws-perm" key={c}>{c}</span>)}
          </div>
        )}
      </RailSection>

      <RailSection title="Recent runs" aside={
        a.runs.length > 0 ? <span className="dt-sec-count">{a.runs.length}</span> : null
      }>
        {a.runs.length === 0 ? (
          <RailEmpty>No runs yet. They show up here once this automation fires.</RailEmpty>
        ) : (
          <div className="dt-runs">
            {a.runs.map((run) => <RunLine key={run.id} run={run} toast={toast} />)}
          </div>
        )}
      </RailSection>
    </>
  )
}

function RunLine({ run, toast }: { run: AutomationRun; toast: Toast }) {
  const [open, setOpen] = useState(false)
  const Icon = RUN_ICON[run.status]
  const failed = run.status === 'failed'

  return (
    <div className="dt-run" data-tone={failed ? 'err' : run.status === 'succeeded' ? 'ok' : undefined}>
      <button type="button" className="dt-run-hd" onClick={() => setOpen((v) => !v)}>
        <span className="dt-run-ic"><Icon size={13} /></span>
        <span className="dt-run-t">
          <b>{run.resultSummary ?? run.errorSummary ?? STATUS_LABEL_RUN[run.status]}</b>
          <span>
            {ago(run.scheduledFor)}
            {run.attemptNumber > 1 ? ` · attempt ${run.attemptNumber}` : ''}
          </span>
        </span>
      </button>
      {open ? (
        <div className="dt-run-b">
          {run.errorSummary ? <p className="dt-run-err">{run.errorSummary}</p> : null}
          {/* A run only has a trace when it actually started. Offering "open the
              trace" for a skipped or queued run would open nothing. */}
          {run.executionRunId ? (
            <button
              type="button"
              className="btn"
              onClick={() => toast('Run traces open from AI Ops, which is company-admin only today.', 'error')}
            >
              Open the trace
            </button>
          ) : (
            <p className="dt-run-err">This attempt produced no trace.</p>
          )}
        </div>
      ) : null}
    </div>
  )
}

const STATUS_LABEL_RUN: Record<AutomationRunStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Finished',
  failed: 'Failed',
  cancelled: 'Cancelled',
  skipped: 'Skipped',
  blocked: 'Blocked',
}
