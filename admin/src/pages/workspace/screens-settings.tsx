/**
 * Account settings, split the way the reference splits them.
 *
 * `YouSettings` was one page holding profile, model and appearance. The rail
 * gives each its own destination, which is the point of a takeover — a person
 * looking for the theme should not have to scroll past their own department
 * memberships to reach it.
 *
 * Nothing new is read here. Same `session`, same `useMyModelOptions`, same
 * `useTheme` the sidebar toggle uses, and the same honest note about why the
 * model list cannot be changed from this screen.
 */
import { Check, CircleAlert } from 'lucide-react'
import { useAdminAuth } from '@/auth/AdminAuthProvider'
import { useTheme } from '@/lib/use-theme'
import { useMyModelOptions } from './data/use-my-activity'
import { Avatar, Empty, Seg, SkelRows } from './ui'

export const COMPANY_ROLE_LABEL: Record<string, string> = {
  MEMBER: 'Member',
  COMPANY_ADMIN: 'Company admin',
  SUPER_ADMIN: 'Super admin',
}

/* ── Settings furniture ───────────────────────────────
   A settings page is a list of statements with a control beside each. These
   three primitives are the whole vocabulary; anything more elaborate belongs
   on a page of its own rather than in a row. */

export function SettingsHead({ title, description }: { title: string; description?: string }) {
  return (
    <div className="set-h">
      <h1>{title}</h1>
      {description ? <p>{description}</p> : null}
    </div>
  )
}

export function SettingsRow({
  label, description, children,
}: { label: string; description?: string; children?: React.ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-row-t">
        <b>{label}</b>
        {description ? <span>{description}</span> : null}
      </div>
      {children ? <div className="set-row-c">{children}</div> : null}
    </div>
  )
}

/**
 * A section label above a group.
 *
 * Distinct from `SettingsHead`, which is the page's one title. Reusing the
 * title for every section drew four 26px headings down a page whose content is
 * a list of one-line statements — nothing on it was more important than
 * anything else, and it read as four pages stacked.
 */
export function SettingsSection({ title }: { title: string }) {
  return <h2 className="set-section">{title}</h2>
}

/**
 * The card a group of rows sits in.
 *
 * Rows used to sit on the page with a hairline above each, so a group was only
 * implied by the gap around it and a row belonged to whichever heading it
 * happened to follow. A border makes the grouping the thing you see first.
 */
export function SettingsGroup({ children }: { children: React.ReactNode }) {
  return <div className="set-group">{children}</div>
}

/** A rule between groups of rows, as the reference draws between sections. */
export const SettingsGap = () => <div className="set-gap" />

/* ── Screens ─────────────────────────────────────────── */

export function SettingsProfile() {
  const { session } = useAdminAuth()

  return (
    <>
      <SettingsHead title="Profile" description="How you appear across the web app, Lark and the desktop." />

      {/* First row, because the page is called Profile and this is the part of
          it people look for. It was absent entirely — so somebody who signed in
          through Lark, which is when Divo stores their picture, had nowhere on
          this screen that could show it. Falls back to initials on its own. */}
      <SettingsRow label="Profile picture" description="How you are shown around Divo">
        <Avatar name={session?.name} email={session?.email} src={session?.avatarUrl} size={34} />
      </SettingsRow>
      <SettingsRow label="Full name" description="Your display name">
        {/* Read-only, and that is not an oversight. No route updates a member's
            own name — it comes from the directory — so an editable field here
            would be a text box that forgets what you typed. */}
        <span className="set-val">{session?.name ?? '—'}</span>
      </SettingsRow>
      <SettingsRow label="Email" description="Where Divo reaches you, and how you sign in">
        <span className="set-val">{session?.email ?? '—'}</span>
      </SettingsRow>
      <SettingsRow label="Role" description="Your company-wide ceiling">
        <span className="set-val">{COMPANY_ROLE_LABEL[session?.role ?? ''] ?? session?.role ?? '—'}</span>
      </SettingsRow>
      <SettingsRow label="Company">
        <span className="set-val">{session?.companyName ?? '—'}</span>
      </SettingsRow>
      {/* Departments decide what Divo may do; the company role alone grants
          nothing, which is the part people get wrong. */}
      <SettingsRow
        label={(session?.departments.length ?? 0) === 1 ? 'Department' : 'Departments'}
        description="These decide what Divo may actually do for you — your company role alone grants nothing"
      >
        <span className="set-val">
          {session?.departments.length
            ? session.departments.map((d) => `${d.name} · ${d.roleName}`).join(', ')
            : 'None'}
        </span>
      </SettingsRow>

      <SettingsGap />

      <SettingsRow
        label="Lark"
        description={session?.larkLinked
          ? 'Linked — messages you send Divo in Lark resolve to this account'
          : 'Not linked. Until you link it once, your Lark messages cannot be matched to this account.'}
      >
        <span className={`badge ${session?.larkLinked ? 'b-ok' : 'b-warn'}`}>
          <span className="dot" />{session?.larkLinked ? 'Linked' : 'Not linked'}
        </span>
      </SettingsRow>

      <div className="set-note">
        <CircleAlert size={13} />
        One account across the web, Lark and the desktop — change it and it changes everywhere.
      </div>
    </>
  )
}

export function SettingsPreferences() {
  const { theme, setTheme } = useTheme()

  return (
    <>
      <SettingsHead title="Preferences" description="How this app looks and behaves for you." />

      <SettingsRow label="Theme" description="Follows your system unless you pick one">
        {/* No toast: the whole window changing colour is the confirmation, and
            it is a better one than a message saying it happened. */}
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

      {/* A "Notify me when work needs me" switch sat on the old page. Nothing
          was behind it — no preference was stored and no notification is sent
          from anywhere — so it was a switch whose only effect was to look like
          it had one. It comes back when there is something to turn on.
          Approvals already reach people in Lark. */}
    </>
  )
}

export function SettingsModels() {
  const { allowedModels, loading } = useMyModelOptions()

  return (
    <>
      <SettingsHead title="Models" description="Which models Divo may use when it works for you." />

      {loading ? <SkelRows n={2} icon={false} /> : allowedModels.length === 0 ? (
        // Reached both when every model is switched off and when the read
        // failed, and the hook cannot currently tell them apart — so the
        // sentence stops short of blaming an admin.
        <Empty title="No model is listed for you" body="Divo will fall back to its default until this says otherwise." />
      ) : (
        <>
          {/* Only what the proxy will actually accept for this person. Showing a
              model it refuses would turn a settings screen into a way to break
              your own next task. */}
          {allowedModels.map((m) => (
            <SettingsRow key={m.id} label={m.label} description={`${m.id}${m.vision ? ' · reads images' : ''}`}>
              <span className="badge b-ok"><span className="dot" />Allowed</span>
            </SettingsRow>
          ))}
        </>
      )}

      <div className="set-note">
        <Check size={13} />
        {/*
          The list is read-only, and that is not a shortcut. No route stores a
          member's model preference — the proxy resolves it from the grant on
          every call. This panel used to render each model as a clickable row
          that toasted "Switched to Pro", which persisted nothing and left no
          model marked as current.
        */}
        Your admin decides which models you may use, and Divo picks the best one you are allowed for each
        task — there is nothing to choose here.
      </div>
    </>
  )
}
