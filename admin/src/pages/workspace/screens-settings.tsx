/**
 * The furniture every settings screen is built from, and the two small screens
 * that are nothing but furniture.
 *
 * `YouSettings` was one page holding profile, model and appearance. The rail
 * gives each its own destination, which is the point of a takeover — a person
 * looking for the theme should not have to scroll past their own department
 * memberships to reach it. Profile outgrew this file and lives in
 * `screens-profile.tsx`; it still builds its lower half from the primitives
 * here, so a row means the same thing on every screen in the takeover.
 *
 * Nothing new is read here. Same `useMyModelOptions`, same `useTheme` the
 * sidebar toggle uses, and the same honest note about why the model list cannot
 * be changed from this screen.
 */
import { Check } from 'lucide-react'
import { useTheme } from '@/lib/use-theme'
import { useMyModelOptions } from './data/use-my-activity'
import { Empty, Seg, SkelRows } from './ui'

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

/* ── Screens ─────────────────────────────────────────── */

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
