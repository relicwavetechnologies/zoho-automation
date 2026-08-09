/**
 * A member's settings, on one page.
 *
 * The workspace splits this across eight rail destinations — Profile,
 * Preferences, Connected apps, What Divo can do, Usage, Models, Skills, Memory.
 * Every one of them is either read-only for a member or about a part of Divo
 * they were not given, and together they said "this is a large system you are
 * a small part of" to somebody whose entire relationship with it is that their
 * invoices get forwarded.
 *
 * So: five facts about you, the mailbox, and how this app looks. Nothing here
 * is a control unless it does something.
 *
 * The Models, Skills and Memory pages are not hidden as a simplification — a
 * member cannot change any of the three. The model list is resolved by the
 * proxy from a grant on every call, skills are granted by an admin, and the
 * memory panel is sample data. Three read-only pages is not configuration, it
 * is a tour.
 */
import { useState } from 'react'
import { CircleAlert, Clock } from 'lucide-react'
import { useAdminAuth } from '@/auth/AdminAuthProvider'
import { useTheme } from '@/lib/use-theme'
import { GmailMark, LarkMark } from './brand'
import { MailboxSetup } from './screens-mail'
import { useMailAutomations, useMailboxOptions } from './data/use-mail-automations'
import { useMailBrief } from './data/use-mail-governance'
import { COMPANY_ROLE_LABEL, SettingsGroup, SettingsHead, SettingsRow, SettingsSection } from './screens-settings'
import { Avatar, Seg, SkelRows } from './ui'

/**
 * The mailbox, said once.
 *
 * `MailboxStrip` on the rules page answers "can anything run"; this answers
 * "which account is this". They read the same `health` array, so they cannot
 * disagree — and when there is no usable account at all, both defer to the same
 * `MailboxSetup` panel rather than writing a second version of the remedy.
 */
function Mailboxes() {
  const { mailboxes, loading, refresh } = useMailAutomations()
  const resolution = useMailboxOptions()

  if (loading || resolution.status === 'loading') return <SkelRows n={1} icon />

  // Nothing connected, connected without Gmail, or signed out by Google. All
  // three are the same panel with different words, and it is the one the rules
  // page uses.
  if (
    resolution.status === 'none'
    || resolution.status === 'insufficient'
    || resolution.status === 'reconnect'
  ) {
    return <MailboxSetup resolution={resolution} onDone={refresh} />
  }

  if (mailboxes.length === 0) {
    return (
      <SettingsRow
        label="No mailbox is being watched yet"
        description="Your Google account is connected. Divo starts watching when you create your first rule."
      />
    )
  }

  return (
    <>
      {mailboxes.map((box) => (
        <SettingsRow
          key={box.subscriptionId}
          label={box.mailboxEmail}
          // The health summary verbatim, not a re-description of it. The server
          // knows why a mailbox is not running and has already said so in a
          // sentence; paraphrasing it here is how two surfaces start disagreeing
          // about the same fault.
          description={box.summary}
        >
          <GmailMark size={16} />
          <span className={`badge ${box.rulesCanFire ? 'b-ok' : 'b-err'}`}>
            {box.rulesCanFire ? <span className="dot" /> : null}
            {box.rulesCanFire ? 'Watching' : 'Not running'}
          </span>
        </SettingsRow>
      ))}
      {/* Only when there is something the member can do about it. A remedy line
          under a healthy mailbox is an invitation to fix what is not broken. */}
      {mailboxes.some((b) => b.remedy) ? (
        <div className="set-note">
          <CircleAlert size={13} />
          {mailboxes.find((b) => b.remedy)?.remedy}
        </div>
      ) : null}
    </>
  )
}

/**
 * When the summary arrives, and whether it arrives at all.
 *
 * Three presets rather than a time picker. The choice a member actually makes
 * is *how often Divo interrupts me*, and a pair of clocks asks them to invent
 * an answer to a question they do not have — while making it possible to set
 * two briefs a minute apart. Off is a first-class option here: a standing
 * message twice a day that somebody cannot switch off is a thing they will
 * mute, which switches off everything else Divo sends them too.
 */
const CADENCES = [
  { id: 'twice', label: 'Twice a day', detail: '09:00 and 16:00', times: ['09:00', '16:00'] },
  { id: 'once', label: 'Once a day', detail: '09:00', times: ['09:00'] },
  { id: 'often', label: 'Every few hours', detail: '09:00, 13:00 and 17:00', times: ['09:00', '13:00', '17:00'] },
] as const

const WORKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR']

function BriefSection() {
  const { token } = useAdminAuth()
  const { brief, loading, error, save } = useMailBrief(token ?? undefined)
  const [saving, setSaving] = useState(false)

  if (loading) return <SkelRows n={1} icon />
  if (error) {
    return <SettingsRow label="Could not be read" description={error} />
  }
  if (!brief) {
    return (
      <SettingsRow
        label="Not set up yet"
        // Not an error and not a button. Divo creates this with the first rule,
        // so there is nothing for the member to do here except make a rule.
        description="Divo starts a brief once you have your first mail rule, and sends it to your Lark DM."
      />
    )
  }

  const paused = brief.status !== 'active'
  const current = CADENCES.find(
    (c) => c.times.length === brief.times.length
      && c.times.every((t, i) => t === brief.times[i]),
  )

  const apply = async (times: string[], nextPaused: boolean) => {
    setSaving(true)
    await save({ times, days: WORKDAYS, timeZone: brief.timeZone, paused: nextPaused })
    setSaving(false)
  }

  return (
    <>
      <SettingsRow
        label="How often"
        description={paused
          ? 'Switched off. Your rules keep running either way.'
          : `Workdays, ${brief.timeZone}. Sent to your Lark DM.`}
      >
        <Seg
          value={paused ? 'off' : current?.id ?? 'twice'}
          onChange={(v) => {
            void (v === 'off'
              ? apply(brief.times, true)
              : apply([...(CADENCES.find((c) => c.id === v)?.times ?? ['09:00', '16:00'])], false))
          }}
          options={[
            ...CADENCES.map((c) => ({ value: c.id, label: c.label })),
            { value: 'off', label: 'Off' },
          ]}
        />
      </SettingsRow>

      {/* The one fact that tells a member whether any of this took effect. A
          settings screen that saves silently is one nobody trusts twice. */}
      <SettingsRow
        label="Next one"
        description={brief.lastRunAt
          ? `Last sent ${new Date(brief.lastRunAt).toLocaleString()}`
          : 'None sent yet.'}
      >
        <span className="set-val">
          {saving
            ? 'Saving…'
            : paused || !brief.nextRunAt
              ? '—'
              : new Date(brief.nextRunAt).toLocaleString()}
        </span>
      </SettingsRow>

      <div className="set-note">
        <Clock size={13} />
        A brief covers what arrived since the last one, so nothing falls between two of them.
        It says what is waiting on you, and what your rules handled.
      </div>
    </>
  )
}

export function MailSettings() {
  const { session, logout } = useAdminAuth()
  const { theme, setTheme } = useTheme()

  return (
    <div className="set-col">
      <SettingsHead
        title="Settings"
        description="There is not much here, and that is deliberate."
      />

      <SettingsSection title="Profile" />
      <SettingsGroup>
        <SettingsRow label="Profile picture" description="How you are shown around Divo">
          {/* Initials, because Divo stores no photograph. Nothing in the schema
              holds an avatar and no route fetches one from Lark, so a slot for
              an image would permanently show its own fallback. */}
          <Avatar name={session?.name} email={session?.email} src={session?.avatarUrl} size={34} />
        </SettingsRow>
        <SettingsRow
          label="Company role"
          // Named as the ceiling rather than as the grant, because people read
          // this row as the answer to "why was I refused" and it is not.
          description="Your company-wide ceiling. What Divo may actually do for you is set per department."
        >
          <span className="set-val">{COMPANY_ROLE_LABEL[session?.role ?? ''] ?? session?.role ?? '—'}</span>
        </SettingsRow>
        {(session?.departments ?? []).map((dept) => (
          <SettingsRow
            key={dept.id}
            label={dept.name}
            description={dept.isManager
              ? 'You manage this department, so you can also grant what it may use.'
              : 'Your role here decides which tools Divo may use on your behalf.'}
          >
            <span className="set-val">{dept.roleName}</span>
          </SettingsRow>
        ))}
      </SettingsGroup>

      <SettingsSection title="Account" />
      <SettingsGroup>
        <SettingsRow label="Name">
          {/* Read-only everywhere in Divo: a member's name comes from the company
              directory and no route updates it, so an input would be a box that
              forgets what you typed. */}
          <span className="set-val">{session?.name ?? '—'}</span>
        </SettingsRow>
        <SettingsRow label="Email" description="Where Divo reaches you, and how you sign in">
          <span className="set-val">{session?.email ?? '—'}</span>
        </SettingsRow>
        <SettingsRow label="Company">
          <span className="set-val">{session?.companyName ?? '—'}</span>
        </SettingsRow>
        <SettingsRow
          label="Lark"
          description={session?.larkLinked
            ? 'Linked — what Divo sends you, and what you ask it, both resolve to this account'
            : 'Not linked. Divo cannot send you anything in Lark, and messages you send it there cannot be matched to this account.'}
        >
          <span className={`badge ${session?.larkLinked ? 'b-ok' : 'b-warn'}`}>
            <span className="dot" />{session?.larkLinked ? 'Linked' : 'Not linked'}
          </span>
        </SettingsRow>
      </SettingsGroup>

      <SettingsSection title="Mailbox" />
      <SettingsGroup><Mailboxes /></SettingsGroup>

      <SettingsSection title="Your brief" />
      <SettingsGroup><BriefSection /></SettingsGroup>

      <SettingsSection title="Appearance" />
      <SettingsGroup>
        <SettingsRow label="Theme" description="Follows your system unless you pick one">
          <Seg
            value={theme}
            onChange={(v) => setTheme(v as 'light' | 'dark' | 'system')}
            options={[
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
              { value: 'system', label: 'System' },
            ]}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsSection title="This device" />
      <SettingsGroup>
        <SettingsRow
          label="Sign out"
          description="On this device. Your rules keep running."
        >
          <button type="button" className="btn" onClick={() => logout()}>Sign out</button>
        </SettingsRow>
      </SettingsGroup>

      <div className="set-note">
        <LarkMark size={13} />
        One account across the web, Lark and the desktop — Divo answers to the same person in all three.
      </div>
    </div>
  )
}
