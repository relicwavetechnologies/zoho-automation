/**
 * "Company → Skills" — the cloud Skill Registry, in the workspace shell.
 *
 * This replaces the standalone Skills Lab page. The data layer underneath is
 * unchanged (`data/use-skills`) because it was already the real thing: a live
 * registry tree, real folder and skill mutations, real grants.
 * Only the presentation moved, so this is a re-skin and not a rewrite.
 *
 * Two ideas the old page got right and this one keeps:
 *
 *   - **A skill with no grants is unusable.** Deny-by-default is the backend's
 *     rule, so an empty access list has to read as "nobody can run this" and
 *     not as an empty table.
 *   - **Required tools are a gate, not a label.** `Skill.toolIds` is enforced;
 *     a member missing any one of those tools cannot run the skill however it
 *     is shared. Both facts are stated in the reader's words rather than left
 *     to be inferred.
 *
 * Nothing here decides access. Every question is answered server-side and this
 * screen reflects the answer.
 */
import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Archive, Boxes, Building2, Check, ChevronRight, FolderClosed, FolderOpen, FolderPlus,
  History, Layers, Lock, Pencil, Search, ShieldCheck, Sparkles, Trash2, User, Wrench,
} from 'lucide-react'
import {
  Confirm, Drawer, Empty, Fade, NoAccess, PageHeader, Panel, Prompt, Seg, SkelRows,
  isRefusal,
} from './ui'
import { useAdminAuth } from '@/auth/AdminAuthProvider'
import { ago } from './data/use-company'
import type {
  SkillGranteeCandidate, SkillGranteeType,
  SkillRegistryFolderNode, SkillRegistrySkillNode, SkillRegistryTree,
} from '@/lib/api'
import {
  useSkillAccess, useSkillAudit, useSkillDetail, useSkillRegistry, useToolLabels,
} from './data/use-skills'

type Props = { replay: number; toast: (m: string) => void }

/* ── The tree, flattened from the backend DTO ─────────
   The registry has two roots — company-wide and one per department — and the
   explorer shows them as one tree so a person can see the whole library at
   once. `departmentId` rides along on every node because it is what decides
   where a folder or skill is allowed to move. */
type UiSkill = SkillRegistrySkillNode & { kind: 'skill' }
type UiFolder = {
  kind: 'company' | 'department' | 'folder'
  id: string
  name: string
  departmentId: string | null
  status: string
  children: UiNode[]
}
type UiNode = UiFolder | UiSkill

const ROOT_ID = '__root'

const mapSkill = (s: SkillRegistrySkillNode): UiSkill => ({ ...s, kind: 'skill' })

const mapFolder = (f: SkillRegistryFolderNode): UiFolder => ({
  kind: 'folder',
  id: f.id,
  name: f.name,
  departmentId: f.departmentId,
  status: f.status,
  children: [...f.children.map(mapFolder), ...f.skills.map(mapSkill)],
})

const buildTree = (tree: SkillRegistryTree, companyName: string): UiFolder => ({
  kind: 'company',
  id: ROOT_ID,
  name: companyName,
  departmentId: null,
  status: 'active',
  children: [
    ...tree.companyWide.folders.map(mapFolder),
    ...tree.companyWide.skills.map(mapSkill),
    ...tree.departments.map((d) => ({
      kind: 'department' as const,
      id: d.id,
      name: d.name,
      departmentId: d.id,
      status: 'active',
      children: [...d.folders.map(mapFolder), ...d.skills.map(mapSkill)],
    })),
  ],
})

const collectSkills = (node: UiNode, acc: UiSkill[] = []): UiSkill[] => {
  if (node.kind === 'skill') acc.push(node)
  else node.children.forEach((c) => collectSkills(c, acc))
  return acc
}

const findById = (node: UiNode, id: string): UiNode | null => {
  if (node.id === id) return node
  if (node.kind === 'skill') return null
  for (const c of node.children) {
    const hit = findById(c, id)
    if (hit) return hit
  }
  return null
}

const pathTo = (node: UiNode, id: string, trail: string[] = []): string[] | null => {
  const here = [...trail, node.name]
  if (node.id === id) return here
  if (node.kind === 'skill') return null
  for (const c of node.children) {
    const hit = pathTo(c, id, here)
    if (hit) return hit
  }
  return null
}

/** Real folders only — the company and department roots are not move targets. */
const collectFolders = (node: UiNode, acc: UiFolder[] = []): UiFolder[] => {
  if (node.kind === 'skill') return acc
  if (node.kind === 'folder') acc.push(node)
  node.children.forEach((c) => collectFolders(c, acc))
  return acc
}

/* ── Small pieces ─────────────────────────────────────*/
const nodeIcon = (node: UiNode, open: boolean) =>
  node.kind === 'skill' ? Sparkles
    : node.kind === 'company' ? Boxes
      : node.kind === 'department' ? Building2
        : open ? FolderOpen : FolderClosed

const GranteeIcon = ({ type, size = 14 }: { type: SkillGranteeType; size?: number }) =>
  type === 'user' ? <User size={size} />
    : type === 'department' ? <Building2 size={size} />
      : type === 'role' ? <ShieldCheck size={size} />
        : <Boxes size={size} />

const GRANTEE_NOUN: Record<SkillGranteeType, string> = {
  user: 'person', department: 'department', role: 'role', company: 'company',
}

/** Archived is the only status worth interrupting a row for. */
const Archived = () => <span className="ws-tag">Archived</span>

/**
 * What a tab shows before — or instead of — its answer.
 *
 * Each tab here runs its own query, and each can fail on its own. The trap is
 * that a failed read looks exactly like an empty result: no grants came back,
 * so the page says "nobody can run this skill". That is a claim about the
 * world, and a 403 is not evidence for it. So loading, refused and broken each
 * get their own sentence, and the tab only reaches its empty state once the
 * read has actually succeeded.
 */
function TabState({ query, what, skeleton }: {
  query: { isPending: boolean; isError: boolean; error: unknown }
  what: string
  skeleton: ReactNode
}) {
  if (query.isPending) return <>{skeleton}</>
  if (isRefusal(query.error)) {
    return <NoAccess what={what} who="A company administrator can open this for you." />
  }
  if (query.isError) {
    return <div className="ws-panel-body ws-sub">Could not load {what}. Try again in a moment.</div>
  }
  return null
}

/**
 * Destination picker.
 *
 * A select rather than a drag target: moving a skill between folders is a rare,
 * deliberate act, and drag-and-drop in a tree this shallow is more ways to get
 * it wrong than ways to get it right.
 */
function MoveTo({ options, onMove }: {
  options: { id: string; label: string }[]
  onMove: (folderId: string | null) => void
}) {
  return (
    <select
      className="select"
      value="__pick"
      aria-label="Move to"
      onChange={(e) => {
        const v = e.target.value
        if (v === '__pick') return
        onMove(v === '__root' ? null : v)
      }}
    >
      <option value="__pick">Move to…</option>
      <option value="__root">Root (no folder)</option>
      {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
    </select>
  )
}

/* ── Explorer ─────────────────────────────────────────*/
function TreeRow({ node, depth, selectedId, expanded, onToggle, onSelect, query, toolLabel }: {
  node: UiNode
  depth: number
  selectedId: string
  expanded: Set<string>
  onToggle: (id: string) => void
  onSelect: (id: string) => void
  query: string
  toolLabel: (id: string) => string
}) {
  const q = query.trim().toLowerCase()

  // A folder survives the filter if anything inside it does — otherwise
  // searching would empty the tree and hide the very thing it found.
  const matches = (n: UiNode): boolean => {
    if (n.kind === 'skill') {
      return !q
        || n.name.toLowerCase().includes(q)
        || n.slug.includes(q)
        || n.tags.some((t) => t.includes(q))
        || n.toolIds.some((t) => toolLabel(t).toLowerCase().includes(q))
    }
    return n.children.some(matches)
  }
  if (!matches(node)) return null

  const isSkill = node.kind === 'skill'
  const open = expanded.has(node.id) || q.length > 0
  const Icon = nodeIcon(node, open)

  return (
    <>
      <button
        type="button"
        className="ws-node"
        data-on={selectedId === node.id}
        data-open={open}
        style={{ paddingLeft: 10 + depth * 14 }}
        onClick={() => { onSelect(node.id); if (!isSkill) onToggle(node.id) }}
      >
        {isSkill
          ? <span style={{ width: 12, flexShrink: 0 }} />
          : <ChevronRight size={12} className="cv" />}
        <Icon size={14} className="ws-node-ic" data-skill={isSkill} />
        <span className="nm">{node.name}</span>
        {isSkill && node.status === 'archived' ? <Archive size={11} className="cv" /> : null}
        {!isSkill && node.kind !== 'company' ? <span className="ct">{collectSkills(node).length}</span> : null}
      </button>
      {!isSkill && open
        ? (node as UiFolder).children.map((c) => (
          <TreeRow key={c.id} node={c} depth={depth + 1} selectedId={selectedId} expanded={expanded}
            onToggle={onToggle} onSelect={onSelect} query={query} toolLabel={toolLabel} />
        ))
        : null}
    </>
  )
}

/* ── Folder detail ────────────────────────────────────*/
function FolderView({ node, root, data, toolLabel, onOpen }: {
  node: UiFolder
  root: UiFolder
  data: ReturnType<typeof useSkillRegistry>
  toolLabel: (id: string) => string
  onOpen: (id: string) => void
}) {
  const [dialog, setDialog] = useState<'new' | 'rename' | 'archive' | null>(null)

  const skills = collectSkills(node)
  const subfolders = node.children.filter((c) => c.kind !== 'skill').length
  const isFolder = node.kind === 'folder'
  const kind = node.kind === 'company' ? 'Company library'
    : node.kind === 'department' ? 'Department library' : 'Folder'

  // A folder can only move within its own scope: a department folder never
  // becomes company-wide by being dragged somewhere, because that would widen
  // who can see everything inside it.
  const moveOptions = useMemo(
    () => collectFolders(root)
      .filter((f) => f.id !== node.id && f.departmentId === node.departmentId)
      .map((f) => ({ id: f.id, label: pathTo(root, f.id)?.slice(1).join(' / ') ?? f.name })),
    [root, node.id, node.departmentId],
  )

  const createHere = (name: string) => {
    if (node.kind === 'company') return data.createFolder({ name, departmentId: null })
    if (node.kind === 'department') return data.createFolder({ name, departmentId: node.departmentId })
    return data.createFolder({ name, parentId: node.id })
  }

  return (
    <>
      <Panel
        title={node.name}
        description={`${kind}${node.departmentId ? '' : ' · company-wide'} · ${skills.length} skill${skills.length === 1 ? '' : 's'} · ${subfolders} folder${subfolders === 1 ? '' : 's'}`}
        aside={
          <div className="ws-row-act">
            {isFolder ? (
              <>
                <MoveTo options={moveOptions} onMove={(f) => void data.moveFolder(node.id, f)} />
                <button type="button" className="btn" onClick={() => setDialog('rename')}>
                  <Pencil size={13} /> Rename
                </button>
                <button type="button" className="btn" onClick={() => setDialog('archive')}>
                  <Archive size={13} /> Archive
                </button>
              </>
            ) : null}
            <button type="button" className="btn" onClick={() => setDialog('new')}>
              <FolderPlus size={13} /> New folder
            </button>
          </div>
        }
      >
        {node.children.length === 0 ? (
          <Empty
            icon={FolderClosed}
            title="Nothing in here yet"
            body="Create a folder, or move a skill into this one from its own page."
          />
        ) : (
          <div className="ws-rows">
            {node.children.map((c) => (
              <div key={c.id} className="ws-row click" role="button" tabIndex={0}
                onClick={() => onOpen(c.id)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(c.id) } }}
              >
                <span className="ws-ic">
                  {c.kind === 'skill' ? <Sparkles size={14} /> : <FolderClosed size={14} />}
                </span>
                <div className="ws-row-main">
                  <b>
                    {c.name}
                    {c.kind === 'skill' && c.status === 'archived' ? <Archived /> : null}
                  </b>
                  <p>
                    {c.kind === 'skill'
                      ? (c.summary || (c.toolIds.length ? `Needs ${c.toolIds.map(toolLabel).join(', ')}` : 'No required tools'))
                      : `${collectSkills(c).length} skill${collectSkills(c).length === 1 ? '' : 's'} inside`}
                  </p>
                </div>
                <ChevronRight size={14} className="ws-chev" />
              </div>
            ))}
          </div>
        )}
      </Panel>

      {dialog === 'new' ? (
        <Prompt
          title={`New folder in ${node.name}`}
          description="Folders are for finding things. They do not grant access — sharing is decided per skill."
          label="Folder name"
          placeholder="e.g. Reporting"
          confirm="Create folder"
          onConfirm={(name) => createHere(name)}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog === 'rename' ? (
        <Prompt
          title="Rename folder"
          label="New name"
          initial={node.name}
          confirm="Rename"
          onConfirm={(name) => data.renameFolder(node.id, name)}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog === 'archive' ? (
        <Confirm
          title={`Archive ${node.name}?`}
          body="Folders inside it are archived too, and every skill in them falls back to the root. No skill is deleted and nobody loses access."
          confirm="Archive folder"
          onConfirm={() => data.archiveFolder(node.id)}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </>
  )
}

/* ── Skill detail ─────────────────────────────────────*/
type Tab = 'overview' | 'recipe' | 'access' | 'audit'

function SkillView({ node, root, data, toolLabel }: {
  node: UiSkill
  root: UiFolder
  data: ReturnType<typeof useSkillRegistry>
  toolLabel: (id: string) => string
}) {
  const [tab, setTab] = useState<Tab>('overview')
  const [shareOpen, setShareOpen] = useState(false)

  const detail = useSkillDetail(node.id)
  const access = useSkillAccess(node.id)
  const audit = useSkillAudit(node.id)

  const isCompanyWide = node.scope === 'company' || node.scope === 'global'
  const moveOptions = useMemo(
    () => collectFolders(root)
      .filter((f) => (isCompanyWide ? f.departmentId === null : f.departmentId === node.departmentId))
      .map((f) => ({ id: f.id, label: pathTo(root, f.id)?.slice(1).join(' / ') ?? f.name })),
    [root, node.departmentId, isCompanyWide],
  )

  const d = detail.data
  const grants = access.data?.grants ?? []
  const folderPath = d?.folderPath.join(' / ') || 'Root'

  return (
    <>
      <Panel
        title={node.name}
        description={node.summary || 'No summary.'}
        source="skillRegistry"
        aside={
          <div className="ws-row-act">
            <MoveTo options={moveOptions} onMove={(f) => void data.moveSkill(node.id, f)} />
          </div>
        }
      >
        <div className="ws-panel-body" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="mono ws-sub">{node.slug}</span>
          {node.status === 'archived' ? <Archived /> : null}
          {node.isSystem ? <span className="ws-tag"><Lock size={10} /> Built in</span> : null}
          <span className="ws-tag">Revision {node.revision}</span>
        </div>

        <div className="ws-panel-body" style={{ paddingTop: 0 }}>
          <Seg
            value={tab}
            onChange={setTab}
            options={[
              { value: 'overview', label: 'Overview' },
              { value: 'recipe', label: 'Recipe' },
              { value: 'access', label: `Access${grants.length ? ` · ${grants.length}` : ''}` },
              { value: 'audit', label: 'History' },
            ]}
          />
        </div>

        {tab === 'overview' ? (
          <Fade>
            <div className="ws-panel-body" style={{ paddingTop: 0 }}>
              <div className="ws-lbl">Tools this skill needs</div>
              <p className="ws-sub" style={{ marginTop: 6, lineHeight: 1.5 }}>
                Enforced, not advisory. Somebody who cannot use every tool listed here cannot run
                this skill, however it is shared.
              </p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
                {node.toolIds.length
                  ? node.toolIds.map((t) => (
                    <span key={t} className="ws-tag"><Wrench size={10} /> {toolLabel(t)}</span>
                  ))
                  : <span className="ws-sub">No tools required — anyone it is shared with can run it.</span>}
              </div>
            </div>

            {/* Everything above comes from the tree, which is already loaded.
                Everything below comes from the skill's own read, so it waits
                for it rather than printing "Root" and "None" on a failure. */}
            <TabState
              query={detail}
              what="this skill's details"
              skeleton={<div className="ws-panel-body"><SkelRows n={3} icon={false} /></div>}
            />
            {detail.isSuccess && d ? (
              <>
                <div className="ws-kv">
                  <div><span>Belongs to</span><b>{isCompanyWide ? 'The whole company' : d.departmentName ?? 'A department'}</b></div>
                  <div><span>Folder</span><b>{folderPath}</b></div>
                  <div><span>Tags</span><b>{node.tags.length ? node.tags.join(', ') : 'None'}</b></div>
                  <div><span>Other names</span><b>{d.aliases.length ? d.aliases.join(', ') : 'None'}</b></div>
                  <div><span>Last changed</span><b>{ago(d.updatedAt)}</b></div>
                </div>
                <div className="ws-panel-foot">
                  Other names are lookup aliases. They are not part of who is allowed to run this.
                </div>
              </>
            ) : null}
          </Fade>
        ) : null}

        {tab === 'recipe' ? (
          <Fade>
            <TabState
              query={detail}
              what="this skill's recipe"
              skeleton={<div className="ws-panel-body"><SkelRows n={3} icon={false} /></div>}
            />
            {detail.isSuccess
              ? <pre className="ws-code">{d?.markdown || 'This skill has no written recipe.'}</pre>
              : null}
          </Fade>
        ) : null}

        {tab === 'access' ? (
          <Fade>
            {/* Offering "Share" while the read was refused would promise an
                action the backend is going to refuse just as firmly. */}
            {access.isSuccess ? (
              <div className="ws-panel-body" style={{ paddingTop: 0, display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-end' }}>
                <p className="ws-sub" style={{ lineHeight: 1.5, maxWidth: 460 }}>
                  Nobody can run this skill unless they appear below. Share it with one person, a
                  department, a role, or everybody — the runtime enforces it, not this page.
                </p>
                <button type="button" className="btn primary" onClick={() => setShareOpen(true)}>
                  <ShieldCheck size={13} /> Share
                </button>
              </div>
            ) : null}
            <TabState query={access} what="who can run this skill" skeleton={<SkelRows n={2} />} />
            {access.isSuccess && grants.length === 0 ? (
              <Empty
                icon={Lock}
                title="Nobody can run this skill"
                body="It exists in the library but has not been shared with anyone yet."
                action={<button type="button" className="btn primary" onClick={() => setShareOpen(true)}>Share it</button>}
              />
            ) : null}
            {grants.length ? (
              <div className="ws-rows">
                {grants.map((g) => (
                  <div key={`${g.granteeType}:${g.granteeId}`} className="ws-row">
                    <span className="ws-ic"><GranteeIcon type={g.granteeType} /></span>
                    <div className="ws-row-main">
                      <b>{g.label}</b>
                      <p>
                        {GRANTEE_NOUN[g.granteeType]}
                        {g.detail ? ` · ${g.detail}` : ''}
                        {` · shared ${ago(g.createdAt)}`}
                      </p>
                    </div>
                    <div className="ws-row-act">
                      <button type="button" className="icon-btn" title="Stop sharing"
                        onClick={() => void access.revoke(g.granteeType, g.granteeId)}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </Fade>
        ) : null}

        {tab === 'audit' ? (
          <Fade>
            <TabState query={audit} what="this skill's history" skeleton={<SkelRows n={3} icon={false} />} />
            {audit.isSuccess && !audit.data?.length ? (
              <Empty icon={History} title="Nothing recorded yet" body="Changes to this skill and its sharing will appear here." />
            ) : null}
            {audit.data?.length ? (
              <div className="ws-rows">
                {audit.data.map((a) => (
                  <div key={a.id} className="ws-row">
                    <div className="ws-row-main">
                      <b className="mono" style={{ fontSize: 12 }}>{a.action}</b>
                      <p>{a.actorId} · {ago(a.createdAt)}</p>
                    </div>
                    <div className="ws-row-act">
                      {a.outcome === 'success'
                        ? <span className="ws-tag"><Check size={10} /> Done</span>
                        : <span className="ws-tag" data-tone="warn">{a.outcome}</span>}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </Fade>
        ) : null}
      </Panel>

      {shareOpen ? (
        <ShareDrawer skillName={node.name} access={access} onClose={() => setShareOpen(false)} />
      ) : null}
    </>
  )
}

/* ── Share drawer ─────────────────────────────────────*/
function ShareDrawer({ skillName, access, onClose }: {
  skillName: string
  access: ReturnType<typeof useSkillAccess>
  onClose: () => void
}) {
  const [type, setType] = useState<SkillGranteeType>('department')
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState('')
  const [busy, setBusy] = useState(false)
  const data = access.data

  const candidates = useMemo<SkillGranteeCandidate[]>(() => {
    if (!data) return []
    if (type === 'user') return data.candidates.users
    if (type === 'department') return data.candidates.departments
    if (type === 'role') return data.candidates.roles
    return data.candidates.company ? [data.candidates.company] : []
  }, [data, type])

  const q = query.trim().toLowerCase()
  const shown = candidates.filter((c) =>
    !q || c.label.toLowerCase().includes(q) || (c.detail ?? '').toLowerCase().includes(q))

  const switchType = (t: SkillGranteeType) => {
    setType(t)
    setQuery('')
    // "Everybody" has exactly one target, so there is nothing to choose.
    setPicked(t === 'company' ? (data?.candidates.company?.granteeId ?? '') : '')
  }

  const share = async () => {
    if (!picked || busy) return
    setBusy(true)
    try { await access.grant(type, picked); setPicked('') } finally { setBusy(false) }
  }

  return (
    <Drawer
      title="Share this skill"
      subtitle={`Anyone you add can run ${skillName}, as long as they can also use every tool it needs.`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Done</button>
          <button type="button" className="btn primary" disabled={!picked || busy} onClick={() => void share()}>
            {busy ? 'Sharing…' : 'Share'}
          </button>
        </>
      }
    >
      <div className="ws-lbl">Share with</div>
      <div style={{ marginTop: 8 }}>
        <Seg
          value={type}
          onChange={switchType}
          options={[
            { value: 'user', label: 'A person' },
            { value: 'department', label: 'A department' },
            { value: 'role', label: 'A role' },
            { value: 'company', label: 'Everybody' },
          ]}
        />
      </div>

      {type === 'company' ? (
        <p className="ws-sub" style={{ marginTop: 14, lineHeight: 1.5 }}>
          Everyone in the company will be able to run it — subject to the tools it needs.
        </p>
      ) : (
        <div className="search" style={{ marginTop: 14 }}>
          <Search size={14} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${GRANTEE_NOUN[type]}s`}
          />
        </div>
      )}

      <div className="ws-rows" style={{ marginTop: 10 }}>
        {shown.length === 0 ? (
          <p className="ws-sub" style={{ padding: '16px 0' }}>
            {q ? 'Nothing matches that.' : `No ${GRANTEE_NOUN[type]} is available to share with.`}
          </p>
        ) : null}
        {/* `div role="button"` rather than a real one: the row carries a
            heading and a line of detail, and a <button> may only contain
            phrasing content. Same pattern as the folder contents list. */}
        {shown.map((c) => (
          <div
            key={c.granteeId}
            className="ws-row click"
            role="button"
            tabIndex={0}
            aria-pressed={picked === c.granteeId}
            data-on={picked === c.granteeId}
            onClick={() => setPicked(c.granteeId)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPicked(c.granteeId) } }}
          >
            <span className="ws-ic"><GranteeIcon type={type} /></span>
            <div className="ws-row-main">
              <b>{c.label}</b>
              {c.detail ? <p>{c.detail}</p> : null}
            </div>
            {picked === c.granteeId ? <Check size={15} /> : null}
          </div>
        ))}
      </div>
    </Drawer>
  )
}

/* ── Screen ───────────────────────────────────────────*/
/* `replay` drives the staged skeletons on the fixture screens. This one has
   real queries with real pending states, so it is deliberately ignored. */
export function CompanySkills(_: Props) {
  const { session } = useAdminAuth()
  const data = useSkillRegistry()
  const toolLabel = useToolLabels()

  const [selectedId, setSelectedId] = useState(ROOT_ID)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([ROOT_ID]))
  const [query, setQuery] = useState('')
  const [newRoot, setNewRoot] = useState(false)
  const [backfill, setBackfill] = useState(false)

  const root = useMemo(
    () => (data.tree ? buildTree(data.tree, session?.companyName ?? 'Company') : null),
    [data.tree, session?.companyName],
  )

  // First tree in: open the top level so the library is visible rather than a
  // single collapsed row. Later navigations leave the person's own state alone.
  useEffect(() => {
    if (!root) return
    setExpanded((prev) => {
      if (prev.size > 1) return prev
      const next = new Set(prev)
      root.children.forEach((c) => { if (c.kind !== 'skill') next.add(c.id) })
      return next
    })
  }, [root])

  const selected = useMemo(() => (root ? findById(root, selectedId) : null), [root, selectedId])
  const total = useMemo(() => (root ? collectSkills(root).length : 0), [root])

  const toggle = (id: string) => setExpanded((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  const open = (id: string) => {
    setSelectedId(id)
    setExpanded((prev) => new Set(prev).add(id))
  }

  const header = (
    <PageHeader
      eyebrow="Company"
      title="Skills"
      description="Everything Divo knows how to do here, who each one belongs to, and who is allowed to run it."
      actions={
        <>
          {/* Both counts come from the tree. Without it there is no answer,
              and "0 skills" over a refusal panel would be the wrong one. */}
          {root ? (
            <>
              {data.registryRevision !== null
                ? <span className="ws-tag"><History size={10} /> Registry r{data.registryRevision}</span>
                : null}
              <span className="ws-tag">{total} skill{total === 1 ? '' : 's'}</span>
            </>
          ) : null}
        </>
      }
    />
  )

  if (data.needsCompany) {
    return (
      <>
        {header}
        <Panel>
          <Empty
            icon={Building2}
            title="Pick a workspace first"
            body="Skills belong to a company. Choose one to see its library."
          />
        </Panel>
      </>
    )
  }

  if (isRefusal(data.errorCause)) {
    return (
      <>
        {header}
        <Panel>
          <NoAccess what="the skill library" who="A company administrator can open this for you." />
        </Panel>
      </>
    )
  }

  return (
    <>
      {header}

      <div className="ws-skills">
        <Panel>
          <div className="ws-panel-body" style={{ paddingBottom: 10 }}>
            <div className="search">
              <Search size={14} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search skills, tags, tools"
              />
            </div>
            <div className="ws-row-act" style={{ marginTop: 9 }}>
              <button type="button" className="btn" style={{ flex: 1 }} onClick={() => setNewRoot(true)}>
                <FolderPlus size={13} /> Folder
              </button>
              <button type="button" className="btn" style={{ flex: 1 }} onClick={() => setBackfill(true)}>
                <Layers size={13} /> Tidy up
              </button>
            </div>
            <label className="ws-check" style={{ marginTop: 10 }}>
              <input
                type="checkbox"
                checked={data.includeArchived}
                onChange={(e) => data.setIncludeArchived(e.target.checked)}
              />
              Show archived
            </label>
          </div>

          {data.loading ? <SkelRows n={5} icon={false} /> : null}
          {!data.loading && data.error ? (
            <div className="ws-panel-body ws-sub">{data.error}</div>
          ) : null}
          {!data.loading && root ? (
            <div className="ws-tree">
              <TreeRow node={root} depth={0} selectedId={selectedId} expanded={expanded}
                onToggle={toggle} onSelect={setSelectedId} query={query} toolLabel={toolLabel} />
            </div>
          ) : null}
        </Panel>

        <div className="ws-stack">
          {root && selected ? (
            /* Keyed on the selection so picking a different skill remounts the
               panel: tab, share drawer and any half-open dialog reset rather
               than carrying over from the last thing you looked at. */
            <Fragment key={selected.id}>
              {selected.kind === 'skill'
                ? <SkillView node={selected} root={root} data={data} toolLabel={toolLabel} />
                : <FolderView node={selected} root={root} data={data} toolLabel={toolLabel} onOpen={open} />}
            </Fragment>
          ) : (
            <Panel>
              <Empty
                icon={Sparkles}
                title={data.loading ? 'Loading the library' : 'Pick something on the left'}
                body={data.loading ? undefined : 'Choose a folder to see what is in it, or a skill to see who can run it.'}
              />
            </Panel>
          )}
        </div>
      </div>

      {newRoot ? (
        <Prompt
          title="New company-wide folder"
          description="Company-wide folders sit above the departments. They organise; they do not grant anything."
          label="Folder name"
          placeholder="e.g. Shared"
          confirm="Create folder"
          onConfirm={(name) => data.createFolder({ name, departmentId: null })}
          onClose={() => setNewRoot(false)}
        />
      ) : null}

      {backfill ? (
        <Confirm
          title="Tidy the library?"
          body="Creates a Shared folder for the company and a General folder in each department, then files loose skills into them. Nothing is deleted and nobody's access changes. Safe to run more than once."
          confirm="Tidy up"
          onConfirm={() => data.backfill()}
          onClose={() => setBackfill(false)}
        />
      ) : null}
    </>
  )
}
