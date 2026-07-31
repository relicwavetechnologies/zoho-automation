import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import {
  Archive,
  Boxes,
  Building2,
  Check,
  ChevronRight,
  Clock,
  FilePlus2,
  FolderClosed,
  FolderOpen,
  FolderPlus,
  GitBranch,
  Hash,
  History,
  Loader2,
  Lock,
  Pencil,
  Plus,
  ScrollText,
  Search,
  ShieldCheck,
  Sparkles,
  Tag,
  Trash2,
  User,
  Wrench,
  X,
} from "lucide-react"
import { useAdminAuth } from "@/auth/AdminAuthProvider"
import type {
  SkillGranteeCandidate,
  SkillGranteeType,
  SkillRegistryFolderNode,
  SkillRegistrySkillNode,
  SkillRegistryTree,
} from "@/lib/api"
import {
  useSkillAccess,
  useSkillAudit,
  useSkillDetail,
  useSkillsLabData,
  useToolLabels,
} from "./skills/use-skills-lab-data"

/**
 * Skills Lab — the cloud Skill Registry admin area.
 *
 * A filesystem-style browser (à la VS Code's explorer): company-wide + per
 * department → folders → skills, with a detail panel showing the required tools
 * (the live Skill.toolIds), a read-only binary "who can use it" view resolved
 * server-side, the markdown recipe, and the audit trail. RBAC and placement are
 * decided entirely on the backend — this console only reflects and organizes.
 */

// ── UI tree model (flattened from the backend tree DTO) ──────────────────────
type UiSkill = SkillRegistrySkillNode & { kind: "skill" }
type UiFolder = {
  kind: "company" | "department" | "folder"
  id: string
  name: string
  departmentId: string | null
  status: string
  children: UiNode[]
}
type UiNode = UiFolder | UiSkill

const ROOT_ID = "__root"

function mapSkill(s: SkillRegistrySkillNode): UiSkill {
  return { ...s, kind: "skill" }
}
function mapFolder(f: SkillRegistryFolderNode): UiFolder {
  return {
    kind: "folder",
    id: f.id,
    name: f.name,
    departmentId: f.departmentId,
    status: f.status,
    children: [...f.children.map(mapFolder), ...f.skills.map(mapSkill)],
  }
}
function buildUiTree(tree: SkillRegistryTree, companyName: string): UiFolder {
  return {
    kind: "company",
    id: ROOT_ID,
    name: companyName,
    departmentId: null,
    status: "active",
    children: [
      ...tree.companyWide.folders.map(mapFolder),
      ...tree.companyWide.skills.map(mapSkill),
      ...tree.departments.map((d) => ({
        kind: "department" as const,
        id: d.id,
        name: d.name,
        departmentId: d.id,
        status: "active",
        children: [...d.folders.map(mapFolder), ...d.skills.map(mapSkill)],
      })),
    ],
  }
}

// ── tree walkers ─────────────────────────────────────────────────────────────
function collectSkills(node: UiNode, acc: UiSkill[] = []): UiSkill[] {
  if (node.kind === "skill") acc.push(node)
  else node.children.forEach((c) => collectSkills(c, acc))
  return acc
}
function findById(node: UiNode, id: string): UiNode | null {
  if (node.id === id) return node
  if (node.kind === "skill") return null
  for (const c of node.children) {
    const hit = findById(c, id)
    if (hit) return hit
  }
  return null
}
function pathTo(node: UiNode, id: string, trail: string[] = []): string[] | null {
  const here = [...trail, node.name]
  if (node.id === id) return here
  if (node.kind === "skill") return null
  for (const c of node.children) {
    const hit = pathTo(c, id, here)
    if (hit) return hit
  }
  return null
}
/** Every folder node (excludes the company root and skills). */
function collectFolders(node: UiNode, acc: UiFolder[] = []): UiFolder[] {
  if (node.kind === "skill") return acc
  if (node.kind === "folder") acc.push(node)
  node.children.forEach((c) => collectFolders(c, acc))
  return acc
}

// ── presentational bits ──────────────────────────────────────────────────────
const StatusBadge = ({ status }: { status: string }) =>
  status === "active" ? (
    <span className="badge b-ok">Active</span>
  ) : (
    <span className="badge b-err">Archived</span>
  )

// ── Tree ─────────────────────────────────────────────────────────────────────
function TreeRow({
  node, depth, selectedId, expanded, onToggle, onSelect, query, toolLabel,
}: {
  node: UiNode
  depth: number
  selectedId: string
  expanded: Set<string>
  onToggle: (id: string) => void
  onSelect: (id: string) => void
  query: string
  toolLabel: (id: string) => string
}) {
  const isSkill = node.kind === "skill"
  const isOpen = expanded.has(node.id)
  const q = query.trim().toLowerCase()

  const matches = (n: UiNode): boolean => {
    if (n.kind === "skill")
      return (
        !q ||
        n.name.toLowerCase().includes(q) ||
        n.slug.includes(q) ||
        n.tags.some((t) => t.includes(q)) ||
        n.toolIds.some((t) => toolLabel(t).toLowerCase().includes(q))
      )
    return n.children.some(matches)
  }
  if (!matches(node)) return null

  const Icon = isSkill
    ? Sparkles
    : node.kind === "company"
      ? Boxes
      : node.kind === "department"
        ? Building2
        : isOpen ? FolderOpen : FolderClosed

  const forceOpen = q.length > 0
  const showChildren = !isSkill && (isOpen || forceOpen)

  return (
    <>
      <div
        className={`sl-node${selectedId === node.id ? " active" : ""}`}
        style={{ paddingLeft: 8 + depth * 15 }}
        onClick={() => { onSelect(node.id); if (!isSkill) onToggle(node.id) }}
        role="button"
      >
        {!isSkill ? (
          <ChevronRight size={13} className="sl-caret" style={{ transform: showChildren ? "rotate(90deg)" : "none" }} />
        ) : (
          <span style={{ width: 13, display: "inline-block" }} />
        )}
        <Icon size={14} className={isSkill ? "sl-skill-ic" : "sl-folder-ic"} />
        <span className="sl-node-name">{node.name}</span>
        {isSkill && node.status === "archived" && <Archive size={12} className="sl-arch" />}
        {!isSkill && node.kind !== "company" && <span className="sl-count">{collectSkills(node).length}</span>}
      </div>
      {showChildren &&
        (node as UiFolder).children.map((c) => (
          <TreeRow key={c.id} node={c} depth={depth + 1} selectedId={selectedId} expanded={expanded}
            onToggle={onToggle} onSelect={onSelect} query={query} toolLabel={toolLabel} />
        ))}
    </>
  )
}

// ── A minimal "move" picker: pick a destination folder (or root) ─────────────
function MovePicker({ options, onMove, label }: {
  options: { id: string | null; label: string }[]
  onMove: (folderId: string | null) => void
  label: string
}) {
  const [open, setOpen] = useState(false)
  if (!open) return <button className="btn" onClick={() => setOpen(true)}><GitBranch size={14} /> {label}</button>
  return (
    <select
      className="sl-move-select"
      defaultValue="__pick"
      autoFocus
      onBlur={() => setOpen(false)}
      onChange={(e) => {
        const v = e.target.value
        if (v === "__pick") return
        onMove(v === "__root" ? null : v)
        setOpen(false)
      }}
    >
      <option value="__pick" disabled>Move to…</option>
      <option value="__root">Root (no folder)</option>
      {options.map((o) => (
        <option key={o.id ?? "root"} value={o.id ?? "__root"}>{o.label}</option>
      ))}
    </select>
  )
}

// ── Grantee icon by type ─────────────────────────────────────────────────────
const GranteeIcon = ({ type, size = 15 }: { type: SkillGranteeType; size?: number }) =>
  type === "user" ? <User size={size} /> : type === "department" ? <Building2 size={size} />
    : type === "role" ? <ShieldCheck size={size} /> : <Boxes size={size} />

// ── In-app prompt / confirm modals (replace the native browser dialogs) ──────
type PromptOpts = { title: string; description?: string; defaultValue?: string; placeholder?: string; confirmLabel?: string }
type ConfirmOpts = { title: string; body?: string; confirmLabel?: string }
type DialogState =
  | { kind: "prompt"; opts: PromptOpts; resolve: (v: string | null) => void }
  | { kind: "confirm"; opts: ConfirmOpts; resolve: (v: boolean) => void }
  | null

const SkillsUiContext = createContext<{
  prompt: (opts: PromptOpts) => Promise<string | null>
  confirm: (opts: ConfirmOpts) => Promise<boolean>
} | null>(null)

function useSkillsUi() {
  const ctx = useContext(SkillsUiContext)
  if (!ctx) throw new Error("useSkillsUi must be used within SkillsUiProvider")
  return ctx
}

/** Provides promise-based prompt()/confirm() backed by proper in-app modals. */
function SkillsUiProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<DialogState>(null)
  const api = useMemo(
    () => ({
      prompt: (opts: PromptOpts) => new Promise<string | null>((resolve) => setDialog({ kind: "prompt", opts, resolve })),
      confirm: (opts: ConfirmOpts) => new Promise<boolean>((resolve) => setDialog({ kind: "confirm", opts, resolve })),
    }),
    [],
  )
  const settle = (result: string | null | boolean) => {
    setDialog((cur) => {
      if (cur) (cur.resolve as (v: string | null | boolean) => void)(result)
      return null
    })
  }
  return (
    <SkillsUiContext.Provider value={api}>
      {children}
      {dialog?.kind === "prompt" && (
        <PromptModal opts={dialog.opts} onSubmit={(v) => settle(v)} onCancel={() => settle(null)} />
      )}
      {dialog?.kind === "confirm" && (
        <ConfirmModal opts={dialog.opts} onConfirm={() => settle(true)} onCancel={() => settle(false)} />
      )}
    </SkillsUiContext.Provider>
  )
}

function PromptModal({ opts, onSubmit, onCancel }: { opts: PromptOpts; onSubmit: (v: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(opts.defaultValue ?? "")
  const submit = () => { const v = value.trim(); if (v) onSubmit(v) }
  return (
    <div className="sl-modal-scrim" onClick={onCancel}>
      <div className="sl-modal card" style={{ maxWidth: 440 }} onClick={(e) => e.stopPropagation()}>
        <div className="sl-modal-head">
          <div>
            <h2 className="display" style={{ fontSize: 19 }}>{opts.title}</h2>
            {opts.description && <p className="muted" style={{ fontSize: 13, marginTop: 4 }}>{opts.description}</p>}
          </div>
          <button className="sl-icon-btn" onClick={onCancel} aria-label="Close"><X size={18} /></button>
        </div>
        <input
          autoFocus
          className="sl-input"
          value={value}
          placeholder={opts.placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit()
            if (e.key === "Escape") onCancel()
          }}
        />
        <div className="sl-modal-foot">
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className="btn primary" onClick={submit} disabled={!value.trim()}>{opts.confirmLabel ?? "Create"}</button>
        </div>
      </div>
    </div>
  )
}

function ConfirmModal({ opts, onConfirm, onCancel }: { opts: ConfirmOpts; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="sl-modal-scrim" onClick={onCancel}>
      <div className="sl-modal card" style={{ maxWidth: 440 }} onClick={(e) => e.stopPropagation()}>
        <div className="sl-modal-head">
          <div>
            <h2 className="display" style={{ fontSize: 19 }}>{opts.title}</h2>
            {opts.body && <p className="muted" style={{ fontSize: 13, marginTop: 4, lineHeight: 1.5 }}>{opts.body}</p>}
          </div>
          <button className="sl-icon-btn" onClick={onCancel} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="sl-modal-foot">
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className="btn primary" onClick={onConfirm}>{opts.confirmLabel ?? "Confirm"}</button>
        </div>
      </div>
    </div>
  )
}

// ── Manage-access modal: share a skill with user/dept/role/company ───────────
function SkillAccessModal({ skillName, access, onClose }: {
  skillName: string
  access: ReturnType<typeof useSkillAccess>
  onClose: () => void
}) {
  const [granteeType, setGranteeType] = useState<SkillGranteeType>("department")
  const [query, setQuery] = useState("")
  const [selectedId, setSelectedId] = useState("")
  const data = access.data

  const candidatesForType = useMemo<SkillGranteeCandidate[]>(() => {
    if (!data) return []
    if (granteeType === "user") return data.candidates.users
    if (granteeType === "department") return data.candidates.departments
    if (granteeType === "role") return data.candidates.roles
    return data.candidates.company ? [data.candidates.company] : []
  }, [data, granteeType])

  const filtered = candidatesForType.filter((c) =>
    !query.trim() || c.label.toLowerCase().includes(query.toLowerCase()) || (c.detail ?? "").toLowerCase().includes(query.toLowerCase()),
  )

  const switchType = (t: SkillGranteeType) => {
    setGranteeType(t)
    setQuery("")
    // Company has a single implicit target — preselect it.
    setSelectedId(t === "company" ? (data?.candidates.company?.granteeId ?? "") : "")
  }

  const doGrant = async () => {
    if (!selectedId) return
    await access.grant(granteeType, selectedId)
    setSelectedId("")
  }

  return (
    <div className="sl-modal-scrim" onClick={onClose}>
      <div className="sl-modal card" onClick={(e) => e.stopPropagation()}>
        <div className="sl-modal-head">
          <div>
            <h2 className="display" style={{ fontSize: 20 }}>Manage access</h2>
            <p className="muted" style={{ fontSize: 13, marginTop: 4 }}>Share <b>{skillName}</b> with users, departments, roles, or the whole company. Deny-by-default.</p>
          </div>
          <button className="sl-icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>

        {/* Grant access */}
        <div className="section" style={{ marginTop: 4 }}>
          <header><h3>Grant access</h3><p>Pick a grantee type, choose a target, then grant. A granted skill is usable; access is enforced server-side.</p></header>
          <div style={{ padding: "12px 16px 16px" }}>
            <div style={{ display: "flex", gap: 8 }}>
              <select className="sl-move-select" value={granteeType} onChange={(e) => switchType(e.target.value as SkillGranteeType)}>
                <option value="user">User</option>
                <option value="department">Department</option>
                <option value="role">Role</option>
                <option value="company">Company</option>
              </select>
              <div className="search" style={{ flex: 1, height: 34, opacity: granteeType === "company" ? 0.5 : 1 }}>
                <Search size={14} className="muted" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={`Search ${granteeType}`}
                  disabled={granteeType === "company"}
                  style={{ border: "none", background: "none", outline: "none", width: "100%", fontSize: 12.5, color: "inherit" }}
                />
              </div>
              <button className="btn primary" onClick={() => void doGrant()} disabled={!selectedId}><ShieldCheck size={14} /> Grant</button>
            </div>
            <div className="sl-candidates">
              {filtered.length === 0 && <div className="muted" style={{ padding: 14, fontSize: 12.5, textAlign: "center" }}>No eligible {granteeType} grantees.</div>}
              {filtered.map((c) => (
                <button
                  key={c.granteeId}
                  className={`sl-candidate${selectedId === c.granteeId ? " on" : ""}`}
                  onClick={() => setSelectedId(c.granteeId)}
                >
                  <GranteeIcon type={granteeType} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span className="sl-cand-label">{c.label}</span>
                    {c.detail && <span className="sl-cand-detail">{c.detail}</span>}
                  </span>
                  {selectedId === c.granteeId && <Check size={15} />}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Current access */}
        <div className="section" style={{ marginTop: 14 }}>
          <header><h3>Current access</h3><p>Grantees who can use this skill today.</p></header>
          <div style={{ padding: 8 }}>
            {data && data.grants.length === 0 && (
              <div className="muted" style={{ padding: 16, fontSize: 12.5, textAlign: "center" }}>No grants yet — nobody can use this skill.</div>
            )}
            {data?.grants.map((g) => (
              <div key={`${g.granteeType}:${g.granteeId}`} className="sl-grant-row">
                <span className="sl-grant-ic"><GranteeIcon type={g.granteeType} size={14} /></span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="sl-cand-label">{g.label}</span>
                  <span className="sl-cand-detail">{g.granteeType}{g.detail ? ` · ${g.detail}` : ""}</span>
                </span>
                <button className="sl-icon-btn" onClick={() => void access.revoke(g.granteeType, g.granteeId)} title="Revoke"><Trash2 size={15} /></button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Detail: Folder ───────────────────────────────────────────────────────────
function FolderDetail({ node, root, actions, toolLabel }: {
  node: UiFolder
  root: UiFolder
  actions: ReturnType<typeof useSkillsLabData>
  toolLabel: (id: string) => string
}) {
  const ui = useSkillsUi()
  const path = pathTo(root, node.id)?.join("  /  ") ?? node.name
  const skills = collectSkills(node)
  const subfolders = node.children.filter((c) => c.kind !== "skill").length
  const isFolder = node.kind === "folder"
  const kindLabel = node.kind === "company" ? "Company root" : node.kind === "department" ? "Department root" : "Folder"

  // Destination folders for a folder move: same scope (departmentId), excluding self.
  const moveOptions = useMemo(
    () => collectFolders(root)
      .filter((f) => f.id !== node.id && f.departmentId === node.departmentId)
      .map((f) => ({ id: f.id as string | null, label: pathTo(root, f.id)?.slice(1).join(" / ") ?? f.name })),
    [root, node.id, node.departmentId],
  )

  const promptNewFolder = async () => {
    const name = await ui.prompt({
      title: `New folder in “${node.name}”`,
      placeholder: "Folder name",
      confirmLabel: "Create folder",
    })
    if (!name) return
    if (node.kind === "company") void actions.createFolder({ name, departmentId: null })
    else if (node.kind === "department") void actions.createFolder({ name, departmentId: node.departmentId })
    else void actions.createFolder({ name, parentId: node.id })
  }

  return (
    <div>
      <div className="sl-detail-head">
        <div>
          <div className="crumbs">{path}</div>
          <h2 className="display" style={{ fontSize: 22 }}>{node.name}</h2>
          <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
            {kindLabel}{node.departmentId ? "" : " · company-wide"} · {skills.length} skills · {subfolders} subfolders
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {isFolder && (
            <>
              <button className="btn" onClick={async () => {
                const name = await ui.prompt({ title: "Rename folder", defaultValue: node.name, confirmLabel: "Rename" })
                if (name && name !== node.name) void actions.renameFolder(node.id, name)
              }}><Pencil size={14} /> Rename</button>
              <MovePicker options={moveOptions} label="Move" onMove={(f) => actions.moveFolder(node.id, f)} />
              <button className="btn" onClick={async () => {
                const ok = await ui.confirm({
                  title: `Archive “${node.name}”?`,
                  body: "Sub-folders are archived too, and their skills fall back to the root.",
                  confirmLabel: "Archive",
                })
                if (ok) void actions.archiveFolder(node.id)
              }}><Archive size={14} /> Archive</button>
            </>
          )}
        </div>
      </div>

      <div className="section mt16">
        <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div><h3>Contents</h3><p>Folders and skills directly inside {node.name}.</p></div>
          <button className="btn" onClick={promptNewFolder}><FolderPlus size={14} /> New folder</button>
        </header>
        <table>
          <thead><tr><th>Name</th><th>Type</th><th>Required tools</th><th>Status</th></tr></thead>
          <tbody>
            {node.children.map((c) => (
              <tr key={c.id}>
                <td style={{ display: "flex", alignItems: "center", gap: 9 }}>
                  {c.kind === "skill" ? <Sparkles size={14} className="sl-skill-ic" /> : <FolderClosed size={14} className="sl-folder-ic" />}
                  <b style={{ fontWeight: 500 }}>{c.name}</b>
                </td>
                <td className="muted">{c.kind === "skill" ? "Skill" : "Folder"}</td>
                <td className="muted">
                  {c.kind === "skill" ? c.toolIds.map(toolLabel).join(", ") || "—" : `${collectSkills(c).length} skills`}
                </td>
                <td>{c.kind === "skill" ? <StatusBadge status={c.status} /> : <span className="muted">—</span>}</td>
              </tr>
            ))}
            {!node.children.length && <tr><td colSpan={4} className="muted" style={{ textAlign: "center", padding: 22 }}>Empty.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Detail: Skill ────────────────────────────────────────────────────────────
type Tab = "overview" | "content" | "access" | "audit"

function SkillDetail({ node, root, actions, toolLabel }: {
  node: UiSkill
  root: UiFolder
  actions: ReturnType<typeof useSkillsLabData>
  toolLabel: (id: string) => string
}) {
  const [tab, setTab] = useState<Tab>("overview")
  const [manageOpen, setManageOpen] = useState(false)
  const detail = useSkillDetail(node.id)
  const access = useSkillAccess(node.id)
  const audit = useSkillAudit(node.id)
  const path = pathTo(root, node.id)?.slice(0, -1).join("  /  ") ?? ""

  const isCompanyWide = node.scope === "company" || node.scope === "global"
  // Destination folders for a skill move: same scope only.
  const moveOptions = useMemo(
    () => collectFolders(root)
      .filter((f) => (isCompanyWide ? f.departmentId === null : f.departmentId === node.departmentId))
      .map((f) => ({ id: f.id as string | null, label: pathTo(root, f.id)?.slice(1).join(" / ") ?? f.name })),
    [root, node.departmentId, isCompanyWide],
  )

  const TABS: { id: Tab; label: string; icon: typeof Wrench }[] = [
    { id: "overview", label: "Overview", icon: ScrollText },
    { id: "content", label: "Recipe", icon: Hash },
    { id: "access", label: "Access", icon: ShieldCheck },
    { id: "audit", label: "Audit", icon: Clock },
  ]

  const d = detail.data

  return (
    <div>
      <div className="sl-detail-head">
        <div style={{ minWidth: 0 }}>
          <div className="crumbs">{path}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <h2 className="display" style={{ fontSize: 22 }}>{node.name}</h2>
            <StatusBadge status={node.status} />
            {node.isSystem && <span className="badge"><Lock size={11} /> System</span>}
            <span className="badge">r{node.revision}</span>
          </div>
          <div className="mono muted" style={{ fontSize: 12.5, marginTop: 5 }}>{node.slug}</div>
        </div>
        <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
          <MovePicker options={moveOptions} label="Move" onMove={(f) => actions.moveSkill(node.id, f)} />
        </div>
      </div>

      <div className="tabs" style={{ marginTop: 20 }}>
        {TABS.map((t) => (
          <button key={t.id} className={`tab${tab === t.id ? " active" : ""}`} onClick={() => setTab(t.id)}>
            <t.icon size={14} /> {t.label}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <div className="grid g2">
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div className="section">
              <header><h3>Summary</h3></header>
              <div style={{ padding: "14px 18px", fontSize: 13.5, lineHeight: 1.55 }} className="body">{node.summary || "—"}</div>
            </div>
            <div className="section">
              <header>
                <h3><Wrench size={13} style={{ verticalAlign: -2 }} /> Required tools</h3>
                <p>Enforced required-capability list — <span className="mono">Skill.toolIds</span>. The runtime blocks the skill unless the member can use every tool here.</p>
              </header>
              <div style={{ padding: "14px 18px", display: "flex", flexWrap: "wrap", gap: 8 }}>
                {node.toolIds.length
                  ? node.toolIds.map((t) => <span key={t} className="sl-tool"><Wrench size={12} /> {toolLabel(t)}</span>)
                  : <span className="muted" style={{ fontSize: 13 }}>No required tools — usable by everyone in scope.</span>}
              </div>
            </div>
          </div>

          <div className="section" style={{ alignSelf: "start" }}>
            <header><h3>Details</h3></header>
            <div style={{ padding: "6px 18px 14px" }}>
              <div className="kv"><span className="k">Scope</span><span className="v">{isCompanyWide ? "Company-wide" : d?.departmentName ?? "Department"}</span></div>
              <div className="kv"><span className="k">Folder</span><span className="v" style={{ maxWidth: 200, textAlign: "right" }}>{d?.folderPath.join(" / ") || "Root"}</span></div>
              <div className="kv"><span className="k">Revision</span><span className="v">r{node.revision}</span></div>
              <div className="kv"><span className="k">System skill</span><span className="v">{node.isSystem ? "Yes" : "No"}</span></div>
              {d && <div className="kv"><span className="k">Updated</span><span className="v">{new Date(d.updatedAt).toLocaleDateString()}{d.updatedBy ? ` · ${d.updatedBy}` : ""}</span></div>}
              <div style={{ marginTop: 14 }}>
                <div className="sl-mini-label"><Tag size={11} /> Tags</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 7 }}>
                  {node.tags.length ? node.tags.map((t) => <span key={t} className="sl-chip">{t}</span>) : <span className="muted" style={{ fontSize: 12.5 }}>None</span>}
                </div>
              </div>
              <div style={{ marginTop: 16 }}>
                <div className="sl-mini-label"><GitBranch size={11} /> Aliases</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 7 }}>
                  {d?.aliases.length ? d.aliases.map((a) => <span key={a} className="sl-chip mono">{a}</span>) : <span className="muted" style={{ fontSize: 12.5 }}>None</span>}
                </div>
                <p className="muted" style={{ fontSize: 11.5, marginTop: 8, lineHeight: 1.5 }}>Aliases are stable lookup names. They are not authorization inputs.</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {tab === "content" && (
        <div className="section">
          <header><h3>SKILL.md</h3><p>The markdown recipe delivered to the agent.</p></header>
          <div className="raw" style={{ padding: 18 }}>
            {detail.isPending ? <span className="muted"><Loader2 size={13} className="sl-spin" /> Loading…</span> : <pre>{d?.markdown || "—"}</pre>}
          </div>
        </div>
      )}

      {tab === "access" && (
        <div className="section">
          <header style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
            <div>
              <h3><ShieldCheck size={13} style={{ verticalAlign: -2 }} /> Who can use this skill</h3>
              <p><b>Deny-by-default.</b> Only the grantees below can use this skill. Share it with a user, a whole department, a role, or the entire company — enforcement is server-side.</p>
            </div>
            <button className="btn primary" onClick={() => setManageOpen(true)}><Plus size={14} /> Manage access</button>
          </header>
          <table>
            <thead><tr><th>Grantee</th><th>Type</th><th>Granted</th></tr></thead>
            <tbody>
              {access.isPending && <tr><td colSpan={3} className="muted" style={{ textAlign: "center", padding: 22 }}><Loader2 size={13} className="sl-spin" /> Loading…</td></tr>}
              {access.data?.grants.map((g) => (
                <tr key={`${g.granteeType}:${g.granteeId}`}>
                  <td style={{ display: "flex", alignItems: "center", gap: 9 }}>
                    <span className="sl-grant-ic"><GranteeIcon type={g.granteeType} size={13} /></span>
                    <b style={{ fontWeight: 500 }}>{g.label}</b>
                    {g.detail && <span className="muted" style={{ fontSize: 12 }}>· {g.detail}</span>}
                  </td>
                  <td className="muted" style={{ textTransform: "capitalize" }}>{g.granteeType}</td>
                  <td className="muted" style={{ fontSize: 12.5 }}>{new Date(g.createdAt).toLocaleDateString()}{g.grantedBy ? ` · ${g.grantedBy}` : ""}</td>
                </tr>
              ))}
              {access.data && !access.data.grants.length && (
                <tr><td colSpan={3} className="muted" style={{ textAlign: "center", padding: 24 }}>
                  No grants yet — <b>nobody can use this skill</b>. Click “Manage access” to share it.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {manageOpen && <SkillAccessModal skillName={node.name} access={access} onClose={() => setManageOpen(false)} />}

      {tab === "audit" && (
        <div className="section">
          <header><h3>Audit trail</h3><p>Recent registry + gateway events referencing this skill.</p></header>
          <table>
            <thead><tr><th>Event</th><th>Actor</th><th>Outcome</th><th>When</th></tr></thead>
            <tbody>
              {audit.isPending && <tr><td colSpan={4} className="muted" style={{ textAlign: "center", padding: 22 }}><Loader2 size={13} className="sl-spin" /> Loading…</td></tr>}
              {audit.data?.map((a) => (
                <tr key={a.id}>
                  <td><span className="mono" style={{ fontSize: 11.5 }}>{a.action}</span></td>
                  <td className="muted">{a.actorId}</td>
                  <td>{a.outcome === "success" ? <span className="badge b-ok">ok</span> : <span className="badge b-err">{a.outcome}</span>}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{new Date(a.createdAt).toLocaleString()}</td>
                </tr>
              ))}
              {audit.data && !audit.data.length && <tr><td colSpan={4} className="muted" style={{ textAlign: "center", padding: 24 }}>No recorded events yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────
export function SkillsLabPage() {
  return (
    <SkillsUiProvider>
      <SkillsLabInner />
    </SkillsUiProvider>
  )
}

function SkillsLabInner() {
  const { session } = useAdminAuth()
  const ui = useSkillsUi()
  const data = useSkillsLabData()
  const toolLabel = useToolLabels()
  const companyName = session?.companyName ?? "Company skills"

  const root = useMemo(
    () => (data.tree ? buildUiTree(data.tree, companyName) : null),
    [data.tree, companyName],
  )

  const [selectedId, setSelectedId] = useState<string>(ROOT_ID)
  const [expanded, setExpanded] = useState<Set<string>>(new Set([ROOT_ID]))
  const [query, setQuery] = useState("")

  // Auto-expand top level the first time a tree arrives.
  useEffect(() => {
    if (!root) return
    setExpanded((prev) => {
      if (prev.size > 1) return prev
      const next = new Set(prev)
      next.add(ROOT_ID)
      root.children.forEach((c) => { if (c.kind !== "skill") next.add(c.id) })
      return next
    })
  }, [root])

  const selected = useMemo(() => (root ? findById(root, selectedId) : null), [root, selectedId])
  const totalSkills = useMemo(() => (root ? collectSkills(root).length : 0), [root])

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  return (
    <div className="page skills-lab-page">
      <SkillsLabStyles />

      <div className="ph" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 16 }}>
        <div>
          <div className="eyebrow">Skill Registry · Cloud</div>
          <h1 className="display">Skills Lab</h1>
          <p style={{ marginTop: 6 }}>Browse, organize, and govern the company skill library. Server-enforced RBAC — this console never decides who can use a skill.</p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
          {data.registryRevision !== null && <span className="sl-reg"><History size={13} /> Registry r{data.registryRevision}</span>}
          <span className="sl-reg">{totalSkills} skills</span>
        </div>
      </div>

      {data.needsCompany ? (
        <div className="card stub" style={{ marginTop: 24, padding: 40, textAlign: "center" }}>
          Select a workspace to browse its skill registry.
        </div>
      ) : (
        <div className="skills-lab">
          {/* explorer */}
          <div className="sl-tree card">
            <div className="sl-tree-head">
              <div className="search" style={{ maxWidth: "none", height: 32 }}>
                <Search size={14} className="muted" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search skills, tags, tools…"
                  style={{ border: "none", background: "none", outline: "none", width: "100%", fontSize: 12.5, color: "inherit" }}
                />
              </div>
              <div style={{ display: "flex", gap: 6, marginTop: 8, alignItems: "center" }}>
                <button className="btn" style={{ height: 30, flex: 1, fontSize: 12 }} onClick={async () => {
                  const name = await ui.prompt({ title: "New company-wide folder", placeholder: "Folder name", confirmLabel: "Create folder" })
                  if (name) void data.createFolder({ name, departmentId: null })
                }}><FolderPlus size={13} /> Folder</button>
                <button className="btn" style={{ height: 30, flex: 1, fontSize: 12 }} title="Organize existing loose skills into starter folders" onClick={async () => {
                  const ok = await ui.confirm({
                    title: "Backfill starter folders?",
                    body: "Creates a Shared folder and a General folder per department, then places loose skills into them. Safe to run repeatedly.",
                    confirmLabel: "Run backfill",
                  })
                  if (ok) void data.backfill()
                }}><FilePlus2 size={13} /> Backfill</button>
              </div>
              <label className="sl-arch-toggle">
                <input type="checkbox" checked={data.includeArchived} onChange={(e) => data.setIncludeArchived(e.target.checked)} />
                Show archived
              </label>
            </div>
            <div className="sl-tree-body">
              {data.loading ? (
                <div className="muted" style={{ padding: 16, fontSize: 12.5 }}><Loader2 size={13} className="sl-spin" /> Loading registry…</div>
              ) : data.error ? (
                <div className="muted" style={{ padding: 16, fontSize: 12.5 }}>{data.error}</div>
              ) : root ? (
                <TreeRow node={root} depth={0} selectedId={selectedId} expanded={expanded}
                  onToggle={toggle} onSelect={setSelectedId} query={query} toolLabel={toolLabel} />
              ) : null}
            </div>
          </div>

          {/* detail */}
          <div className="sl-detail">
            {root && selected ? (
              selected.kind === "skill" ? (
                <SkillDetail node={selected} root={root} actions={data} toolLabel={toolLabel} />
              ) : (
                <FolderDetail node={selected} root={root} actions={data} toolLabel={toolLabel} />
              )
            ) : (
              <div className="stub">Select a skill or folder to inspect it.</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Scoped styles (tree + explorer chrome, all via --cur tokens) ─────────────
function SkillsLabStyles() {
  return (
    <style>{`
      .cur .skills-lab-page { max-width: 1320px; }
      .cur .sl-reg { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 11px;
        border-radius: 999px; border: 1px solid var(--cur-hairline-strong); background: var(--cur-surface);
        font-size: 12px; color: var(--cur-muted); }
      .cur .skills-lab { display: grid; grid-template-columns: 300px 1fr; gap: 18px; align-items: start; margin-top: 20px; }

      .cur .sl-tree { position: sticky; top: 18px; overflow: hidden; }
      .cur .sl-tree-head { padding: 12px; border-bottom: 1px solid var(--cur-hairline); }
      .cur .sl-tree-body { padding: 8px 8px 12px; max-height: calc(100vh - 232px); overflow: auto; }

      .cur .sl-arch-toggle { display: flex; align-items: center; gap: 7px; margin-top: 9px; font-size: 12px;
        color: var(--cur-muted); cursor: pointer; user-select: none; }
      .cur .sl-arch-toggle input { accent-color: var(--cur-primary); }

      .cur .sl-node { display: flex; align-items: center; gap: 7px; height: 30px; padding-right: 8px;
        border-radius: 7px; cursor: pointer; user-select: none; font-size: 13px; color: var(--cur-body); }
      .cur .sl-node:hover { background: var(--cur-surface-strong); color: var(--cur-ink); }
      .cur .sl-node.active { background: color-mix(in srgb, var(--cur-primary) 12%, transparent); color: var(--cur-ink);
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--cur-primary) 30%, transparent); }
      .cur .sl-node-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
      .cur .sl-caret { color: var(--cur-muted); transition: transform .15s; flex-shrink: 0; }
      .cur .sl-folder-ic { color: var(--cur-tl-done); flex-shrink: 0; }
      .cur .sl-skill-ic { color: var(--cur-primary); flex-shrink: 0; }
      .cur .sl-arch { color: var(--cur-muted); flex-shrink: 0; }
      .cur .sl-count { font-size: 10.5px; color: var(--cur-muted); background: var(--cur-surface-strong);
        border-radius: 999px; padding: 1px 7px; }

      .cur .sl-detail-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
      .cur .sl-move-select { height: 32px; border-radius: 8px; border: 1px solid var(--cur-hairline-strong);
        background: var(--cur-surface); color: var(--cur-ink); font-size: 12.5px; padding: 0 8px; }

      .cur .sl-tool { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 500;
        padding: 5px 10px; border-radius: 7px; background: color-mix(in srgb, var(--cur-primary) 9%, transparent);
        color: var(--cur-ink); border: 1px solid color-mix(in srgb, var(--cur-primary) 22%, transparent); }
      .cur .sl-tool svg { color: var(--cur-primary); }
      .cur .sl-chip { font-size: 12px; padding: 3px 9px; border-radius: 999px; background: var(--cur-surface-strong); color: var(--cur-ink); }
      .cur .sl-mini-label { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.07em; font-weight: 600;
        color: var(--cur-muted); display: flex; align-items: center; gap: 6px; }

      .cur .sl-spin { display: inline-block; vertical-align: -2px; animation: sl-spin 0.7s linear infinite; }
      @keyframes sl-spin { to { transform: rotate(360deg); } }

      /* Manage-access modal */
      .cur .sl-modal-scrim { position: fixed; inset: 0; z-index: 60; background: color-mix(in srgb, #000 55%, transparent);
        display: flex; align-items: flex-start; justify-content: center; padding: 7vh 16px 16px; overflow: auto; }
      .cur .sl-modal { width: 100%; max-width: 560px; padding: 20px; }
      .cur .sl-modal-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 6px; }
      .cur .sl-icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px;
        border-radius: 8px; border: 1px solid transparent; background: none; color: var(--cur-muted); cursor: pointer; flex-shrink: 0; }
      .cur .sl-icon-btn:hover { background: var(--cur-surface-strong); color: var(--cur-ink); }
      .cur .sl-input { width: 100%; height: 38px; margin-top: 10px; padding: 0 12px; border-radius: 9px;
        border: 1px solid var(--cur-hairline-strong); background: var(--cur-surface); color: var(--cur-ink);
        font-size: 13.5px; outline: none; }
      .cur .sl-input:focus { border-color: color-mix(in srgb, var(--cur-primary) 55%, transparent);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--cur-primary) 16%, transparent); }
      .cur .sl-modal-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
      .cur .sl-candidates { margin-top: 12px; max-height: 220px; overflow: auto; border: 1px solid var(--cur-hairline);
        border-radius: 9px; }
      .cur .sl-candidate { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; padding: 9px 12px;
        background: none; border: none; border-bottom: 1px solid var(--cur-hairline); cursor: pointer; color: var(--cur-body); }
      .cur .sl-candidate:last-child { border-bottom: none; }
      .cur .sl-candidate:hover { background: var(--cur-surface-strong); }
      .cur .sl-candidate.on { background: color-mix(in srgb, var(--cur-primary) 12%, transparent); color: var(--cur-ink); }
      .cur .sl-candidate svg { color: var(--cur-muted); flex-shrink: 0; }
      .cur .sl-cand-label { display: block; font-size: 13px; font-weight: 500; color: var(--cur-ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .cur .sl-cand-detail { display: block; font-size: 11.5px; color: var(--cur-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .cur .sl-grant-row { display: flex; align-items: center; gap: 11px; padding: 9px 12px; border-radius: 8px; }
      .cur .sl-grant-row:hover { background: var(--cur-canvas-soft); }
      .cur .sl-grant-ic { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px;
        border-radius: 7px; background: var(--cur-surface-strong); color: var(--cur-muted); flex-shrink: 0; }

      @media (max-width: 900px) { .cur .skills-lab { grid-template-columns: 1fr; } .cur .sl-tree { position: static; } }
    `}</style>
  )
}
