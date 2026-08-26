/**
 * The Workspace shell — the real one, driven by the authenticated session.
 *
 * This replaces AdminShell. Same structural idea as the mock: scope is
 * explicit (You / Your team / Company) and the nav reshapes beneath it, so a
 * person who is both an individual and a lead is never left guessing whether
 * "Connections" means theirs or their team's.
 *
 * Every scope now runs on real endpoints. /me/memory is the last panel still
 * running on fixtures, and it marks itself in the UI rather than relying on a
 * note here that goes stale the moment it is wired.
 *
 * Scope availability: one member session serves everybody, so Team appears for
 * whoever actually manages a department and Company for admins. Nothing is
 * shown as a preview any more.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  Activity, Building2, Check, ChevronsUpDown, CircleCheck, CircleDashed, FileClock,
  Grid2X2, LogOut, Mail, MessageSquare, Minus, Moon, MoreHorizontal, PanelLeft,
  PanelLeftClose, Pencil, Plus, Search, Settings, Sun, Trash2, Users, UserSquare,
  Waypoints, type LucideIcon,
} from 'lucide-react'
import { DivoMark } from '@/components/admin/divo-mark'
import { useAdminAuth } from '@/auth/AdminAuthProvider'
import { hasCapability } from '@/pages/workspace/data/capabilities'
import { notify } from '@/lib/notify'
import { useManagedDepartments } from '@/pages/workspace/data/use-team'
import { useOnboarding } from '@/pages/workspace/data/use-onboarding'
import {
  deleteThread, listThreads, onThreadsChanged, renameThread, startedThreads, THREAD_PAGE,
  withStartedThreads, type ThreadSummary,
} from '@/pages/workspace/chat/threads'
import { PixelGrid } from '@/pages/workspace/chat/loader'
import { Avatar, Confirm } from '@/pages/workspace/ui'
import { RAIL } from '@/components/admin/settings-shell'
import { RoleProvider } from '@/cursor/role-context'
import { useTheme } from '@/lib/use-theme'
import '@/styles/workspace.css'

type ScopeKind = 'you' | 'team' | 'company'
type NavItem = { to: string; label: string; icon: LucideIcon; end?: boolean }
type NavGroup = { label?: string; items: NavItem[] }

/*
 * The work surface, and only that.
 *
 * Everything a person *sets up* moved to the Settings takeover, which is why
 * this list is now short enough to read at a glance. It used to run to ten
 * rows for a member, most of them configuration they open once a quarter, and
 * the two things they actually came to do were lost among them.
 */
const NAV: Record<ScopeKind, NavGroup[]> = {
  you: [
    /*
     * No "Home" and no "Chat" row.
     *
     * Both named a place rather than a thing to do, and between them they said
     * the same thing twice: Home *is* the composer, so "Chat" went to the
     * surface you reach by typing in Home, and "Home" went to the page you are
     * returned to anyway. New chat above covers the whole of it — one control,
     * for the one thing this scope is for — and a conversation you have already
     * had is a row in Recent, which is where you would look for it.
     */
    /*
     * Mail with no heading over it.
     *
     * "Work" was a group of four. Approvals is answered in the thread that
     * asked, Automations had no route behind it, and Things Divo made stood in
     * front of a real feature with invented rows — so one row is left, and a
     * heading over one row reads as a mistake rather than as a grouping.
     *
     * Work, not configuration: a mail rule is Divo acting on your behalf every
     * hour of every day, and you come back to check it still is.
     */
    /*
     * Mail and Follow-ups, grouped now that there are two of them.
     *
     * Both are the same kind of thing and belong together: Divo watching a
     * stream you did not have to ask it to watch, and reporting what it found.
     * The heading that read as a mistake over one row reads as a grouping over
     * two.
     */
    {
      label: 'Watching',
      items: [
        { to: '/me/mail', label: 'Mail', icon: Mail },
        { to: '/me/follow-ups', label: 'Follow-ups', icon: MessageSquare },
      ],
    },
  ],
  team: [
    { label: 'Your team', items: [{ to: '/team', label: 'Overview', icon: Grid2X2, end: true }] },
  ],
  company: [
    {
      label: 'Company',
      items: [
        { to: '/home', label: 'Overview', icon: Grid2X2 },
        /* Watching the company is work. Governing it is configuration, and
           that half now lives behind Settings. */
        { to: '/ai-ops', label: 'AI Ops', icon: Activity },
      ],
    },
    {
      label: 'Operations',
      items: [
        /* The permission matrix already exists in Settings. This is the same
           truth asked the other way round — not "who holds this grant" but
           "what happens when this person asks Divo for something". */
        { to: '/agents', label: 'Agents', icon: Waypoints },
        { to: '/activity', label: 'Activity', icon: FileClock },
      ],
    },
  ],
}

/*
 * Which scope a path belongs to.
 *
 * `/` is the You scope and has to be tested for exactly, not by prefix — every
 * path in the app starts with it, so `startsWith('/')` would answer "you" for
 * the company audit log. It reads as a special case because it is one: Home
 * moved up to the root and the root is not a prefix of anything.
 */
const scopeOfPath = (pathname: string): ScopeKind =>
  pathname === '/' || pathname.startsWith('/me') || pathname.startsWith('/chat')
    ? 'you'
    : pathname.startsWith('/team') ? 'team' : 'company'

const HOME: Record<ScopeKind, string> = { you: '/', team: '/team', company: '/home' }

export function WorkspaceShell() {
  const { session, scopes, logout } = useAdminAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const { resolved, setTheme } = useTheme()
  const [scopeOpen, setScopeOpen] = useState(false)
  const [palette, setPalette] = useState(false)
  /*
   * Two ways for the rail to be absent, because they are two different things.
   *
   * `drawerOpen` is the narrow-screen sheet: it floats over the page, so it has
   * to shut on the way out — after a navigation, or on Escape. `railHidden` is
   * the desktop preference, where the rail is a column of the layout and hiding
   * it gives the width to the page. Sharing one flag meant either the drawer
   * outstayed its click or every navigation quietly took a desktop reader's
   * sidebar away. The one control drives both, so nothing here has to ask how
   * wide the window is — that breakpoint stays in the stylesheet.
   */
  const [drawerOpen, setDrawerOpen] = useState(false)
  // Remembered, unlike the drawer. Hiding the rail is deliberate — you did it to
  // get the room back — and handing it back on every reload undoes the request.
  const [railHidden, setRailHidden] = useState(
    () => window.localStorage.getItem('divo.sidebar.hidden') === '1',
  )
  const scopeRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const hideRail = useCallback((hidden: boolean) => {
    setRailHidden(hidden)
    try { window.localStorage.setItem('divo.sidebar.hidden', hidden ? '1' : '0') } catch { /* private mode */ }
  }, [])

  const showNav = useCallback(() => { hideRail(false); setDrawerOpen(true) }, [hideRail])
  const closeNav = useCallback(() => { hideRail(true); setDrawerOpen(false) }, [hideRail])

  // Land at the top of a new screen. Without this the router keeps the previous
  // page's offset, so a short page opens scrolled past its own header.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
    setDrawerOpen(false)
  }, [location.pathname])

  const scope = scopeOfPath(location.pathname)
  const capabilities = (session as unknown as { capabilities?: Record<string, readonly string[]> | null })?.capabilities ?? null
  const groups = useMemo(() => {
    const raw = NAV[scope]
    if (scope !== 'you') return raw
    return raw
      .map(g => {
        if (g.label !== 'Watching') return g
        const items = g.items.filter(item => {
          if (item.label === 'Mail') return hasCapability(capabilities, 'mail')
          if (item.label === 'Follow-ups') return hasCapability(capabilities, 'followUps')
          return true
        })
        return { ...g, items }
      })
      .filter(g => g.items.length > 0)
  }, [scope, capabilities])

  // Scopes come from the session now — a Team scope appears only when this
  // person actually leads a department, and Company only when their live
  // membership is admin. The old list showed all three to everyone and labelled
  // Team a "preview", which meant the switcher advertised a place to go that
  // had no data and no right to any.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((v) => !v) }
      if (e.key === '/' && !isEditableTarget(e.target)) { e.preventDefault(); setPalette(true) }
      // The shortcut every editor with a side panel uses for this.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); hideRail(!railHidden) }
      if (e.key === 'Escape') setDrawerOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hideRail, railHidden])

  useEffect(() => {
    if (!scopeOpen) return
    const onDown = (e: MouseEvent) => {
      if (scopeRef.current && !scopeRef.current.contains(e.target as Node)) setScopeOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [scopeOpen])

  // Which team the Team scope is about. A person can lead several, and every
  // Team entry in this menu points at the same `/team` — the department is
  // carried in the remembered selection instead, so the label has to follow it
  // rather than always naming the first.
  const managed = useManagedDepartments()
  const active = scopes.find((s) => (
    s.kind === scope && (s.kind !== 'team' || s.departmentId === managed.department?.id)
  )) ?? scopes.find((s) => s.kind === scope) ?? scopes[0]
  /*
   * Everywhere this person can go, both surfaces.
   *
   * The palette used to list the current scope's nav and nothing else. Now that
   * configuration lives behind Settings, that would be three rows — so it spans
   * both shells, filtered to the scopes the session actually holds. The same
   * filter the rail uses, for the same reason: never offer a door that will be
   * shut in your face.
   */
  const paletteItems = useMemo(() => {
    const held = new Set(scopes.map((s) => s.kind))
    return [
      ...Object.values(NAV).flat().flatMap((g) => g.items),
      ...RAIL.filter((g) => held.has(g.scope)).flatMap((g) => g.items),
    ]
      .filter((item, i, all) => all.findIndex((x) => x.to === item.to) === i)
      .filter(item => {
        if (item.to === '/me/mail') return hasCapability(capabilities, 'mail')
        if (item.to === '/me/follow-ups') return hasCapability(capabilities, 'followUps')
        return true
      })
  }, [scopes, capabilities])

  return (
    <RoleProvider>
      <div
        className="cur app workspace-app"
        data-drawer-open={drawerOpen ? 'true' : 'false'}
        data-rail={railHidden ? 'hidden' : 'shown'}
      >
        <button
          type="button"
          className="ws-sidebar-backdrop"
          aria-label="Close navigation"
          onClick={() => setDrawerOpen(false)}
        />

        <aside className="sidebar workspace-sidebar" id="workspace-navigation" aria-label="Workspace navigation">
          {/*
            No separate brand row. The reference folds identity into the
            workspace switcher — one row that says both who you are and which
            workspace you are in — and a "Divo" wordmark above a scope selector
            was two rows saying nearly the same thing. The mark lives inside the
            switcher now.
          */}
          <div className="ws-scope ws-workspace" ref={scopeRef}>
            <button
              type="button"
              className={`ws-scope-btn${scopeOpen ? ' open' : ''}`}
              data-static={scopes.length === 1}
              onClick={scopes.length === 1 ? undefined : () => setScopeOpen((v) => !v)}
            >
              {/*
                Your own face on your own workspace.

                Only on the `you` scope: this row reads "<name>'s workspace"
                there, so the picture and the words say the same thing. On team
                and company it would be wrong — those are not yours, and a
                personal photo beside "RelicWave" claims something about who
                owns it. Those keep the mark.

                `Avatar` already falls back to initials when Lark gave us no
                picture, and again if the URL 404s — Lark's avatar links expire,
                and a broken image where a face should be reads as a fault in
                Divo rather than a link that aged out.
              */}
              {active?.kind === 'you' && session?.avatarUrl ? (
                <Avatar name={session.name} email={session.email} src={session.avatarUrl} size={32} />
              ) : (
                <span className="ws-scope-ic" data-tone="brand">
                  <DivoMark size={15} />
                </span>
              )}
              <span className="ws-scope-txt">
                <b>{active.label}</b>
                <span>{active.detail}</span>
              </span>
              {scopes.length > 1 ? <ChevronsUpDown size={13} className="muted" /> : null}
            </button>

            {/*
              The way out, on the row it belongs to.

              The rail had no way to close on a desktop at all — only the narrow
              layout got a control, so on the screen where 240px of chrome is
              worth reclaiming it was the one place you could not. It sits beside
              the identity row rather than at the foot because that is the corner
              the eye goes to for "put this panel away", and the row was already
              built to share its width with a second button.
            */}
            <button
              type="button"
              className="ws-rail-hide"
              aria-controls="workspace-navigation"
              aria-label="Hide sidebar"
              title="Hide sidebar (⌘B)"
              onClick={closeNav}
            >
              <PanelLeftClose size={15} />
            </button>

            {scopeOpen && scopes.length > 1 ? (
              <div className="ws-scope-menu">
                {scopes.map((s) => {
                  const Icon = s.kind === 'you' ? UserSquare : s.kind === 'team' ? Users : Building2
                  // Keyed by department too. Two led departments produce two
                  // Team scopes, and keying on `kind` alone gave React duplicate
                  // keys and the reader two identical-looking rows.
                  const current = s.kind === scope
                    && (s.kind !== 'team' || s.departmentId === managed.department?.id)
                  return (
                    <button
                      type="button"
                      key={`${s.kind}:${s.departmentId ?? ''}`}
                      className="ws-scope-opt"
                      onClick={() => {
                        setScopeOpen(false)
                        if (s.kind === 'team' && s.departmentId) managed.select(s.departmentId)
                        navigate(HOME[s.kind])
                      }}
                    >
                      <span className="ws-scope-ic"><Icon size={13} /></span>
                      <span className="ws-scope-txt"><b>{s.label}</b><span>{s.detail}</span></span>
                      {current ? <Check size={14} className="ck" /> : null}
                    </button>
                  )
                })}
              </div>
            ) : null}
          </div>

          <button type="button" className="ws-quick-search" onClick={() => setPalette(true)}>
            <Search size={13} />
            <span>Quick search</span>
            <kbd>/</kbd>
          </button>

          {/* Home, because Home is the composer — landing on the empty chat
              screen asked you to start over on a page with nothing on it. */}
          <button type="button" className="ws-new-chat" onClick={() => navigate('/')}>
            <span>New chat</span>
            <span className="ws-new-chat-plus" aria-hidden="true"><Plus size={10} /></span>
          </button>

          <WorkspaceNav groups={groups} pathname={location.pathname} />

          {/* Personal to whoever is signed in, so they belong to the You scope
              and nowhere else — a manager reading their team's page does not
              want their own half-finished setup in the corner of it. */}
          {scope === 'you' ? (
            <>
              <RecentChats />
              <GettingStarted onGo={(to) => navigate(to)} />
            </>
          ) : null}

          {/*
            Bottom rail, as in the reference: quiet rows rather than a boxed
            account card. Appearance sits here because there is no Settings
            takeover to hold it yet — when that page lands it moves inside and
            this row goes away.
          */}
          <div className="sidebar-foot">
            <NavLink to="/settings/profile" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
              <span className="g"><Settings size={16} /></span>
              Settings
            </NavLink>
            <button
              type="button"
              className="nav-item"
              onClick={() => setTheme(resolved === 'dark' ? 'light' : 'dark')}
            >
              <span className="g">{resolved === 'dark' ? <Sun size={16} /> : <Moon size={16} />}</span>
              {resolved === 'dark' ? 'Light mode' : 'Dark mode'}
            </button>
            {/* No name trailing this row. The switcher at the top already reads
                "<first name>'s workspace", so repeating it here only crowded a
                row that is one word wide. */}
            <button type="button" className="nav-item" onClick={() => logout()}>
              <span className="g"><LogOut size={16} /></span>
              Sign out
            </button>
          </div>
        </aside>

        <div className="shell">
          {/* The same control read the other way: on a narrow screen it slides
              the sheet in, on a wide one it gives the column back. Which of the
              two happens is the stylesheet's business, so this asks for both. */}
          <button
            type="button"
            className="ws-sidebar-trigger"
            aria-controls="workspace-navigation"
            aria-expanded={false}
            aria-label="Show sidebar"
            title="Show sidebar (⌘B)"
            onClick={showNav}
          >
            <PanelLeft size={16} />
          </button>
          {/*
            The reference has no top chrome — a page begins with its own title
            and nothing else. Search moved to the Recent header and appearance
            to the sidebar foot, so nothing was lost; the bell went with them
            because it had no handler and never had one.

            A chat has no bar at all. It carries its own header naming the
            conversation, and a second one above it named the *page* — which on
            `/chat/web_…` matched no nav item and fell through to the workspace
            name, so the one thing on screen the reader could not have wanted
            was the only thing it said.

            Home is the same case for the same reason. Its first screen is a
            greeting and a composer; "Home" above that is a second title, and a
            duller one. Only the landing itself — everything under `/me/…` is an
            ordinary page and keeps its name.
          */}
          {location.pathname.startsWith('/chat') || location.pathname === '/' ? null : (
            <header className="topbar">
              <b className="ws-crumb-now">
                {groups.flatMap((g) => g.items).find((i) => i.to === location.pathname)?.label ?? active.label}
              </b>
            </header>
          )}

          <div className="content">
            <div className="scroll" ref={scrollRef}>
              <Outlet />
            </div>
          </div>
        </div>

        {palette ? (
          <Palette
            items={paletteItems}
            onClose={() => setPalette(false)}
            onPick={(to) => { navigate(to); setPalette(false) }}
          />
        ) : null}
      </div>
    </RoleProvider>
  )
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

function navItemIsActive(item: NavItem, pathname: string): boolean {
  if (item.end) return pathname === item.to
  return pathname === item.to || pathname.startsWith(`${item.to}/`)
}

/**
 * The reference's moving selection surface, with the router as its authority.
 *
 * Hover can borrow the surface, but leaving the rail always returns it to the
 * current route. Keeping the box outside the links means the text and icons do
 * not move, and route semantics remain ordinary anchors (including new-tab and
 * middle-click behaviour).
 */
function WorkspaceNav({ groups, pathname }: { groups: NavGroup[]; pathname: string }) {
  const [hovered, setHovered] = useState<string | null>(null)
  const [box, setBox] = useState<{ top: number; height: number } | null>(null)
  const navRef = useRef<HTMLElement>(null)
  const itemRefs = useRef<Record<string, HTMLAnchorElement | null>>({})
  const active = groups.flatMap((group) => group.items).find((item) => navItemIsActive(item, pathname))

  useLayoutEffect(() => {
    const container = navRef.current
    const target = itemRefs.current[hovered ?? active?.to ?? '']
    if (!container || !target) {
      setBox(null)
      return
    }

    const containerRect = container.getBoundingClientRect()
    const targetRect = target.getBoundingClientRect()
    setBox({ top: targetRect.top - containerRect.top, height: targetRect.height })
  }, [active?.to, groups, hovered])

  return (
    <nav
      ref={navRef}
      className="ws-nav ws-nav-reference"
      onMouseLeave={() => setHovered(null)}
    >
      <span
        aria-hidden="true"
        className="ws-nav-highlight"
        style={{
          top: box?.top ?? 0,
          height: box?.height ?? 0,
          opacity: box ? 1 : 0,
        }}
      />
      {groups.map((group) => (
        <div className="ws-nav-group" key={group.label ?? group.items[0]?.to}>
          {group.label ? <div className="nav-label">{group.label}</div> : null}
          <div className="ws-nav-items">
            {group.items.map((item) => {
              const selected = navItemIsActive(item, pathname)
              return (
                <NavLink
                  key={item.to}
                  ref={(node) => { itemRefs.current[item.to] = node }}
                  to={item.to}
                  end={item.end}
                  aria-current={selected ? 'page' : undefined}
                  onMouseEnter={() => setHovered(item.to)}
                  onFocus={() => setHovered(item.to)}
                  onBlur={() => setHovered(null)}
                  className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
                >
                  <span className="g"><item.icon size={14} /></span>
                  <span className="ws-nav-text">{item.label}</span>
                </NavLink>
              )
            })}
          </div>
        </div>
      ))}
    </nav>
  )
}

/**
 * "16h", not "16 hours ago".
 *
 * The rail's own second line, under a title it belongs to — there is no
 * sentence for the long form to complete, and at five entries the words were
 * wider than the run names above them. `ago()` stays for the pages, where a row
 * is read rather than scanned.
 */
function shortAgo(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000))
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d`
  return `${Math.round(days / 7)}w`
}

/**
 * Recent chats, in the sidebar.
 *
 * This was a list of recent *runs*, and every row on it said "Asked in Lark" and
 * opened the same activity page — five identical labels pointing at one
 * destination, which is a placeholder wearing a list's clothes. What a person
 * wants from this corner of the screen is the conversation they were in ten
 * minutes ago, so that is what is here, and a row goes to that conversation.
 *
 * It re-reads on `onThreadsChanged`, because the two moments this list goes
 * stale — a new thread taking its name from its first answer, and a deleted one
 * going away — both happen without the route changing.
 */
function RecentChats() {
  const { token } = useAdminAuth()
  const [chats, setChats] = useState<ThreadSummary[]>([])
  const [hasMore, setHasMore] = useState(false)
  /* How much of the list the reader has asked to see, in chats. Grows a page at
     a time and never shrinks, so a refresh redraws the window they are looking
     at rather than collapsing it back to the first page under them. */
  const [shown, setShown] = useState(THREAD_PAGE)
  /* The last list the server gave, kept so a claim can be drawn over it without
     waiting for a fresh one. */
  const known = useRef<ThreadSummary[]>([])

  const refresh = useCallback(() => {
    /* Drawn in two passes, and the first one is the point. A chat that has just
       been asked for is painted from the browser's own claim on this frame; the
       server's list follows a round trip later and replaces it. Waiting for the
       fetch left a gap of a second or two after pressing Enter where the rail
       said nothing had happened — which is exactly when somebody looks at it.

       With no claim to add there is nothing to paint early, and painting anyway
       is actively wrong: a run ending drops its claim and then refreshes, so the
       first pass would remove the row and the second would put it back a fetch
       later. The chat would blink out of the rail at the moment it finished. */
    const claims = startedThreads()
    if (claims.length > 0) setChats(withStartedThreads(known.current, claims))
    if (!token) return
    void listThreads(token, shown).then((page) => {
      known.current = page.threads
      setChats(withStartedThreads(page.threads, startedThreads()))
      setHasMore(page.hasMore)
    })
  }, [token, shown])

  useEffect(() => {
    refresh()
    return onThreadsChanged(refresh)
  }, [refresh])

  // Nothing at all is not worth a heading. A person who has never asked Divo
  // anything is served by the Getting started card below, not by an empty list.
  if (chats.length === 0) return null

  return (
    <div className="ws-recent">
      <div className="ws-recent-hd">
        <span className="nav-label">Recent</span>
      </div>
      {chats.map((chat) => (
        <ChatRow key={chat.threadId} chat={chat} token={token} onChanged={refresh} />
      ))}
      {/* Only when the server says there is something behind the window. A
          control that is always there is a promise the list cannot keep. */}
      {hasMore && (
        <button
          type="button"
          className="ws-recent-expand"
          onClick={() => setShown((seen) => seen + THREAD_PAGE)}
        >
          Show more
        </button>
      )}
    </div>
  )
}

/**
 * One chat in the rail, and the two things you can do to it.
 *
 * The controls are here rather than inside the conversation because that is
 * where they are about something. A Delete button in the chat's own header sat
 * beside no other action, applied to the page it was drawn on, and was the
 * loudest thing on an otherwise empty screen — the reader saw an offer to throw
 * their work away before they saw their work.
 *
 * Kept behind a `⋯` and revealed on hover: a rail of chats is scanned, not
 * operated, and a destructive control on every row at rest is a rail you read
 * carefully instead of quickly.
 */
function ChatRow({
  chat, token, onChanged,
}: {
  chat: ThreadSummary
  token: string | null
  onChanged: () => void
}) {
  const navigate = useNavigate()
  const location = useLocation()
  const [menu, setMenu] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [title, setTitle] = useState(chat.title)
  const row = useRef<HTMLDivElement>(null)

  /* A menu that outlives the click that opened it has to be closeable by every
     gesture that means "not that" — elsewhere, and Escape. */
  useEffect(() => {
    if (!menu) return
    const away = (event: MouseEvent) => {
      if (!row.current?.contains(event.target as Node)) setMenu(false)
    }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(false) }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', key)
    }
  }, [menu])

  const commitRename = async () => {
    setRenaming(false)
    const next = title.trim()
    if (!token || !next || next === chat.title) {
      setTitle(chat.title)
      return
    }
    if (await renameThread(chat.threadId, next, token)) onChanged()
    else { setTitle(chat.title); notify.failed('Could not rename that chat.') }
  }

  /*
   * The app's own dialog, not the browser's.
   *
   * `window.confirm` was the one place the workspace handed a decision back to
   * Chrome: unthemed, unstyled, stamped with "localhost:5173 says", and blocking
   * the whole tab while it sat there. It also froze every other surface — the
   * rail could not refresh and a running chat could not stream — because a
   * native confirm halts the event loop until it is answered.
   */
  const remove = async () => {
    if (!token) return
    if (!await deleteThread(chat.threadId, token)) {
      notify.failed('Could not delete that chat.')
      return
    }
    notify.done('Chat deleted.')
    onChanged()
    // Leaving a reader inside a conversation that no longer exists would show
    // them an empty thread under a name that is gone. Home rather than the bare
    // chat screen: it is where a new question is asked, and it is the same place
    // New chat goes.
    if (location.pathname === `/chat/${chat.threadId}`) navigate('/', { replace: true })
  }

  return (
    <div className="ws-recent-row" ref={row}>
      {renaming ? (
        <input
          className="ws-recent-rename"
          value={title}
          autoFocus
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => void commitRename()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void commitRename()
            if (e.key === 'Escape') { setTitle(chat.title); setRenaming(false) }
          }}
        />
      ) : (
        <NavLink
          to={`/chat/${chat.threadId}`}
          className={({ isActive }) => `ws-recent-item${isActive ? ' active' : ''}`}
        >
          {/*
            The loader leads the row, in front of the name.
            It sat next to the time, at the far end of a truncated title, which
            put the one moving thing on the rail at the point the eye reaches
            last — and wedged between an ellipsis and a word, where it read as
            punctuation. At the head of the row it is the first thing seen, and
            it marks the chat rather than annotating its timestamp.
          */}
          <span className="ws-recent-head">
            {chat.running && <PixelGrid pattern="orbit" />}
            <b>{chat.title}</b>
          </span>
          {/*
            The age, and nothing else.

            A status dot sat here first, on the theory that "22h" reads the same
            whether Divo is still working in there or finished hours ago. But a
            working row says "Working", and a finished one has no status worth
            reporting — every dot on the rail was green, on every row, forever,
            which is a decoration that looks like information.
          */}
          <span className="ws-recent-meta">
            {chat.running ? 'Working' : shortAgo(chat.updatedAt)}
          </span>
        </NavLink>
      )}

      {!renaming && (
        <button
          type="button"
          className="ws-recent-more"
          aria-expanded={menu}
          aria-label={`Options for ${chat.title}`}
          onClick={(e) => { e.preventDefault(); setMenu((open) => !open) }}
        >
          <MoreHorizontal size={14} />
        </button>
      )}

      {menu && (
        <div className="ws-recent-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => { setMenu(false); setTitle(chat.title); setRenaming(true) }}
          >
            <Pencil size={13} /> Rename
          </button>
          <button
            type="button"
            role="menuitem"
            data-danger
            onClick={() => { setMenu(false); setConfirming(true) }}
          >
            <Trash2 size={13} /> Delete
          </button>
        </div>
      )}

      {confirming && (
        <Confirm
          title={`Delete "${chat.title}"?`}
          body="The whole conversation goes with it. This cannot be undone."
          confirm="Delete"
          onConfirm={remove}
          onClose={() => setConfirming(false)}
        />
      )}
    </div>
  )
}

/**
 * Onboarding progress.
 *
 * Retires itself the moment every step is done rather than sitting at 100%
 * forever, and can be collapsed before then. Both are remembered locally —
 * nothing on the backend stores either.
 */
function GettingStarted({ onGo }: { onGo: (to: string) => void }) {
  const { steps, percent, complete, loading } = useOnboarding()
  const [collapsed, setCollapsed] = useState(
    () => window.localStorage.getItem('divo.onboarding.collapsed') === '1',
  )

  const toggle = () => {
    setCollapsed((v) => {
      const next = !v
      try { window.localStorage.setItem('divo.onboarding.collapsed', next ? '1' : '0') } catch { /* private mode */ }
      return next
    })
  }

  if (loading || complete) return null

  return (
    <div className="ws-onb">
      <div className="ws-onb-hd">
        <b>Getting started</b>
        <button
          type="button"
          className="ws-onb-tog"
          onClick={toggle}
          aria-label={collapsed ? 'Expand getting started' : 'Collapse getting started'}
        >
          {collapsed ? <Plus size={14} /> : <Minus size={14} />}
        </button>
      </div>
      <div className="ws-onb-prog">
        <div className="ws-onb-bar"><i style={{ width: `${percent}%` }} /></div>
        <span>{percent}%</span>
      </div>
      {collapsed ? null : (
        <div className="ws-onb-list">
          {steps.map((step) => (
            <div className="ws-onb-li" data-done={step.done ? 'true' : 'false'} key={step.id}>
              {/* Dashed for "not yet", solid for done — the reference's own
                  distinction, and a clearer one than two shades of one ring. */}
              {step.done ? <CircleCheck size={15} /> : <CircleDashed size={15} />}
              {step.to && !step.done ? (
                <button type="button" className="ws-onb-go" onClick={() => onGo(step.to!)}>{step.label}</button>
              ) : (
                <span>{step.label}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Palette({ items, onClose, onPick }: {
  items: NavItem[]; onClose: () => void; onPick: (to: string) => void
}) {
  const [q, setQ] = useState('')
  const [cursor, setCursor] = useState(0)
  const results = useMemo(() => items.filter((i) => i.label.toLowerCase().includes(q.toLowerCase())), [items, q])

  useEffect(() => setCursor(0), [q])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(c + 1, results.length - 1)) }
      if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)) }
      if (e.key === 'Enter' && results[cursor]) onPick(results[cursor].to)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [results, cursor, onClose, onPick])

  return (
    <div className="ws-pal-wrap">
      <div className="ws-scrim" onClick={onClose} />
      <div className="ws-pal">
        <div className="ws-pal-in">
          <Search size={15} className="muted" />
          {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Go to…" />
          <span className="ws-kbd">esc</span>
        </div>
        <div className="ws-pal-l">
          {results.length === 0 ? (
            <div className="ws-pal-empty">Nothing matches “{q}”</div>
          ) : (
            results.map((r, i) => (
              <button
                type="button"
                key={r.to}
                className={`ws-pal-i${i === cursor ? ' on' : ''}`}
                onMouseEnter={() => setCursor(i)}
                onClick={() => onPick(r.to)}
              >
                <r.icon size={15} className="muted" />
                {r.label}
                {i === cursor ? <span className="sc">↵</span> : null}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
