import { useMemo, useState, type ComponentType } from "react"
import { Link } from "react-router-dom"
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BarChart3,
  Bell,
  BookOpen,
  Building2,
  Check,
  ChevronRight,
  CircleDot,
  CircleHelp,
  Cloud,
  CreditCard,
  Database,
  Diamond,
  Download,
  Gauge,
  Globe2,
  Grid2X2,
  KeyRound,
  Library,
  Link2,
  ListFilter,
  LockKeyhole,
  Mail,
  Menu,
  MoreHorizontal,
  PlugZap,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Table2,
  Trash2,
  UserPlus,
  Users,
  WandSparkles,
  X,
} from "lucide-react"
import "@/styles/mock-dashboard.css"

type Role = "member" | "manager" | "admin"
type Screen = "home" | "connections" | "access" | "skills" | "usage" | "people" | "security"
type ConnectionState = "connected" | "available" | "managed" | "attention"
type Icon = ComponentType<{ size?: string | number; className?: string }>

type NavItem = {
  id: Screen
  label: string
  icon: Icon
}

type Tool = {
  id: string
  name: string
  description: string
  icon: Icon
  actions: string
  approval: string
  status: "Ready" | "Connection needed" | "Limited"
  coverage: Record<Role, string>
  source: string
  capabilities: { name: string; description: string; status?: "Ready" | "Connection needed" | "Built in" }[]
}

type Skill = {
  id: string
  name: string
  description: string
  owner: string
  scope: "Private" | "Finance" | "Company"
  steps: number
  apps: string[]
  usage: string
  updated: string
}

const ROLE_META: Record<Role, { label: string; short: string; name: string; context: string; initials: string }> = {
  member: { label: "Normal user", short: "User", name: "Ananya Mehta", context: "Product Operations", initials: "AM" },
  manager: { label: "Manager", short: "Manager", name: "Maya Chen", context: "Finance · 12 people", initials: "MC" },
  admin: { label: "Company admin", short: "Admin", name: "Arjun Shah", context: "Acme Inc. · 86 people", initials: "AS" },
}

const NAV_BY_ROLE: Record<Role, { label: string; items: NavItem[] }[]> = {
  member: [
    {
      label: "Your workspace",
      items: [
        { id: "home", label: "Home", icon: Grid2X2 },
        { id: "connections", label: "Connected apps", icon: Link2 },
        { id: "access", label: "My access", icon: KeyRound },
        { id: "skills", label: "My skills", icon: Library },
        { id: "usage", label: "My usage", icon: Gauge },
      ],
    },
  ],
  manager: [
    {
      label: "Department",
      items: [
        { id: "home", label: "Home", icon: Grid2X2 },
        { id: "connections", label: "Connections", icon: Link2 },
        { id: "access", label: "Tools & access", icon: KeyRound },
        { id: "people", label: "People & roles", icon: Users },
        { id: "skills", label: "Skills", icon: Library },
        { id: "usage", label: "Usage", icon: Gauge },
      ],
    },
  ],
  admin: [
    {
      label: "Company",
      items: [
        { id: "home", label: "Overview", icon: Grid2X2 },
        { id: "people", label: "Organization", icon: Building2 },
        { id: "connections", label: "Connections", icon: Link2 },
        { id: "access", label: "Tools & access", icon: KeyRound },
        { id: "skills", label: "Skills library", icon: Library },
        { id: "usage", label: "Usage & billing", icon: Gauge },
        { id: "security", label: "Security", icon: ShieldCheck },
      ],
    },
  ],
}

const TOOLS: Tool[] = [
  {
    id: "google",
    name: "Google Workspace",
    description: "Drive, Gmail and Calendar",
    icon: Cloud,
    actions: "Read, create, send",
    approval: "Sending & sharing",
    status: "Ready",
    coverage: { member: "Allowed by Product Ops", manager: "10 of 12 people", admin: "72 of 86 people" },
    source: "Company connection + personal consent",
    capabilities: [
      { name: "Gmail", description: "Search mail, manage drafts and send approved messages" },
      { name: "Google Drive", description: "Find, read, create and share files" },
      { name: "Google Calendar", description: "Inspect availability and manage events" },
      { name: "Google Docs", description: "Create and update structured documents" },
      { name: "Google Sheets", description: "Read and edit spreadsheet ranges" },
      { name: "Google Slides", description: "Build and update presentations" },
      { name: "Google Chat", description: "Read spaces and send approved messages" },
    ],
  },
  {
    id: "lark",
    name: "Lark",
    description: "Messages, docs, tasks and calendar",
    icon: MessageIcon,
    actions: "Read, create, update",
    approval: "External messages",
    status: "Ready",
    coverage: { member: "Company-wide", manager: "12 of 12 people", admin: "86 of 86 people" },
    source: "Company policy",
    capabilities: [
      { name: "Lark Messaging", description: "Search permitted chats and send approved messages" },
      { name: "Lark Docs", description: "Read, create and update cloud documents" },
      { name: "Lark Tasks", description: "Create, assign and organize work" },
      { name: "Lark Calendar", description: "Manage schedules and meeting rooms" },
      { name: "Lark Base", description: "Work with governed multidimensional tables" },
      { name: "Lark Approval", description: "Inspect and act on approval instances" },
    ],
  },
  {
    id: "zoho",
    name: "Zoho",
    description: "CRM, Books and Desk",
    icon: Database,
    actions: "Read, create, update",
    approval: "All writes",
    status: "Ready",
    coverage: { member: "CRM read only", manager: "8 of 12 people", admin: "31 of 86 people" },
    source: "Finance department",
    capabilities: [
      { name: "Zoho CRM", description: "Accounts, contacts, leads, deals and activities" },
      { name: "Zoho Books", description: "Invoices, expenses, contacts and reports" },
      { name: "Zoho Desk", description: "Tickets, comments and support queues" },
    ],
  },
  {
    id: "aitable",
    name: "AITable",
    description: "Datasheets and field management",
    icon: Table2,
    actions: "Read, create, update",
    approval: "Schema changes",
    status: "Connection needed",
    coverage: { member: "Not connected", manager: "6 of 12 people", admin: "18 of 86 people" },
    source: "Personal or company connection",
    capabilities: [
      { name: "AITable Datasheets", description: "Spaces, nodes, records and views", status: "Connection needed" },
      { name: "AITable Fields", description: "Inspect and manage datasheet schemas", status: "Connection needed" },
    ],
  },
  {
    id: "search",
    name: "Web search",
    description: "Governed web research",
    icon: Globe2,
    actions: "Search & read",
    approval: "Not required",
    status: "Ready",
    coverage: { member: "Company-wide", manager: "12 of 12 people", admin: "86 of 86 people" },
    source: "Backend managed",
    capabilities: [{ name: "Web search", description: "Search and read governed public web results", status: "Built in" }],
  },
]

const SKILLS: Skill[] = [
  {
    id: "client-status",
    name: "Client status",
    description: "Checks open invoices, recent email and the latest account note, then returns a five-point risk summary.",
    owner: "You",
    scope: "Private",
    steps: 4,
    apps: ["Zoho", "Gmail"],
    usage: "18 runs",
    updated: "2h ago",
  },
  {
    id: "meeting-prep",
    name: "Meeting prep",
    description: "Builds a compact pre-read from calendar context, recent Lark threads and shared documents.",
    owner: "Maya Chen",
    scope: "Finance",
    steps: 3,
    apps: ["Calendar", "Lark"],
    usage: "42 runs",
    updated: "Yesterday",
  },
  {
    id: "invoice-follow-up",
    name: "Invoice follow-up",
    description: "Finds overdue invoices, drafts a polite follow-up and pauses before anything is sent.",
    owner: "Finance Ops",
    scope: "Finance",
    steps: 5,
    apps: ["Zoho", "Gmail"],
    usage: "27 runs",
    updated: "3d ago",
  },
  {
    id: "weekly-brief",
    name: "Weekly brief",
    description: "Turns project updates, decisions and open tasks into a structured Friday team brief.",
    owner: "Acme Inc.",
    scope: "Company",
    steps: 4,
    apps: ["Lark", "Drive"],
    usage: "156 runs",
    updated: "5d ago",
  },
  {
    id: "table-cleanup",
    name: "Table cleanup",
    description: "Validates a datasheet, highlights malformed records and prepares a safe correction plan.",
    owner: "You",
    scope: "Private",
    steps: 3,
    apps: ["AITable"],
    usage: "6 runs",
    updated: "1w ago",
  },
  {
    id: "campaign-brief",
    name: "Campaign brief",
    description: "Collects market context and past campaign notes into a reusable launch brief.",
    owner: "Growth",
    scope: "Company",
    steps: 4,
    apps: ["Search", "Drive"],
    usage: "64 runs",
    updated: "1w ago",
  },
]

const NEW_SKILL: Skill = {
  id: "__new__",
  name: "Untitled private skill",
  description: "Draft a reusable procedure, inspect its tool dependencies, then test it before sharing.",
  owner: "You",
  scope: "Private",
  steps: 0,
  apps: [],
  usage: "Not run",
  updated: "Draft",
}

const CONNECTIONS = [
  { id: "google", name: "Google Workspace", description: "Gmail, Drive and Calendar", icon: Cloud, account: "ananya@acme.co" },
  { id: "lark", name: "Lark", description: "Messages, docs, tasks and meetings", icon: MessageIcon, account: "Acme Inc. workspace" },
  { id: "zoho", name: "Zoho", description: "CRM, Books, Desk and Projects", icon: Database, account: "Acme India" },
  { id: "aitable", name: "AITable", description: "Datasheets, records and fields", icon: Table2, account: "Product workspace" },
  { id: "notion", name: "Notion", description: "Pages and team knowledge", icon: BookOpen, account: "Not connected" },
  { id: "web", name: "Web search", description: "Company-managed research", icon: Globe2, account: "Managed by Acme Inc." },
]

const PEOPLE = [
  { name: "Maya Chen", email: "maya@acme.co", group: "Manager", access: "8 tools", usage: "₹2,840", initials: "MC" },
  { name: "Dev Malhotra", email: "dev@acme.co", group: "Analyst", access: "6 tools", usage: "₹1,920", initials: "DM" },
  { name: "Ananya Mehta", email: "ananya@acme.co", group: "Operations", access: "7 tools", usage: "₹1,460", initials: "AM" },
  { name: "Ishaan Rao", email: "ishaan@acme.co", group: "Associate", access: "4 tools", usage: "₹780", initials: "IR" },
]

function MessageIcon({ size = 18, className }: { size?: string | number; className?: string }) {
  return <Mail size={size} className={className} />
}

export function MockDashboardPage() {
  const [role, setRole] = useState<Role>("member")
  const [screen, setScreen] = useState<Screen>("home")
  const [query, setQuery] = useState("")
  const [mobileNav, setMobileNav] = useState(false)
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null)
  const [selectedToolId, setSelectedToolId] = useState(TOOLS[0].id)
  const [timeframe, setTimeframe] = useState("30 days")
  const [notice, setNotice] = useState<string | null>(null)
  const [connectionStates, setConnectionStates] = useState<Record<string, ConnectionState>>({
    google: "connected",
    lark: "managed",
    zoho: "connected",
    aitable: "attention",
    notion: "available",
    web: "managed",
  })
  const [securityToggles, setSecurityToggles] = useState({ approvals: true, exports: true, autoMemory: false })

  const roleMeta = ROLE_META[role]
  const selectedTool = TOOLS.find((tool) => tool.id === selectedToolId) ?? TOOLS[0]
  const filteredSkills = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return SKILLS
    return SKILLS.filter((skill) =>
      [skill.name, skill.description, skill.owner, skill.scope, ...skill.apps].some((value) => value.toLowerCase().includes(normalized)),
    )
  }, [query])

  const go = (next: Screen) => {
    setScreen(next)
    setQuery("")
    setMobileNav(false)
  }

  const switchRole = (next: Role) => {
    setRole(next)
    setScreen("home")
    setQuery("")
    setMobileNav(false)
    showNotice(`Previewing ${ROLE_META[next].label}`)
  }

  const showNotice = (message: string) => {
    setNotice(message)
    window.setTimeout(() => setNotice((current) => (current === message ? null : current)), 2200)
  }

  const toggleConnection = (id: string) => {
    setConnectionStates((current) => ({ ...current, [id]: "connected" }))
    showNotice("Connection added in this mock")
  }

  return (
    <div className="cur mock-app">
      <aside className={`mock-sidebar${mobileNav ? " open" : ""}`}>
        <div className="mock-brand">
          <span className="mock-brand-mark"><Diamond size={14} fill="currentColor" /></span>
          <span>Divo</span>
          <span className="mock-chip">Preview</span>
          <button type="button" className="mock-mobile-close" onClick={() => setMobileNav(false)} aria-label="Close navigation">
            <X size={18} />
          </button>
        </div>

        <div className="mock-context">
          <span className="mock-context-icon"><Building2 size={15} /></span>
          <span>
            <b>Acme Inc.</b>
            <small>{role === "member" ? "Your workspace" : role === "manager" ? "Finance department" : "Company workspace"}</small>
          </span>
          <ChevronRight size={14} />
        </div>

        <nav className="mock-nav" aria-label="Dashboard navigation">
          {NAV_BY_ROLE[role].map((section) => (
            <div key={section.label}>
              <div className="mock-nav-label">{section.label}</div>
              {section.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`mock-nav-item${screen === item.id ? " active" : ""}`}
                  onClick={() => go(item.id)}
                >
                  <item.icon size={16} />
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="mock-sidebar-bottom">
          <button type="button" className="mock-nav-item" onClick={() => showNotice("Help center opened in the real product")}>
            <CircleHelp size={16} /> <span>Help & feedback</span>
          </button>
          <Link className="mock-account" to="/login">
            <span className="mock-avatar">{roleMeta.initials}</span>
            <span className="mock-account-copy"><b>{roleMeta.name}</b><small>{roleMeta.context}</small></span>
            <MoreHorizontal size={16} />
          </Link>
        </div>
      </aside>

      {mobileNav ? <button type="button" className="mock-backdrop" onClick={() => setMobileNav(false)} aria-label="Close navigation" /> : null}

      <div className="mock-main">
        <header className="mock-topbar">
          <button type="button" className="mock-menu-button" onClick={() => setMobileNav(true)} aria-label="Open navigation">
            <Menu size={18} />
          </button>
          <div className="mock-search">
            <Search size={15} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={screen === "skills" ? "Search skills, apps or owners…" : "Search this workspace…"}
              aria-label="Search"
            />
            <kbd>⌘ K</kbd>
          </div>
          <div className="mock-role-switch" aria-label="Preview dashboard role">
            {(Object.keys(ROLE_META) as Role[]).map((item) => (
              <button key={item} type="button" className={role === item ? "active" : ""} onClick={() => switchRole(item)}>
                {ROLE_META[item].short}
              </button>
            ))}
          </div>
          <button type="button" className="mock-icon-button" onClick={() => showNotice("You’re all caught up")} aria-label="Notifications">
            <Bell size={16} />
            <span />
          </button>
        </header>

        <main className="mock-content">
          {screen === "home" ? <Home role={role} onNavigate={go} /> : null}
          {screen === "connections" ? (
            <Connections
              role={role}
              states={connectionStates}
              onToggle={toggleConnection}
              onNotice={showNotice}
              query={query}
            />
          ) : null}
          {screen === "access" ? (
            <Access role={role} selectedTool={selectedTool} onSelect={setSelectedToolId} onNotice={showNotice} query={query} />
          ) : null}
          {screen === "skills" ? (
            <Skills
              role={role}
              skills={filteredSkills}
              onSelect={setSelectedSkill}
              onNotice={showNotice}
              onClearSearch={() => setQuery("")}
            />
          ) : null}
          {screen === "usage" ? <Usage role={role} timeframe={timeframe} onTimeframe={setTimeframe} /> : null}
          {screen === "people" ? <People role={role} onNotice={showNotice} /> : null}
          {screen === "security" ? (
            <Security toggles={securityToggles} onToggle={(key) => setSecurityToggles((current) => ({ ...current, [key]: !current[key] }))} />
          ) : null}
        </main>
      </div>

      {selectedSkill ? <SkillDetail skill={selectedSkill} role={role} onClose={() => setSelectedSkill(null)} onNotice={showNotice} /> : null}
      {notice ? <div className="mock-toast"><Check size={15} />{notice}</div> : null}
    </div>
  )
}

function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string
  title: string
  description: string
  action?: React.ReactNode
}) {
  return (
    <div className="mock-page-header">
      <div>
        <span className="mock-eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  )
}

function Home({ role, onNavigate }: { role: Role; onNavigate: (screen: Screen) => void }) {
  const content = {
    member: {
      eyebrow: "Tuesday, 28 July",
      title: "Good morning, Ananya.",
      description: "Your apps, skills and access are ready. Here’s what changed since your last visit.",
      metrics: [
        ["Connected apps", "4", "1 needs attention"],
        ["Available skills", "12", "2 created by you"],
        ["Runs this month", "84", "68% of your allowance"],
        ["Approvals waiting", "1", "Invoice follow-up"],
      ],
    },
    manager: {
      eyebrow: "Finance department",
      title: "Your team is ready to work.",
      description: "Review department access, skills and activity without handling anyone’s credentials.",
      metrics: [
        ["People", "12", "All active"],
        ["Tools in use", "8", "1 needs attention"],
        ["Shared skills", "7", "2 awaiting review"],
        ["Monthly usage", "₹18.4k", "72% of budget"],
      ],
    },
    admin: {
      eyebrow: "Acme Inc.",
      title: "Company overview",
      description: "One place for organization access, governed connections, skills and usage.",
      metrics: [
        ["Active people", "86", "+6 this month"],
        ["Connected tools", "14", "2 need attention"],
        ["Published skills", "24", "Across 5 departments"],
        ["Monthly spend", "₹94.2k", "63% of budget"],
      ],
    },
  }[role]

  return (
    <div className="mock-page">
      <PageHeader eyebrow={content.eyebrow} title={content.title} description={content.description} />

      <section className="mock-metrics" aria-label="Workspace summary">
        {content.metrics.map(([label, value, note], index) => (
          <article key={label} className={`mock-metric${index === 0 ? " featured" : ""}`}>
            <span>{label}</span>
            <strong>{value}</strong>
            <small>{note}</small>
          </article>
        ))}
      </section>

      {role !== "member" ? (
        <section className="mock-approval-inbox">
          <div className="mock-panel-heading"><div><h2>Needs your decision</h2><p>Consequential actions paused by department policy.</p></div><span>3 pending</span></div>
          <div className="mock-approval-inbox-row"><span className="mock-soft-icon"><Mail size={15} /></span><span><b>Send 4 invoice reminders</b><small>Invoice follow-up · Zoho Books → Gmail · requested by Dev Malhotra</small></span><em>₹84,200 affected</em><div><button type="button">Review</button><button type="button" className="approve">Approve</button></div></div>
          <div className="mock-approval-inbox-row"><span className="mock-soft-icon"><Table2 size={15} /></span><span><b>Update 18 AITable records</b><small>Table cleanup · Product workspace · requested by Ananya Mehta</small></span><em>18 records</em><div><button type="button">Review</button><button type="button" className="approve">Approve</button></div></div>
        </section>
      ) : (
        <section className="mock-approval-inbox">
          <div className="mock-panel-heading"><div><h2>Waiting on approval</h2><p>Work that Divo paused before taking action.</p></div><span>1 request</span></div>
          <div className="mock-approval-inbox-row"><span className="mock-soft-icon"><Mail size={15} /></span><span><b>Invoice follow-up</b><small>Drafted 4 messages · Maya Chen is reviewing the send action</small></span><em>Requested 12m ago</em><div><button type="button">View request</button></div></div>
        </section>
      )}

      <div className="mock-home-grid">
        <section className="mock-panel mock-get-started">
          <div className="mock-panel-heading">
            <div><h2>{role === "member" ? "Finish setting up Divo" : role === "manager" ? "Department readiness" : "Company readiness"}</h2><p>Three useful next steps, based on this role.</p></div>
            <span className="mock-progress-label">{role === "member" ? "75%" : role === "manager" ? "88%" : "92%"}</span>
          </div>
          <div className="mock-progress"><span style={{ width: role === "member" ? "75%" : role === "manager" ? "88%" : "92%" }} /></div>
          <div className="mock-task-list">
            <TaskRow done title="Workspace profile created" detail="Your company and department context are current." />
            <TaskRow done={role !== "member"} title={role === "member" ? "Connect AITable" : "Review tool coverage"} detail={role === "member" ? "Use your own Product workspace safely." : "One tool has incomplete team coverage."} onClick={() => onNavigate(role === "member" ? "connections" : "access")} />
            <TaskRow title={role === "member" ? "Review your first private skill" : role === "manager" ? "Review two shared skills" : "Set the company skill policy"} detail="Skills stay private until someone explicitly shares them." onClick={() => onNavigate("skills")} />
          </div>
        </section>

        <section className="mock-panel">
          <div className="mock-panel-heading">
            <div><h2>Quick actions</h2><p>Common work, no AI chat required.</p></div>
          </div>
          <div className="mock-quick-grid">
            <QuickAction icon={Link2} label="Connect an app" onClick={() => onNavigate("connections")} />
            <QuickAction icon={KeyRound} label="Check access" onClick={() => onNavigate("access")} />
            <QuickAction icon={WandSparkles} label="Browse skills" onClick={() => onNavigate("skills")} />
            <QuickAction icon={BarChart3} label="View usage" onClick={() => onNavigate("usage")} />
          </div>
        </section>
      </div>

      <section className="mock-panel mock-activity-panel">
        <div className="mock-panel-heading">
          <div><h2>Recent activity</h2><p>Useful changes and completed work across your scope.</p></div>
          <button type="button" className="mock-text-button">View all <ArrowRight size={14} /></button>
        </div>
        <ActivityRow icon={ShieldCheck} title="Google Drive access confirmed" detail="Product Operations policy · read and create" time="12 min" />
        <ActivityRow icon={Sparkles} title="Client status completed" detail="Private skill · 4 governed steps" time="2 hr" />
        <ActivityRow icon={Link2} title="Zoho connection refreshed" detail="Acme India · connection is healthy" time="Yesterday" />
      </section>
    </div>
  )
}

function TaskRow({ done = false, title, detail, onClick }: { done?: boolean; title: string; detail: string; onClick?: () => void }) {
  return (
    <button type="button" className="mock-task" onClick={onClick}>
      <span className={`mock-check${done ? " done" : ""}`}>{done ? <Check size={12} /> : null}</span>
      <span><b>{title}</b><small>{detail}</small></span>
      {onClick ? <ChevronRight size={15} /> : null}
    </button>
  )
}

function QuickAction({ icon: Icon, label, onClick }: { icon: Icon; label: string; onClick: () => void }) {
  return <button type="button" className="mock-quick-action" onClick={onClick}><Icon size={18} /><span>{label}</span><ChevronRight size={14} /></button>
}

function ActivityRow({ icon: Icon, title, detail, time }: { icon: Icon; title: string; detail: string; time: string }) {
  return (
    <div className="mock-activity-row">
      <span className="mock-soft-icon"><Icon size={16} /></span>
      <span><b>{title}</b><small>{detail}</small></span>
      <time>{time}</time>
    </div>
  )
}

function Connections({
  role,
  states,
  onToggle,
  onNotice,
  query,
}: {
  role: Role
  states: Record<string, ConnectionState>
  onToggle: (id: string) => void
  onNotice: (message: string) => void
  query: string
}) {
  const [scope, setScope] = useState<"personal" | "company">(role === "member" ? "personal" : "company")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const visible = CONNECTIONS.filter((connection) =>
    `${connection.name} ${connection.description}`.toLowerCase().includes(query.toLowerCase()),
  )
  const selected = CONNECTIONS.find((connection) => connection.id === selectedId) ?? null

  if (selected) {
    return (
      <ConnectionWorkspaceDetail
        connection={selected}
        state={states[selected.id]}
        role={role}
        onBack={() => setSelectedId(null)}
        onConnect={() => onToggle(selected.id)}
        onNotice={onNotice}
      />
    )
  }

  return (
    <div className="mock-page mock-desktop-workspace">
      <PageHeader
        eyebrow={role === "member" ? "Your account" : role === "manager" ? "Finance department" : "Company connections"}
        title="Connections"
        description={role === "member" ? "Connect the services you use and inspect the exact consent Divo holds." : "Manage backend-owned company accounts and see which people may select them. Personal consent remains personal."}
        action={<button type="button" className="mock-primary-button" onClick={() => onNotice("Connection catalogue ready")}><Plus size={15} /> Add connection</button>}
      />

      {role !== "member" ? (
        <div className="mock-scope-row">
          <div className="mock-scope-switch">
            <button type="button" className={scope === "company" ? "active" : ""} onClick={() => setScope("company")}><Building2 size={15} /> Company connections</button>
            <button type="button" className={scope === "personal" ? "active" : ""} onClick={() => setScope("personal")}><Users size={15} /> Personal connections</button>
          </div>
          <span>{scope === "company" ? "Shared only through explicit grants" : "Visible for support, but owned by each person"}</span>
        </div>
      ) : null}

      <div className="mock-attention-banner">
        <ShieldCheck size={17} />
        <div><b>Credentials stay server-side</b><p>People see human-readable account labels, provider scopes and effective audiences—never access tokens, refresh tokens or API keys.</p></div>
        <button type="button" onClick={() => onNotice("Connection security guide opened")}>Security model <ArrowRight size={13} /></button>
      </div>

      <section className="mock-inventory-section" style={{ marginTop: 20 }}>
        <div className="mock-section-copy">
          <div><h2>{scope === "company" ? "Company connection inventory" : "Personal connection inventory"}</h2><p>{scope === "company" ? "Accounts the company owns and may grant to departments, department roles or people." : "Accounts owned by individuals. Admins can see health metadata, not credentials or private content."}</p></div>
          <span>{visible.length} providers</span>
        </div>
        <div className="mock-inventory-table">
          <div className="mock-connections-page-head"><span>Provider & account</span><span>Owner</span><span>Available to</span><span>Authentication</span><span>Health</span><span />
          </div>
          {visible.map((connection, index) => {
            const state = states[connection.id]
            const owner = scope === "company" ? (index % 2 ? "Maya Chen" : "Arjun Shah") : index % 2 ? "Ananya Mehta" : "Dev Malhotra"
            const audience = scope === "company" ? (index % 2 ? "Finance" : "Company-wide") : "Owner only"
            const auth = connection.id === "aitable" ? "API key" : connection.id === "web" ? "Backend managed" : "OAuth 2.0"
            return (
              <button type="button" className="mock-connections-page-row" key={connection.id} onClick={() => setSelectedId(connection.id)}>
                <span className="mock-tool-name"><i><connection.icon size={18} /></i><span><b>{connection.name}</b><small>{connection.account}</small></span></span>
                <span>{owner}</span><span>{audience}</span><span>{auth}</span>
                <span className={`mock-status ${state === "connected" || state === "managed" ? "ready" : state === "attention" ? "warning" : ""}`}><i />{state === "managed" ? "Managed" : state === "attention" ? "Reconnect" : state === "connected" ? "Healthy" : "Not connected"}</span>
                <ChevronRight size={14} />
              </button>
            )
          })}
        </div>
      </section>
    </div>
  )
}

function ConnectionWorkspaceDetail({
  connection,
  state,
  role,
  onBack,
  onConnect,
  onNotice,
}: {
  connection: (typeof CONNECTIONS)[number]
  state: ConnectionState
  role: Role
  onBack: () => void
  onConnect: () => void
  onNotice: (message: string) => void
}) {
  const [tab, setTab] = useState<"overview" | "permissions" | "audience" | "activity">("overview")
  const healthy = state === "connected" || state === "managed"
  return (
    <div className="mock-page mock-tool-workspace-detail">
      <button type="button" className="mock-back-link" onClick={onBack}><ArrowLeft size={14} /> All connections</button>
      <div className="mock-provider-header">
        <span className="mock-provider-icon"><connection.icon size={24} /></span>
        <div><span className="mock-eyebrow">Connection detail</span><h1>{connection.name}</h1><p>{connection.account} · {connection.description}</p></div>
        <div className="mock-provider-actions">
          <span className={`mock-status ${healthy ? "ready" : "warning"}`}><i />{healthy ? "Healthy" : state === "attention" ? "Consent expired" : "Not connected"}</span>
          <button type="button" className={healthy ? "mock-secondary-button" : "mock-primary-button"} onClick={healthy ? () => onNotice("Connection verification complete") : onConnect}>{healthy ? <RefreshCw size={14} /> : <PlugZap size={14} />}{healthy ? "Verify now" : "Connect"}</button>
        </div>
      </div>
      <div className="mock-line-tabs mock-detail-tabs">
        {(["overview", "permissions", "audience", "activity"] as const).map((item) => <button key={item} type="button" className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item[0].toUpperCase() + item.slice(1)}</button>)}
      </div>
      {tab === "overview" ? (
        <div className="mock-connection-overview-grid">
          <section className="mock-panel">
            <div className="mock-panel-heading"><div><h2>Account</h2><p>Identity returned by the provider after verification.</p></div></div>
            <div className="mock-detail-list">
              <div><span>Account label</span><b>{connection.account}</b></div><div><span>Owner</span><b>{role === "member" ? "You" : "Arjun Shah"}</b></div>
              <div><span>Authentication</span><b>{connection.id === "aitable" ? "Encrypted API key" : connection.id === "web" ? "Backend managed" : "OAuth 2.0"}</b></div>
              <div><span>Created</span><b>12 Jun 2026</b></div><div><span>Last verified</span><b>8 minutes ago</b></div>
            </div>
          </section>
          <section className="mock-panel">
            <div className="mock-panel-heading"><div><h2>Operational health</h2><p>Safe metadata only.</p></div><span className={`mock-status ${healthy ? "ready" : "warning"}`}><i />{healthy ? "Healthy" : "Attention"}</span></div>
            <div className="mock-health-score"><strong>{healthy ? "100%" : "62%"}</strong><span>Scope and token checks</span></div>
            <div className="mock-health-checks"><span><Check size={13} />Identity verified</span><span><Check size={13} />Encrypted at rest</span><span className={!healthy ? "warning" : ""}>{healthy ? <Check size={13} /> : <AlertTriangle size={13} />}Consent current</span></div>
          </section>
        </div>
      ) : tab === "permissions" ? (
        <section className="mock-inventory-section">
          <div className="mock-section-copy"><div><h2>Provider permissions</h2><p>Scopes consented at the provider. Divo policy may further reduce what can actually run.</p></div></div>
          <div className="mock-permission-list">{["Read account identity", "Read files and records", "Create drafts", "Update permitted records", "Send or publish with approval"].map((label, index) => <div key={label}><span className={`mock-access-dot ${index < 4 ? "allowed" : state === "managed" ? "allowed" : ""}`} /><span><b>{label}</b><small>{index < 4 || state === "managed" ? "Granted by provider consent" : "Not included in this consent"}</small></span><em>{index < 4 || state === "managed" ? "Granted" : "Missing"}</em></div>)}</div>
        </section>
      ) : tab === "audience" ? (
        <section className="mock-inventory-section">
          <div className="mock-section-copy"><div><h2>Who may select this account</h2><p>A connection grant makes an account selectable; tool access and approvals are checked separately.</p></div>{role !== "member" ? <button type="button" className="mock-primary-button" onClick={() => onNotice("Grant audience editor opened")}><Plus size={14} /> Add audience</button> : null}</div>
          <div className="mock-inventory-table">
            <div className="mock-audience-head"><span>Audience</span><span>Type</span><span>Tool policy</span><span>Approval owner</span><span>Status</span></div>
            <div className="mock-audience-row"><span><b>{role === "member" ? "Ananya Mehta" : "Finance"}</b><small>{role === "member" ? "ananya@acme.co" : "12 active people"}</small></span><span>{role === "member" ? "Owner" : "Department"}</span><span>{connection.name} policy</span><span>Connection owner</span><span className="mock-status ready"><i />Active</span></div>
          </div>
        </section>
      ) : (
        <ToolActivity tool={TOOLS.find((tool) => tool.id === connection.id) ?? TOOLS[0]} />
      )}
      <div className="mock-danger-zone">
        <div><h3>Connection controls</h3><p>Reconnect preserves grants. Disconnecting immediately removes this account from selection.</p></div>
        <div><button type="button" className="mock-secondary-button" onClick={() => onNotice("Reconnect flow opened")}><RefreshCw size={14} /> Reconnect</button><button type="button" className="mock-danger-button" onClick={() => onNotice("Disconnect confirmation opened")}><Trash2 size={14} /> Disconnect</button></div>
      </div>
    </div>
  )
}

function Access({
  role,
  selectedTool,
  onSelect,
  onNotice,
  query,
}: {
  role: Role
  selectedTool: Tool
  onSelect: (id: string) => void
  onNotice: (message: string) => void
  query: string
}) {
  type ScopeId = "personal" | "company" | "finance" | "tech"
  type WorkspaceTab = "tools" | "people" | "groups"
  type DetailTab = "capabilities" | "connections" | "access" | "activity"

  const scopes: { id: ScopeId; label: string; hint: string }[] = role === "admin"
    ? [
        { id: "company", label: "Company policy", hint: "What every department is allowed to grant" },
        { id: "finance", label: "Finance", hint: "Access inside this department" },
        { id: "tech", label: "Tech Testing", hint: "Access inside this department" },
      ]
    : role === "manager"
      ? [{ id: "finance", label: "Finance", hint: "You manage this department" }]
      : [{ id: "personal", label: "Your access", hint: "What you can use and why" }]

  const [scope, setScope] = useState<ScopeId>(scopes[0].id)
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>("tools")
  const [detailTab, setDetailTab] = useState<DetailTab>("capabilities")
  const [toolOpen, setToolOpen] = useState(false)
  const [localSearch, setLocalSearch] = useState("")
  const [axis, setAxis] = useState<"groups" | "people">("groups")
  const [capability, setCapability] = useState(selectedTool.capabilities[0]?.name ?? "")
  const [rules, setRules] = useState<Record<string, boolean>>({
    "member-read": true,
    "member-create": true,
    "member-update": false,
    "member-delete": false,
    "member-send": false,
    "manager-read": true,
    "manager-create": true,
    "manager-update": true,
    "manager-delete": false,
    "manager-send": true,
    "analyst-read": true,
    "analyst-create": false,
    "analyst-update": false,
    "analyst-delete": false,
    "analyst-send": false,
  })
  const [approvalRules, setApprovalRules] = useState<Record<string, boolean>>({ create: false, update: true, delete: true, send: true })

  const search = (query || localSearch).trim().toLowerCase()
  const visible = TOOLS.filter((tool) => `${tool.name} ${tool.description} ${tool.capabilities.map((item) => item.name).join(" ")}`.toLowerCase().includes(search))
  const isCompany = scope === "company"
  const isDepartment = scope === "finance" || scope === "tech"
  const currentScope = scopes.find((item) => item.id === scope) ?? scopes[0]
  const inUse = visible.filter((tool) => tool.id !== "aitable")
  const available = visible.filter((tool) => tool.id === "aitable")

  const openTool = (tool: Tool) => {
    onSelect(tool.id)
    setCapability(tool.capabilities[0]?.name ?? "")
    setDetailTab("capabilities")
    setToolOpen(true)
  }

  if (toolOpen) {
    return (
      <ToolWorkspaceDetail
        role={role}
        scope={scope}
        tool={selectedTool}
        tab={detailTab}
        onTab={setDetailTab}
        capability={capability}
        onCapability={setCapability}
        axis={axis}
        onAxis={setAxis}
        rules={rules}
        onRule={(key) => setRules((current) => ({ ...current, [key]: !current[key] }))}
        approvals={approvalRules}
        onApproval={(key) => setApprovalRules((current) => ({ ...current, [key]: !current[key] }))}
        onBack={() => setToolOpen(false)}
        onNotice={onNotice}
      />
    )
  }

  return (
    <div className="mock-page mock-desktop-workspace">
      <PageHeader
        eyebrow={role === "member" ? "Your workspace" : "Capability governance"}
        title={role === "member" ? "Tools" : "Tools & access"}
        description={
          role === "member"
            ? "Connect the accounts you use with Divo, and see exactly what you are allowed to do."
            : role === "manager"
              ? "Give your people the access they need, inside what the company allows."
              : "Set what the company allows, then manage any department in detail."
        }
        action={<button type="button" className="mock-secondary-button" onClick={() => onNotice("Tool inventory refreshed")}><RefreshCw size={15} /> Refresh</button>}
      />

      {role !== "member" ? (
        <div className="mock-scope-row">
          <div className="mock-scope-switch" aria-label="Tool management scope">
            {scopes.map((item) => (
              <button
                key={item.id}
                type="button"
                className={scope === item.id ? "active" : ""}
                onClick={() => { setScope(item.id); setWorkspaceTab("tools"); setLocalSearch("") }}
              >
                {item.id === "company" ? <ShieldCheck size={15} /> : <Building2 size={15} />}
                {item.label}
              </button>
            ))}
          </div>
          <span>{currentScope.hint}</span>
        </div>
      ) : null}

      {isDepartment ? (
        <section className="mock-department-stats">
          <div><strong>{scope === "finance" ? "12" : "7"}</strong><span>People</span></div>
          <div><strong>{scope === "finance" ? "4" : "3"}</strong><span>Department roles</span></div>
          <div><strong>{scope === "finance" ? "8" : "6"}</strong><span>Tools in use</span></div>
          <div><strong>1</strong><span>Needs attention</span></div>
        </section>
      ) : null}

      <div className="mock-workspace-tabs-row">
        <div className="mock-line-tabs">
          <button type="button" className={workspaceTab === "tools" ? "active" : ""} onClick={() => setWorkspaceTab("tools")}>Tools <span>18</span></button>
          {isDepartment ? <button type="button" className={workspaceTab === "people" ? "active" : ""} onClick={() => setWorkspaceTab("people")}>People <span>{scope === "finance" ? 12 : 7}</span></button> : null}
          {isDepartment ? <button type="button" className={workspaceTab === "groups" ? "active" : ""} onClick={() => setWorkspaceTab("groups")}>Roles <span>{scope === "finance" ? 4 : 3}</span></button> : null}
        </div>
        {isDepartment ? (
          <div className="mock-row-actions">
            <button type="button" className="mock-secondary-button" onClick={() => onNotice("New department role editor opened")}><ShieldCheck size={14} /> New role</button>
            <button type="button" className="mock-primary-button" onClick={() => onNotice("Add person flow opened")}><UserPlus size={14} /> Add person</button>
          </div>
        ) : null}
      </div>

      <label className="mock-workspace-search">
        <Search size={16} />
        <input
          value={localSearch}
          onChange={(event) => setLocalSearch(event.target.value)}
          placeholder={workspaceTab === "tools" ? "Search tools and capabilities" : workspaceTab === "people" ? "Search people or email" : "Search department roles"}
        />
      </label>

      {workspaceTab === "tools" ? (
        <div className="mock-workspace-stack">
          <div className="mock-attention-banner">
            <AlertTriangle size={18} />
            <div><b>2 capabilities need a connection</b><p>AITable Datasheets and AITable Fields can be configured now, and start working the moment an account is connected.</p></div>
            <button type="button" onClick={() => onNotice("Connection setup opened")}>Review connections <ArrowRight size={13} /></button>
          </div>

          {isCompany ? (
            <ToolInventorySection
              title="Company policy"
              description="What any department is allowed to grant. Nothing here gives a tool to anybody."
              tools={visible}
              role={role}
              showCoverage={false}
              onOpen={openTool}
            />
          ) : role === "member" ? (
            <>
              <ToolInventorySection
                title="Available to you"
                description="Effective access from company policy, your department and personal exceptions."
                tools={inUse}
                role={role}
                showCoverage
                onOpen={openTool}
              />
              {available.length ? <ToolInventorySection title="Needs your connection" description="Your access is ready; connect an account before these capabilities can run." tools={available} role={role} showCoverage onOpen={openTool} /> : null}
            </>
          ) : (
            <>
              <ToolInventorySection
                title={`In use by ${scope === "finance" ? "Finance" : "Tech Testing"}`}
                description="Effective access, approval rules and connection readiness."
                tools={inUse}
                role={role}
                showCoverage
                onOpen={openTool}
              />
              {available.length ? <ToolInventorySection title="Available, not turned on" description="Nobody here has these yet. Open one to grant a department role access." tools={available} role={role} showCoverage onOpen={openTool} /> : null}
            </>
          )}
        </div>
      ) : workspaceTab === "people" ? (
        <AccessPeopleWorkspace onNotice={onNotice} />
      ) : (
        <AccessGroupsWorkspace onNotice={onNotice} />
      )}
    </div>
  )
}

function ToolInventorySection({
  title,
  description,
  tools,
  role,
  showCoverage,
  onOpen,
}: {
  title: string
  description: string
  tools: Tool[]
  role: Role
  showCoverage: boolean
  onOpen: (tool: Tool) => void
}) {
  return (
    <section className="mock-inventory-section">
      <div className="mock-section-copy"><div><h2>{title}</h2><p>{description}</p></div><span>{tools.reduce((sum, tool) => sum + tool.capabilities.length, 0)} capabilities</span></div>
      <div className="mock-inventory-table">
        <div className={`mock-inventory-head${showCoverage ? "" : " policy"}`}>
          <span>Tool</span>{showCoverage ? <span>Who can use it</span> : null}{showCoverage ? <span>Approval</span> : null}<span>Status</span><span />
        </div>
        {tools.map((tool) => (
          <button key={tool.id} type="button" className={`mock-inventory-row${showCoverage ? "" : " policy"}`} onClick={() => onOpen(tool)}>
            <span className="mock-tool-name"><i><tool.icon size={18} /></i><span><b>{tool.name}</b><small>{tool.capabilities.slice(0, 3).map((item) => item.name).join(" · ")}{tool.capabilities.length > 3 ? ` +${tool.capabilities.length - 3}` : ""}</small></span></span>
            {showCoverage ? <span>{tool.coverage[role]}</span> : null}
            {showCoverage ? <span><em>{tool.approval}</em></span> : null}
            <span><Status label={tool.status} /></span>
            <ChevronRight size={15} />
          </button>
        ))}
      </div>
    </section>
  )
}

function AccessPeopleWorkspace({ onNotice }: { onNotice: (message: string) => void }) {
  return (
    <section className="mock-inventory-section">
      <div className="mock-section-copy"><div><h2>Department people</h2><p>Role assignment and effective team structure. Manager assignments remain company-admin managed.</p></div><span>12 active</span></div>
      <div className="mock-inventory-table">
        <div className="mock-access-people-head"><span>Person</span><span>Department role</span><span>Tool coverage</span><span>Exceptions</span><span />
        </div>
        {PEOPLE.map((person, index) => (
          <button type="button" className="mock-access-people-row" key={person.email} onClick={() => onNotice(`${person.name} access profile opened`)}>
            <span className="mock-person"><i>{person.initials}</i><span><b>{person.name}</b><small>{person.email}</small></span></span>
            <span><em>{person.group}</em></span><span>{person.access}</span><span>{index === 2 ? "2 personal" : index === 3 ? "1 personal" : "None"}</span><ChevronRight size={14} />
          </button>
        ))}
      </div>
    </section>
  )
}

function AccessGroupsWorkspace({ onNotice }: { onNotice: (message: string) => void }) {
  const groups = [
    ["Manager", "2 people", "Protected department role", "9 tools"],
    ["Analyst", "4 people", "Personalized Zoho visibility", "6 tools"],
    ["Operations", "4 people", "Operational write access", "7 tools"],
    ["Associate", "2 people", "Read-first default role", "4 tools"],
  ]
  return (
    <section className="mock-group-grid">
      {groups.map(([name, people, description, tools], index) => (
        <button key={name} type="button" className="mock-group-card" onClick={() => onNotice(`${name} department role editor opened`)}>
          <div><span className="mock-soft-icon"><ShieldCheck size={16} /></span><span className="mock-scope">{index === 0 ? "Built-in" : "Custom"}</span></div>
          <h2>{name}</h2><p>{description}</p>
          <dl><div><dt>People</dt><dd>{people}</dd></div><div><dt>Tool access</dt><dd>{tools}</dd></div></dl>
          <span className="mock-card-link">View role policy <ArrowRight size={13} /></span>
        </button>
      ))}
    </section>
  )
}

function ToolWorkspaceDetail({
  role,
  scope,
  tool,
  tab,
  onTab,
  capability,
  onCapability,
  axis,
  onAxis,
  rules,
  onRule,
  approvals,
  onApproval,
  onBack,
  onNotice,
}: {
  role: Role
  scope: "personal" | "company" | "finance" | "tech"
  tool: Tool
  tab: "capabilities" | "connections" | "access" | "activity"
  onTab: (tab: "capabilities" | "connections" | "access" | "activity") => void
  capability: string
  onCapability: (capability: string) => void
  axis: "groups" | "people"
  onAxis: (axis: "groups" | "people") => void
  rules: Record<string, boolean>
  onRule: (key: string) => void
  approvals: Record<string, boolean>
  onApproval: (key: string) => void
  onBack: () => void
  onNotice: (message: string) => void
}) {
  const isCompany = scope === "company"
  const isPersonal = role === "member"
  const selectedCapability = tool.capabilities.find((item) => item.name === capability) ?? tool.capabilities[0]
  return (
    <div className="mock-page mock-tool-workspace-detail">
      <button type="button" className="mock-back-link" onClick={onBack}><ArrowLeft size={14} /> All tools</button>
      <div className="mock-provider-header">
        <span className="mock-provider-icon"><tool.icon size={24} /></span>
        <div><span className="mock-eyebrow">{isCompany ? "Company policy" : isPersonal ? "Your access" : `${scope === "finance" ? "Finance" : "Tech Testing"} department`}</span><h1>{tool.name}</h1><p>{tool.description} · {tool.capabilities.length} governed capabilities</p></div>
        <div className="mock-provider-actions"><Status label={tool.status} /><button type="button" className="mock-secondary-button" onClick={() => onNotice(`${tool.name} refreshed`)}><RefreshCw size={14} /> Refresh</button></div>
      </div>

      <div className="mock-line-tabs mock-detail-tabs">
        <button type="button" className={tab === "capabilities" ? "active" : ""} onClick={() => onTab("capabilities")}>Capabilities <span>{tool.capabilities.length}</span></button>
        <button type="button" className={tab === "connections" ? "active" : ""} onClick={() => onTab("connections")}>Connections <span>{tool.id === "search" ? 0 : 2}</span></button>
        <button type="button" className={tab === "access" ? "active" : ""} onClick={() => onTab("access")}>Access</button>
        <button type="button" className={tab === "activity" ? "active" : ""} onClick={() => onTab("activity")}>Activity</button>
      </div>

      {tab === "capabilities" ? (
        <div className="mock-capability-layout">
          <section className="mock-inventory-table">
            <div className="mock-capability-head"><span>Capability</span><span>Allowed actions</span><span>Status</span><span /></div>
            {tool.capabilities.map((item) => (
              <button key={item.name} type="button" className={`mock-capability-row${capability === item.name ? " active" : ""}`} onClick={() => onCapability(item.name)}>
                <span><b>{item.name}</b><small>{item.description}</small></span><span>{tool.actions}</span><span><Status label={item.status === "Connection needed" ? "Connection needed" : "Ready"} /></span><ChevronRight size={14} />
              </button>
            ))}
          </section>
          <aside className="mock-capability-detail">
            <span className="mock-eyebrow">Selected capability</span>
            <h2>{selectedCapability?.name}</h2><p>{selectedCapability?.description}</p>
            <dl><div><dt>Tool family</dt><dd>{tool.name}</dd></div><div><dt>Action groups</dt><dd>{tool.actions}</dd></div><div><dt>Approval</dt><dd>{tool.approval}</dd></div><div><dt>Connection</dt><dd>{tool.status === "Ready" ? "Acme primary" : "Required"}</dd></div></dl>
            <button type="button" className="mock-wide-button" onClick={() => onTab("access")}>Configure this capability <ArrowRight size={14} /></button>
          </aside>
        </div>
      ) : tab === "connections" ? (
        <ToolConnections tool={tool} role={role} onNotice={onNotice} />
      ) : tab === "access" ? (
        <ToolAccessPolicy
          role={role}
          company={isCompany}
          tool={tool}
          capability={selectedCapability?.name ?? tool.name}
          axis={axis}
          onAxis={onAxis}
          rules={rules}
          onRule={onRule}
          approvals={approvals}
          onApproval={onApproval}
        />
      ) : (
        <ToolActivity tool={tool} />
      )}
    </div>
  )
}

function ToolConnections({ tool, role, onNotice }: { tool: Tool; role: Role; onNotice: (message: string) => void }) {
  if (tool.id === "search") return <div className="mock-empty"><Globe2 size={22} /><h2>Backend-managed capability</h2><p>Web search uses a company service connection. No member credentials are stored.</p></div>
  const accounts = [
    { label: `${tool.name} · Acme primary`, owner: "Arjun Shah", audience: "Finance + Operations", auth: tool.id === "aitable" ? "API key" : "OAuth 2.0", status: tool.status },
    { label: `${tool.name} · Ananya`, owner: "Ananya Mehta", audience: "Owner only", auth: tool.id === "aitable" ? "API key" : "OAuth 2.0", status: "Ready" as const },
  ]
  return (
    <div className="mock-workspace-stack">
      <div className="mock-section-copy"><div><h2>Available connections</h2><p>Account labels and governed audiences are visible. Credentials never leave the backend.</p></div>{role !== "member" ? <button type="button" className="mock-primary-button" onClick={() => onNotice(`Add ${tool.name} connection opened`)}><Plus size={14} /> Add connection</button> : null}</div>
      <div className="mock-inventory-table">
        <div className="mock-connection-head"><span>Connection</span><span>Owner</span><span>Available to</span><span>Authentication</span><span>Status</span><span /></div>
        {accounts.map((account) => (
          <button type="button" className="mock-connection-row" key={account.label} onClick={() => onNotice(`${account.label} details opened`)}>
            <span className="mock-tool-name"><i><tool.icon size={17} /></i><span><b>{account.label}</b><small>Last verified 8 minutes ago</small></span></span>
            <span>{account.owner}</span><span>{account.audience}</span><span>{account.auth}</span><span><Status label={account.status} /></span><ChevronRight size={14} />
          </button>
        ))}
      </div>
      <div className="mock-notice"><ShieldCheck size={16} /><span><b>Connection selection is explicit.</b> If more than one account is available, the user chooses a human-readable account label before execution.</span></div>
    </div>
  )
}

function ToolAccessPolicy({
  role,
  company,
  tool,
  capability,
  axis,
  onAxis,
  rules,
  onRule,
  approvals,
  onApproval,
}: {
  role: Role
  company: boolean
  tool: Tool
  capability: string
  axis: "groups" | "people"
  onAxis: (axis: "groups" | "people") => void
  rules: Record<string, boolean>
  onRule: (key: string) => void
  approvals: Record<string, boolean>
  onApproval: (key: string) => void
}) {
  const actions = ["read", "create", "update", "delete", "send"]
  if (role === "member") {
    return (
      <div className="mock-policy-narrow">
        <div className="mock-section-copy"><div><h2>What you can do</h2><p>{capability} · effective access, including company and department rules.</p></div></div>
        <div className="mock-personal-access-card">
          {actions.map((action, index) => <div key={action}><span className={`mock-access-dot ${index < 2 ? "allowed" : index === 2 ? "blocked" : ""}`} /><span><b>{action[0].toUpperCase() + action.slice(1)}</b><small>{index < 2 ? "Allowed by Product Operations" : index === 2 ? "Your department role allows this, but company policy blocks it" : "Not granted to your department role"}</small></span></div>)}
        </div>
        <div className="mock-notice"><KeyRound size={16} /><span>Access is set by your company and department. You can inspect the reason chain here, but you cannot widen it yourself.</span></div>
      </div>
    )
  }
  const rows = company ? [["Company admin", "company-admin"], ["Department manager", "manager"], ["Member", "member"]] : axis === "groups"
    ? [["Manager", "manager"], ["Analyst", "analyst"], ["Operations", "member"], ["Associate", "analyst"]]
    : [["Maya Chen", "manager"], ["Dev Malhotra", "analyst"], ["Ananya Mehta", "member"], ["Ishaan Rao", "analyst"]]
  return (
    <div className="mock-workspace-stack">
      <div className="mock-section-copy">
        <div><h2>{company ? "Company policy ceiling" : `${capability} access`}</h2><p>{company ? "This is a ceiling, not a grant. Switching an action on lets departments grant it." : "Set normal access by department role, then inspect personal exceptions only when needed."}</p></div>
        {!company ? <div className="mock-scope-switch compact"><button type="button" className={axis === "groups" ? "active" : ""} onClick={() => onAxis("groups")}>By role</button><button type="button" className={axis === "people" ? "active" : ""} onClick={() => onAxis("people")}>By person</button></div> : null}
      </div>
      {!company ? <div className="mock-ceiling-banner"><AlertTriangle size={16} /><span><b>Company policy blocks Delete for ordinary members.</b> You can configure the department rule now; it becomes effective if the company ceiling is raised.</span></div> : null}
      <div className="mock-policy-matrix">
        <div className="mock-matrix-head"><span>{company ? "Company role" : axis === "groups" ? "Department role" : "Person"}</span>{actions.map((action) => <span key={action}>{action}</span>)}<span /></div>
        {rows.map(([label, key], rowIndex) => (
          <div className="mock-matrix-row" key={label}>
            <span><b>{label}</b><small>{company ? rowIndex === 0 ? "Unrestricted by ceiling" : "Default policy" : axis === "groups" ? `${rowIndex + 2} people` : rowIndex === 2 ? "2 personal exceptions" : "Role policy"}</small></span>
            {actions.map((action, actionIndex) => {
              const ruleKey = `${key}-${action}`
              const checked = rules[ruleKey] ?? (rowIndex === 0 || actionIndex === 0)
              const locked = !company && action === "delete" && rowIndex > 0
              return axis === "people" && !company ? (
                <span key={action} className="mock-effective-mark"><i className={checked && !locked ? "allowed" : locked && checked ? "blocked" : ""} />{rowIndex === 2 && action === "update" ? <small>exception</small> : null}</span>
              ) : (
                <button key={action} type="button" className={`mock-toggle${checked ? " on" : ""}${locked ? " locked" : ""}`} onClick={() => !locked && onRule(ruleKey)} aria-label={`${label} ${action}`}><i /></button>
              )
            })}
            <ChevronRight size={14} />
          </div>
        ))}
        {!company && axis === "people" ? <div className="mock-matrix-legend"><span><i className="allowed" />Allowed</span><span><i className="blocked" />Set here, blocked by company</span><span><i />Not allowed</span></div> : null}
      </div>
      {!company ? (
        <section className="mock-approval-policy">
          <div><h3>Ask a manager first</h3><p>Divo pauses before these actions, even when a person is allowed. Reads are never approval-gated.</p></div>
          <div>{Object.entries(approvals).map(([action, enabled]) => <button key={action} type="button" className={enabled ? "active" : ""} onClick={() => onApproval(action)}>{action}<span className={`mock-toggle${enabled ? " on" : ""}`}><i /></span></button>)}</div>
        </section>
      ) : null}
    </div>
  )
}

function ToolActivity({ tool }: { tool: Tool }) {
  const events = [
    ["Policy changed", `${tool.name} · Manager update access enabled`, "Maya Chen", "Today, 10:42"],
    ["Connection verified", `${tool.name} · Acme primary`, "System", "Today, 09:18"],
    ["Approval completed", "Invoice follow-up · send email", "Arjun Shah", "Yesterday"],
    ["Personal exception added", "Ananya Mehta · update", "Maya Chen", "25 Jul"],
  ]
  return (
    <section className="mock-inventory-section">
      <div className="mock-section-copy"><div><h2>Policy & connection activity</h2><p>Audit evidence for changes that affect this tool.</p></div><button type="button" className="mock-secondary-button"><Download size={14} /> Export</button></div>
      <div className="mock-inventory-table">
        <div className="mock-activity-head"><span>Event</span><span>Detail</span><span>Actor</span><span>When</span></div>
        {events.map(([event, detail, actor, when]) => <div className="mock-activity-table-row" key={`${event}-${when}`}><span><CircleDot size={13} />{event}</span><span>{detail}</span><span>{actor}</span><span>{when}</span></div>)}
      </div>
    </section>
  )
}

function Status({ label }: { label: Tool["status"] }) {
  return <span className={`mock-status ${label === "Ready" ? "ready" : label === "Connection needed" ? "warning" : ""}`}><i />{label}</span>
}

function Skills({
  role,
  skills,
  onSelect,
  onNotice,
  onClearSearch,
}: {
  role: Role
  skills: Skill[]
  onSelect: (skill: Skill) => void
  onNotice: (message: string) => void
  onClearSearch: () => void
}) {
  const [filter, setFilter] = useState("All")
  const filters = role === "member" ? ["All", "Private", "Shared with me"] : ["All", "Private", "Department", "Company"]
  const shown = skills.filter((skill) => {
    if (filter === "All") return true
    if (filter === "Shared with me") return skill.scope !== "Private"
    if (filter === "Department") return skill.scope === "Finance"
    return skill.scope === filter
  })

  return (
    <div className="mock-page">
      <PageHeader
        eyebrow="Reusable work"
        title={role === "member" ? "My skills" : role === "manager" ? "Department skills" : "Skills library"}
        description={role === "member" ? "Create private procedures for work you repeat. Nothing is shared unless you choose to share it." : "Review reusable procedures, dependencies and sharing scope before people use them."}
        action={<button type="button" className="mock-primary-button" onClick={() => onSelect(NEW_SKILL)}><Plus size={15} /> New skill</button>}
      />

      <div className="mock-skill-callout">
        <WandSparkles size={18} />
        <div><b>{role === "member" ? "Private by default" : "Sharing never grants new access"}</b><p>{role === "member" ? "New skills belong only to you until you explicitly publish them." : "Every recipient still needs the underlying tools and connections."}</p></div>
        <button type="button" onClick={() => onNotice("Skill guide opened")}>How skills work <ArrowRight size={13} /></button>
      </div>

      {role !== "member" ? (
        <div className="mock-review-queue">
          <span className="mock-soft-icon"><ShieldCheck size={16} /></span>
          <div><b>2 skills are waiting for review</b><p>Check instructions, required tools and target audience before publishing to Finance.</p></div>
          <button type="button" onClick={() => onNotice("Skill review queue opened")}>Review queue <ArrowRight size={13} /></button>
        </div>
      ) : null}

      <div className="mock-filter-row">
        <div className="mock-segmented">
          {filters.map((item) => <button key={item} type="button" className={filter === item ? "active" : ""} onClick={() => setFilter(item)}>{item}</button>)}
        </div>
        <span>{shown.length} skills</span>
      </div>

      {shown.length ? (
        <section className="mock-skill-grid">
          {shown.map((skill) => (
            <button key={skill.id} type="button" className="mock-skill-card" onClick={() => onSelect(skill)}>
              <div className="mock-skill-card-top">
                <span className="mock-skill-icon"><Sparkles size={18} /></span>
                <span className={`mock-scope ${skill.scope.toLowerCase()}`}><LockKeyhole size={11} />{skill.scope}</span>
              </div>
              <h2>{skill.name}</h2>
              <p>{skill.description}</p>
              <div className="mock-app-pills">
                {skill.apps.map((app) => <span key={app}>{app}</span>)}
              </div>
              <div className="mock-skill-meta">
                <span>{skill.steps} steps</span><i /> <span>{skill.usage}</span><i /> <span>{skill.updated}</span>
              </div>
              <div className="mock-skill-owner"><span className="mock-mini-avatar">{skill.owner.slice(0, 1)}</span><span>By {skill.owner}</span><ChevronRight size={14} /></div>
            </button>
          ))}
        </section>
      ) : (
        <div className="mock-empty"><Search size={22} /><h2>No skills found</h2><p>Try another search or scope.</p><button type="button" onClick={onClearSearch}>Clear search</button></div>
      )}
    </div>
  )
}

function SkillDetail({ skill, role, onClose, onNotice }: { skill: Skill; role: Role; onClose: () => void; onNotice: (message: string) => void }) {
  const creating = skill.id === "__new__"
  const [tab, setTab] = useState<"recipe" | "dependencies" | "sharing" | "versions" | "activity">("recipe")
  const [name, setName] = useState(creating ? "" : skill.name)
  const [summary, setSummary] = useState(creating ? "" : skill.description)
  const [instructions, setInstructions] = useState(
    creating
      ? "1. Identify the records needed for this task.\n2. Load only sources the current user can access.\n3. Produce a concise result with links to source records.\n4. Pause before any write, send or publish action."
      : `# ${skill.name}\n\n1. Resolve the exact account and current department context.\n2. Read the relevant ${skill.apps.join(" and ")} records.\n3. Validate dates, ownership and access before summarising.\n4. Put risks first and keep the result under five bullets.\n5. Pause for approval before any consequential write.`,
  )
  return (
    <div className="mock-dialog-layer" role="dialog" aria-modal="true" aria-labelledby="skill-title">
      <button type="button" className="mock-dialog-backdrop" onClick={onClose} aria-label="Close skill details" />
      <aside className="mock-drawer mock-skill-workbench">
        <div className="mock-drawer-head">
          <span className="mock-skill-icon"><Sparkles size={18} /></span>
          <button type="button" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <span className="mock-eyebrow">{creating ? "New private skill" : "Skill details"}</span>
        <h2 id="skill-title">{creating ? "Create a reusable skill" : skill.name}</h2>
        <p>{creating ? "Start private. Test the procedure and its dependencies before choosing any audience." : skill.description}</p>
        <div className="mock-drawer-actions">
          <button type="button" className="mock-primary-button" onClick={() => onNotice(creating ? "Private skill draft saved" : "Skill draft updated")}><Check size={14} />{creating ? "Save private draft" : "Save changes"}</button>
          {!creating ? <button type="button" className="mock-secondary-button" onClick={() => onNotice("Test run prepared with mock inputs")}><Sparkles size={14} /> Test skill</button> : null}
        </div>

        <div className="mock-line-tabs mock-skill-tabs">
          {(["recipe", "dependencies", "sharing", "versions", "activity"] as const).map((item) => (
            <button key={item} type="button" className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item[0].toUpperCase() + item.slice(1)}</button>
          ))}
        </div>

        {tab === "recipe" ? (
          <section className="mock-skill-form">
            <label><span>Name</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. client-status" /></label>
            <label><span>Summary</span><textarea value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="What this skill helps someone accomplish" rows={3} /></label>
            <label><span>Instructions</span><textarea className="mono" value={instructions} onChange={(event) => setInstructions(event.target.value)} rows={13} /></label>
            <div className="mock-notice"><LockKeyhole size={15} /><span><b>Instructions guide execution; they do not grant access.</b> Every tool call is still checked by backend policy and approval rules.</span></div>
          </section>
        ) : tab === "dependencies" ? (
          <section className="mock-inventory-section">
            <div className="mock-section-copy"><div><h2>Required tools</h2><p>Recipients must already have compatible tool and connection access.</p></div><button type="button" className="mock-secondary-button" onClick={() => onNotice("Dependency picker opened")}><Plus size={14} /> Add tool</button></div>
            <div className="mock-skill-dependency-list">
              {(skill.apps.length ? skill.apps : ["Select a tool"]).map((app, index) => <div key={app}><span className="mock-soft-icon">{index % 2 ? <Cloud size={15} /> : <Database size={15} />}</span><span><b>{app}</b><small>{app === "Select a tool" ? "No dependency selected yet" : "Read, search and approved writes"}</small></span><Status label={app === "AITable" ? "Connection needed" : "Ready"} /><ChevronRight size={14} /></div>)}
            </div>
            <div className="mock-skill-risk-grid"><div><span>Read actions</span><strong>{skill.apps.length ? "3" : "0"}</strong><small>No approval needed</small></div><div><span>Write actions</span><strong>{skill.apps.length ? "2" : "0"}</strong><small>Approval enforced</small></div><div><span>Audience ready</span><strong>{skill.scope === "Company" ? "74%" : "100%"}</strong><small>Compatible access</small></div></div>
          </section>
        ) : tab === "sharing" ? (
          <section className="mock-inventory-section">
            <div className="mock-section-copy"><div><h2>Ownership & audience</h2><p>Private is the default. Publishing is explicit and cannot widen tool permissions.</p></div>{role !== "member" || skill.scope === "Private" ? <button type="button" className="mock-primary-button" onClick={() => onNotice("Audience review opened")}><Users size={14} /> Review audience</button> : null}</div>
            <div className="mock-sharing-summary"><div><span>Owner</span><b>{skill.owner}</b></div><div><span>Current visibility</span><b>{creating ? "Only you" : skill.scope}</b></div><div><span>Publishing authority</span><b>{role === "admin" ? "Company + departments" : role === "manager" ? "Finance only" : "Request manager review"}</b></div><div><span>Recipients compatible</span><b>{skill.scope === "Company" ? "64 of 86" : skill.scope === "Finance" ? "10 of 12" : "1 of 1"}</b></div></div>
            <div className="mock-ceiling-banner"><AlertTriangle size={15} /><span><b>2 recipients lack a required connection.</b> They may discover the skill, but it will show a specific connection action instead of failing at run time.</span></div>
          </section>
        ) : tab === "versions" ? (
          <section className="mock-version-list">
            {[["v4", "Current", "Maya Chen", "Added explicit invoice approval step", "25 Jul"], ["v3", "Published", "Maya Chen", "Changed risk summary to five bullets", "18 Jul"], ["v2", "Archived", "Finance Ops", "Added Gmail dependency", "03 Jul"], ["v1", "Archived", "Finance Ops", "Initial private draft", "20 Jun"]].map(([version, status, author, change, date]) => <button type="button" key={version} onClick={() => onNotice(`${version} comparison opened`)}><span className="mono">{version}</span><span><b>{change}</b><small>{author} · {date}</small></span><em>{status}</em><ChevronRight size={14} /></button>)}
          </section>
        ) : (
          <section className="mock-version-list">
            {[["Skill run completed", "Ananya Mehta", "2h ago"], ["Department version published", "Maya Chen", "3d ago"], ["Sharing review approved", "Arjun Shah", "3d ago"], ["Private draft updated", "Maya Chen", "5d ago"]].map(([event, actor, date]) => <div key={`${event}-${date}`}><CircleDot size={13} /><span><b>{event}</b><small>{actor}</small></span><time>{date}</time></div>)}
          </section>
        )}
      </aside>
    </div>
  )
}

function Usage({ role, timeframe, onTimeframe }: { role: Role; timeframe: string; onTimeframe: (value: string) => void }) {
  const [tab, setTab] = useState<"overview" | "people" | "tools" | "models" | "limits">("overview")
  const values = role === "member"
    ? [["Runs", "84", "+12%"], ["Tokens", "1.24m", "68% allowance"], ["Estimated cost", "₹1,460", "This period"], ["Time saved", "11.8h", "Estimated"]]
    : role === "manager"
      ? [["Runs", "1,284", "+8%"], ["Active people", "12", "100%"], ["Estimated cost", "₹18.4k", "72% budget"], ["Approvals", "38", "3 pending"]]
      : [["Runs", "8,942", "+14%"], ["Active people", "86", "6 new"], ["Provider cost", "₹94.2k", "63% budget"], ["Cache saved", "₹21.8k", "19% of input"]]

  return (
    <div className="mock-page mock-desktop-workspace">
      <PageHeader
        eyebrow="Activity & spend"
        title={role === "member" ? "My usage" : role === "manager" ? "Department usage" : "Usage & billing"}
        description="Understand activity, cost and limits without exposing message or document content."
        action={
          <select className="mock-select" value={timeframe} onChange={(event) => onTimeframe(event.target.value)} aria-label="Usage period">
            <option>7 days</option><option>30 days</option><option>90 days</option>
          </select>
        }
      />
      <div className="mock-line-tabs mock-detail-tabs">
        <button type="button" className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}>Overview</button>
        {role !== "member" ? <button type="button" className={tab === "people" ? "active" : ""} onClick={() => setTab("people")}>By person</button> : null}
        <button type="button" className={tab === "tools" ? "active" : ""} onClick={() => setTab("tools")}>By tool</button>
        <button type="button" className={tab === "models" ? "active" : ""} onClick={() => setTab("models")}>By model</button>
        <button type="button" className={tab === "limits" ? "active" : ""} onClick={() => setTab("limits")}>Limits & budgets</button>
      </div>
      {tab === "overview" ? (
        <>
          <section className="mock-metrics">
            {values.map(([label, value, note], index) => (
              <article key={label} className={`mock-metric${index === 2 ? " featured" : ""}`}><span>{label}</span><strong>{value}</strong><small>{note}</small></article>
            ))}
          </section>
          <div className="mock-usage-grid">
            <section className="mock-panel mock-chart-panel">
              <div className="mock-panel-heading"><div><h2>Usage over time</h2><p>Daily governed runs · last {timeframe}</p></div><span className="mock-status ready"><i />Within limit</span></div>
              <div className="mock-chart">
                {[38, 54, 44, 68, 62, 78, 71, 88, 69, 92, 81, 96, 76, 86].map((height, index) => <i key={index} style={{ height: `${height}%` }}><span>{height}</span></i>)}
              </div>
              <div className="mock-chart-axis"><span>14 Jul</span><span>21 Jul</span><span>28 Jul</span></div>
            </section>
            <section className="mock-panel">
              <div className="mock-panel-heading"><div><h2>Top activity</h2><p>Grouped by capability</p></div></div>
              <UsageBar label="Google Workspace" value="34%" width="86%" /><UsageBar label="Zoho" value="26%" width="66%" /><UsageBar label="Lark" value="22%" width="56%" /><UsageBar label="Web search" value="11%" width="30%" /><UsageBar label="Other" value="7%" width="18%" />
            </section>
          </div>
          <section className="mock-panel">
            <div className="mock-panel-heading"><div><h2>Recent usage</h2><p>Cost and approval metadata only—no conversation content.</p></div><button type="button" className="mock-text-button">Download CSV <ArrowRight size={13} /></button></div>
            <div className="mock-simple-table"><div><span>Client status</span><span>Zoho · Gmail</span><span>38s</span><b>₹18.40</b></div><div><span>Meeting prep</span><span>Lark · Calendar</span><span>22s</span><b>₹7.20</b></div><div><span>Direct tool use</span><span>Web search</span><span>14s</span><b>₹3.80</b></div></div>
          </section>
        </>
      ) : tab === "limits" ? (
        <div className="mock-limits-layout">
          <section className="mock-panel">
            <div className="mock-panel-heading"><div><h2>Budget policy</h2><p>Alerts inform people; hard limits prevent new paid runs.</p></div><CreditCard size={17} /></div>
            <div className="mock-budget-editor">
              <label><span>Monthly budget</span><div><input defaultValue={role === "admin" ? "150000" : role === "manager" ? "25000" : "2200"} /><em>INR</em></div></label>
              <label><span>Alert at</span><div><input defaultValue="80" /><em>%</em></div></label>
              <SettingRow label="Stop paid runs at 100%" detail="Free and backend-managed tools remain available" enabled={false} onClick={() => undefined} />
              <SettingRow label="Notify managers" detail="Send alerts at 80%, 90% and 100%" enabled onClick={() => undefined} />
            </div>
          </section>
          <section className="mock-panel">
            <div className="mock-panel-heading"><div><h2>Current period</h2><p>1–31 July 2026</p></div><span className="mock-status ready"><i />Healthy</span></div>
            <div className="mock-budget-ring"><strong>63%</strong><span>₹94.2k of ₹150k</span></div>
            <div className="mock-detail-list"><div><span>Forecast</span><b>₹128.6k</b></div><div><span>Remaining</span><b>₹55.8k</b></div><div><span>Next reset</span><b>4 days</b></div></div>
          </section>
        </div>
      ) : (
        <UsageBreakdown kind={tab} role={role} />
      )}
    </div>
  )
}

function UsageBreakdown({ kind, role }: { kind: "people" | "tools" | "models"; role: Role }) {
  const rows = kind === "people"
    ? [["Maya Chen", "384", "₹4,920", "18", "92%"], ["Dev Malhotra", "312", "₹4,180", "11", "86%"], ["Ananya Mehta", "284", "₹3,460", "7", "78%"], ["Ishaan Rao", "146", "₹1,780", "2", "64%"]]
    : kind === "tools"
      ? [["Google Workspace", "2,840", "₹28,420", "72 people", "99.2%"], ["Zoho", "1,984", "₹24,810", "31 people", "98.7%"], ["Lark", "1,642", "₹18,060", "86 people", "99.8%"], ["Web search", "1,118", "₹8,940", "86 people", "97.9%"]]
      : [["DeepSeek Chat", "4,821", "₹42,610", "Avg 2.4s", "99.1%"], ["GPT-5 mini", "2,164", "₹31,840", "Avg 3.1s", "98.8%"], ["Gemini Flash", "1,202", "₹12,720", "Avg 1.8s", "99.4%"], ["Embedding", "755", "₹7,030", "Avg 410ms", "99.9%"]]
  return (
    <section className="mock-inventory-section">
      <div className="mock-section-copy"><div><h2>{kind === "people" ? `${role === "admin" ? "Company" : "Department"} usage by person` : kind === "tools" ? "Usage by tool family" : "Usage by model"}</h2><p>Operational metadata only. Prompt, message and document content is never shown here.</p></div><button type="button" className="mock-secondary-button"><Download size={14} /> Export CSV</button></div>
      <div className="mock-inventory-table">
        <div className="mock-usage-breakdown-head"><span>{kind === "people" ? "Person" : kind === "tools" ? "Tool" : "Model"}</span><span>Runs</span><span>Cost</span><span>{kind === "people" ? "Approvals" : kind === "tools" ? "Coverage" : "Latency"}</span><span>Success</span><span /></div>
        {rows.map((row) => <button type="button" className="mock-usage-breakdown-row" key={row[0]}><span><b>{row[0]}</b><small>{kind === "people" ? "Finance department" : "Last 30 days"}</small></span>{row.slice(1).map((cell) => <span key={cell}>{cell}</span>)}<ChevronRight size={14} /></button>)}
      </div>
    </section>
  )
}

function UsageBar({ label, value, width }: { label: string; value: string; width: string }) {
  return <div className="mock-usage-bar"><div><span>{label}</span><b>{value}</b></div><i><span style={{ width }} /></i></div>
}

function People({ role, onNotice }: { role: Role; onNotice: (message: string) => void }) {
  const admin = role === "admin"
  const [tab, setTab] = useState<"people" | "departments" | "groups" | "invites">("people")
  const [selected, setSelected] = useState<(typeof PEOPLE)[number] | null>(null)
  if (selected) return <PersonWorkspaceDetail person={selected} role={role} onBack={() => setSelected(null)} onNotice={onNotice} />
  return (
    <div className="mock-page mock-desktop-workspace">
      <PageHeader
        eyebrow={admin ? "Acme Inc." : "Finance department"}
        title={admin ? "Organization" : "People & roles"}
        description={admin ? "Manage company membership, department structure and administrative roles." : "Assign department roles and review effective access for your team."}
        action={<button type="button" className="mock-primary-button" onClick={() => onNotice(admin ? "Invite flow opened" : "Team editor opened")}><Plus size={15} />{admin ? "Invite people" : "Manage team"}</button>}
      />
      <section className="mock-metrics mock-people-metrics">
        <article className="mock-metric"><span>People</span><strong>{admin ? "86" : "12"}</strong><small>{admin ? "80 active · 6 invited" : "All active"}</small></article>
        <article className="mock-metric"><span>Department roles</span><strong>{admin ? "14" : "4"}</strong><small>{admin ? "Across 5 departments" : "1 protected"}</small></article>
        <article className="mock-metric"><span>Tools in use</span><strong>{admin ? "14" : "8"}</strong><small>Effective access</small></article>
        <article className="mock-metric"><span>Need attention</span><strong>2</strong><small>Invites expire soon</small></article>
      </section>
      <div className="mock-workspace-tabs-row">
        <div className="mock-line-tabs">
          <button type="button" className={tab === "people" ? "active" : ""} onClick={() => setTab("people")}>People <span>{admin ? 86 : 12}</span></button>
          {admin ? <button type="button" className={tab === "departments" ? "active" : ""} onClick={() => setTab("departments")}>Departments <span>5</span></button> : null}
          <button type="button" className={tab === "groups" ? "active" : ""} onClick={() => setTab("groups")}>Roles <span>{admin ? 14 : 4}</span></button>
          <button type="button" className={tab === "invites" ? "active" : ""} onClick={() => setTab("invites")}>Invites <span>6</span></button>
        </div>
        <div className="mock-row-actions"><button type="button" className="mock-secondary-button" onClick={() => onNotice("Directory sync opened")}><RefreshCw size={14} /> Sync directory</button></div>
      </div>
      {tab === "people" ? (
        <section className="mock-panel mock-people-table">
          <div className="mock-panel-heading"><div><h2>{admin ? "People across Acme Inc." : "Finance people"}</h2><p>Department roles provide the default access bundle. Personal exceptions stay exceptional.</p></div><label className="mock-inline-search"><Search size={14} /><input placeholder="Search people" /></label></div>
          <div className="mock-people-detailed-head"><span>Person</span><span>Department</span><span>Role</span><span>Tool access</span><span>Usage</span><span>Status</span><span /></div>
          {PEOPLE.map((person, index) => (
            <button key={person.email} type="button" className="mock-people-detailed-row" onClick={() => setSelected(person)}>
              <span className="mock-person"><i>{person.initials}</i><span><b>{person.name}</b><small>{person.email}</small></span></span>
              <span>{index === 3 ? "Tech Testing" : "Finance"}</span><span><em>{person.group}</em></span><span>{person.access}</span><span>{person.usage}</span><span className="mock-status ready"><i />Active</span><ChevronRight size={14} />
            </button>
          ))}
        </section>
      ) : tab === "departments" ? (
        <DepartmentWorkspace onNotice={onNotice} />
      ) : tab === "groups" ? (
        <AccessGroupsWorkspace onNotice={onNotice} />
      ) : (
        <InviteWorkspace onNotice={onNotice} />
      )}
    </div>
  )
}

function PersonWorkspaceDetail({ person, role, onBack, onNotice }: { person: (typeof PEOPLE)[number]; role: Role; onBack: () => void; onNotice: (message: string) => void }) {
  const [tab, setTab] = useState<"profile" | "access" | "connections" | "skills" | "usage">("profile")
  return (
    <div className="mock-page mock-tool-workspace-detail">
      <button type="button" className="mock-back-link" onClick={onBack}><ArrowLeft size={14} /> All people</button>
      <div className="mock-provider-header">
        <span className="mock-person-large">{person.initials}</span>
        <div><span className="mock-eyebrow">Member profile</span><h1>{person.name}</h1><p>{person.email} · Finance · {person.group}</p></div>
        <div className="mock-provider-actions"><span className="mock-status ready"><i />Active</span><button type="button" className="mock-secondary-button" onClick={() => onNotice("Member actions opened")}><MoreHorizontal size={15} /> Actions</button></div>
      </div>
      <div className="mock-line-tabs mock-detail-tabs">
        {(["profile", "access", "connections", "skills", "usage"] as const).map((item) => <button key={item} type="button" className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item[0].toUpperCase() + item.slice(1)}</button>)}
      </div>
      {tab === "profile" ? (
        <div className="mock-connection-overview-grid">
          <section className="mock-panel"><div className="mock-panel-heading"><div><h2>Membership</h2><p>Identity and organization placement.</p></div></div><div className="mock-detail-list"><div><span>Company role</span><b>{role === "admin" && person.group === "Manager" ? "Department manager" : "Member"}</b></div><div><span>Department</span><b>Finance</b></div><div><span>Department role</span><b>{person.group}</b></div><div><span>Joined</span><b>14 March 2026</b></div><div><span>Identity source</span><b>Lark directory</b></div></div></section>
          <section className="mock-panel"><div className="mock-panel-heading"><div><h2>Current status</h2><p>Safe operational metadata.</p></div><span className="mock-status ready"><i />Healthy</span></div><div className="mock-health-score"><strong>7</strong><span>effective tools</span></div><div className="mock-health-checks"><span><Check size={13} />Identity current</span><span><Check size={13} />Department context current</span><span><Check size={13} />No stale connections</span></div></section>
        </div>
      ) : tab === "access" ? (
        <ToolAccessPolicy role="member" company={false} tool={TOOLS[0]} capability="All effective capabilities" axis="groups" onAxis={() => undefined} rules={{}} onRule={() => undefined} approvals={{}} onApproval={() => undefined} />
      ) : tab === "connections" ? (
        <div className="mock-skill-dependency-list">{CONNECTIONS.slice(0, 4).map((connection, index) => <div key={connection.id}><span className="mock-soft-icon"><connection.icon size={15} /></span><span><b>{connection.name}</b><small>{index < 3 ? connection.account : "No personal account"}</small></span><span className={`mock-status ${index < 3 ? "ready" : "warning"}`}><i />{index < 3 ? "Healthy" : "Missing"}</span><ChevronRight size={14} /></div>)}</div>
      ) : tab === "skills" ? (
        <div className="mock-skill-dependency-list">{SKILLS.slice(0, 4).map((skill) => <div key={skill.id}><span className="mock-skill-icon"><Sparkles size={15} /></span><span><b>{skill.name}</b><small>{skill.scope} · {skill.apps.join(", ")}</small></span><span>{skill.usage}</span><ChevronRight size={14} /></div>)}</div>
      ) : (
        <UsageBreakdown kind="tools" role={role} />
      )}
    </div>
  )
}

function DepartmentWorkspace({ onNotice }: { onNotice: (message: string) => void }) {
  const departments = [["Finance", "12 people", "4 roles", "8 tools", "₹18.4k"], ["Product Operations", "24 people", "3 roles", "9 tools", "₹26.8k"], ["Growth", "18 people", "3 roles", "7 tools", "₹21.2k"], ["Tech Testing", "7 people", "3 roles", "6 tools", "₹12.6k"], ["Leadership", "5 people", "1 role", "11 tools", "₹9.8k"]]
  return <section className="mock-group-grid">{departments.map(([name, people, groups, tools, usage]) => <button key={name} type="button" className="mock-group-card" onClick={() => onNotice(`${name} workspace opened`)}><div><span className="mock-soft-icon"><Building2 size={16} /></span><span className="mock-status ready"><i />Active</span></div><h2>{name}</h2><p>Department roles, skills and effective tool policy.</p><dl><div><dt>People</dt><dd>{people}</dd></div><div><dt>Roles</dt><dd>{groups}</dd></div><div><dt>Tool access</dt><dd>{tools}</dd></div><div><dt>30d usage</dt><dd>{usage}</dd></div></dl><span className="mock-card-link">Open department <ArrowRight size={13} /></span></button>)}</section>
}

function InviteWorkspace({ onNotice }: { onNotice: (message: string) => void }) {
  const invites = [["riya@acme.co", "Finance", "Analyst", "Expires in 2 days"], ["ken@acme.co", "Growth", "Associate", "Expires in 4 days"], ["sana@acme.co", "Product Operations", "Operations", "Sent today"]]
  return <section className="mock-inventory-section"><div className="mock-section-copy"><div><h2>Pending invitations</h2><p>Invites grant workspace membership only. Department and tool access are applied after acceptance.</p></div><button type="button" className="mock-primary-button" onClick={() => onNotice("Invite people flow opened")}><UserPlus size={14} /> Invite people</button></div><div className="mock-inventory-table"><div className="mock-invite-head"><span>Email</span><span>Department</span><span>Role</span><span>Status</span><span /></div>{invites.map(([email, department, group, status]) => <button type="button" className="mock-invite-row" key={email} onClick={() => onNotice(`${email} invite opened`)}><span><b>{email}</b><small>Invited by Arjun Shah</small></span><span>{department}</span><span><em>{group}</em></span><span>{status}</span><MoreHorizontal size={14} /></button>)}</div></section>
}

function Security({
  toggles,
  onToggle,
}: {
  toggles: { approvals: boolean; exports: boolean; autoMemory: boolean }
  onToggle: (key: keyof typeof toggles) => void
}) {
  const [tab, setTab] = useState<"approvals" | "data" | "memory" | "sessions" | "audit">("approvals")
  return (
    <div className="mock-page mock-desktop-workspace">
      <PageHeader eyebrow="Company policy" title="Security" description="Set company-wide boundaries. Departments and people can never exceed this policy ceiling." />
      <div className="mock-line-tabs mock-detail-tabs">
        <button type="button" className={tab === "approvals" ? "active" : ""} onClick={() => setTab("approvals")}>Approvals</button>
        <button type="button" className={tab === "data" ? "active" : ""} onClick={() => setTab("data")}>Data policy</button>
        <button type="button" className={tab === "memory" ? "active" : ""} onClick={() => setTab("memory")}>Memory</button>
        <button type="button" className={tab === "sessions" ? "active" : ""} onClick={() => setTab("sessions")}>Sessions</button>
        <button type="button" className={tab === "audit" ? "active" : ""} onClick={() => setTab("audit")}>Audit log</button>
      </div>
      {tab === "approvals" ? (
        <div className="mock-security-grid">
          <section className="mock-panel">
            <div className="mock-panel-heading"><div><h2>Company approval defaults</h2><p>Departments may require more approval, never less.</p></div><ShieldCheck size={18} /></div>
            <SettingRow label="External sends & publishing" detail="Email, public links and outbound messages" enabled={toggles.approvals} onClick={() => onToggle("approvals")} />
            <SettingRow label="Data exports" detail="Bulk downloads and cross-workspace copies" enabled={toggles.exports} onClick={() => onToggle("exports")} />
            <SettingRow label="Delete & destructive actions" detail="Provider deletes, archive operations and bulk changes" enabled onClick={() => undefined} />
            <SettingRow label="Financial writes" detail="Invoices, payments, refunds and journal changes" enabled onClick={() => undefined} />
          </section>
          <section className="mock-panel mock-security-summary">
            <div className="mock-panel-heading"><div><h2>Approval health</h2><p>Last evaluated 8 minutes ago</p></div><span className="mock-status ready"><i />Healthy</span></div>
            <div className="mock-security-score"><strong>38</strong><span>approved this month</span></div>
            <ul><li><Check size={14} />3 requests currently pending</li><li><Check size={14} />Median response time 6 minutes</li><li><Check size={14} />No expired critical requests</li></ul>
          </section>
        </div>
      ) : tab === "data" ? (
        <section className="mock-panel mock-policy-list">
          <div className="mock-panel-heading"><div><h2>Data handling boundaries</h2><p>Controls for exports, cross-provider movement and retention.</p></div><SlidersHorizontal size={17} /></div>
          <SettingRow label="Allow cross-provider workflows" detail="Move governed output between connected services after permission checks" enabled onClick={() => undefined} />
          <SettingRow label="Require approval for bulk export" detail="Applies when more than 100 records or 25 files leave a provider" enabled={toggles.exports} onClick={() => onToggle("exports")} />
          <SettingRow label="Block public link creation" detail="Company-wide ceiling for anonymous or public sharing" enabled onClick={() => undefined} />
          <SettingRow label="Redact credentials from traces" detail="Reject and suppress secret-like values in tool input and output" enabled onClick={() => undefined} />
          <div className="mock-retention-row"><span><b>Audit retention</b><small>How long policy and execution evidence is retained</small></span><select className="mock-select" defaultValue="365"><option value="90">90 days</option><option value="180">180 days</option><option value="365">365 days</option></select></div>
        </section>
      ) : tab === "memory" ? (
        <div className="mock-security-grid">
          <section className="mock-panel">
            <div className="mock-panel-heading"><div><h2>Personal memory</h2><p>Private to each person by default.</p></div><Sparkles size={17} /></div>
            <SettingRow label="Automatic low-risk preferences" detail="Harmless formatting and workflow preferences may save with an Undo receipt" enabled={toggles.autoMemory} onClick={() => onToggle("autoMemory")} />
            <SettingRow label="Require confirmation for sensitive facts" detail="Identity, financial and consequential preferences" enabled onClick={() => undefined} />
            <SettingRow label="Allow older-memory recall" detail="Governed recall when the bounded hot context is insufficient" enabled onClick={() => undefined} />
          </section>
          <section className="mock-panel"><div className="mock-panel-heading"><div><h2>Never store</h2><p>Hard company-wide exclusions.</p></div><LockKeyhole size={17} /></div><div className="mock-blocked-data-list"><span>Passwords and access tokens</span><span>Private keys and recovery codes</span><span>Copied system instructions</span><span>Facts about another person</span><span>Transient one-time requests</span></div></section>
        </div>
      ) : tab === "sessions" ? (
        <section className="mock-inventory-section">
          <div className="mock-section-copy"><div><h2>Active member sessions</h2><p>Revoke dashboard and desktop sessions without changing provider connections.</p></div><button type="button" className="mock-secondary-button"><RefreshCw size={14} /> Refresh</button></div>
          <div className="mock-inventory-table"><div className="mock-session-head"><span>Person & device</span><span>Surface</span><span>Location</span><span>Last active</span><span>Status</span><span /></div>{[["Ananya Mehta · macOS", "Divo Desktop", "Bengaluru, IN", "Now"], ["Maya Chen · Chrome", "Dashboard", "Singapore, SG", "12m ago"], ["Arjun Shah · macOS", "Divo Desktop", "Mumbai, IN", "28m ago"]].map(([person, surface, location, active]) => <button type="button" className="mock-session-row" key={person}><span><b>{person}</b><small>Trusted device</small></span><span>{surface}</span><span>{location}</span><span>{active}</span><span className="mock-status ready"><i />Active</span><MoreHorizontal size={14} /></button>)}</div>
        </section>
      ) : (
        <section className="mock-inventory-section">
          <div className="mock-section-copy"><div><h2>Security audit log</h2><p>Identity, policy, connection and approval evidence.</p></div><div className="mock-row-actions"><button type="button" className="mock-secondary-button"><ListFilter size={14} /> Filters</button><button type="button" className="mock-secondary-button"><Download size={14} /> Export</button></div></div>
          <ToolActivity tool={TOOLS[0]} />
        </section>
      )}
    </div>
  )
}

function SettingRow({ label, detail, enabled, onClick }: { label: string; detail: string; enabled: boolean; onClick: () => void }) {
  return (
    <button type="button" className="mock-setting-row" onClick={onClick}>
      <span><b>{label}</b><small>{detail}</small></span>
      <i className={enabled ? "on" : ""}><span /></i>
    </button>
  )
}
