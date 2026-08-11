/**
 * The agent map.
 *
 * One question, asked visually: *if this person asks Divo for something, what
 * can actually happen?*
 *
 * Divo sits in the middle because it is the only entry point — every request
 * goes through the orchestrator, and the orchestrator resolves permissions
 * before anything runs. Each surrounding node is an agent: by default one per
 * tool family, plus any an admin authored. The individual tools are what that
 * agent can do, and they live in the drawer, because nobody wants to configure
 * "AITable Fields" separately from "AITable Datasheets".
 *
 * An edge is drawn when the chosen person may really reach that agent. The ones
 * they cannot reach are pushed to an outer ring rather than hidden, because
 * "you cannot do this" is an answer worth seeing.
 *
 * WHAT IS REAL. The permissions, the people, the tools and their actions are
 * live (see `use-agent-graph.ts`). Everything you can *edit* here — name,
 * instructions, model, container, memory, which tools an agent owns — is stored
 * in this browser and nowhere else, because the backend has no agent table yet.
 * Every editable block says so rather than pretending.
 */
import { useCallback, useMemo, useState } from 'react'
import {
  Background, BackgroundVariant, Controls, Handle, Position, ReactFlow,
  type Edge, type Node, type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Bot, Boxes, Brain, CircleSlash, Cpu, ShieldCheck, Sparkles, Trash2, Wrench } from 'lucide-react'
import { useCompanyDepartments } from './data/use-company'
import { useManagedDepartments } from './data/use-team'
import { useMyModelOptions } from './data/use-my-activity'
import {
  CONTAINER_LABEL, MEMORY_SCOPE_LABEL, PROVENANCE_LABEL,
  familyName, familyOf, useAgentGraph,
  type AgentConfig, type AgentNode as AgentModel, type AgentTool, type ToolFamily,
} from './data/use-agent-graph'
import {
  blankAgent, deleteAgent, saveAgent,
  type AgentDefinition, type ContainerMode, type MemoryScope,
} from './data/agent-store'
import {
  DataNote, DrawerGrip, Empty, NoAccess, PageHeader, Panel, Seg, Switch,
  useDrawerWidth, useStaged, type Toast,
} from './ui'

type Props = { replay: number; toast: Toast; go: (screen: string) => void }

/* ── Layout ────────────────────────────────────────────────
   Two rings. What the person can reach sits close to Divo, what they cannot is
   pushed out. The distance is the message — a glance tells you how much of the
   company this person's Divo can actually touch. */

const NODE_W = 186
const NODE_H = 60

function ring(count: number, radius: number, index: number) {
  // Start at the top and go clockwise, so the first agent is where the eye
  // lands rather than off to the right.
  const angle = (index / Math.max(count, 1)) * Math.PI * 2 - Math.PI / 2
  return {
    x: Math.cos(angle) * radius - NODE_W / 2,
    y: Math.sin(angle) * radius - NODE_H / 2,
  }
}

/** Rings grow with their population so nodes never collide. */
const radiusFor = (count: number, min: number) => Math.max(min, (count * (NODE_W + 40)) / (Math.PI * 2))

/* ── Nodes ─────────────────────────────────────────────── */

type OrchestratorData = { reachable: number; total: number; person: string | null }
type AgentData = { agent: AgentModel; hasPerson: boolean; onOpen: () => void }

function OrchestratorNode({ data }: NodeProps<Node<OrchestratorData>>) {
  return (
    <div className="agm-orch">
      {/* Centre-anchored and invisible, so every edge is a straight line between
          two node centres instead of hopping to an edge-mounted dot. */}
      <Handle type="source" position={Position.Right} id="c" className="agm-hidden-handle" />
      <span className="agm-orch-ic"><Sparkles size={16} /></span>
      <div className="agm-orch-t">
        <b>Divo</b>
        <p>Orchestrator</p>
      </div>
      <div className="agm-orch-n">
        {data.person ? `${data.reachable}/${data.total}` : `${data.total}`}
      </div>
    </div>
  )
}

function AgentNodeView({ data }: NodeProps<Node<AgentData>>) {
  const { agent, hasPerson, onOpen } = data

  const line = !hasPerson
    ? `${agent.tools.length} ${agent.tools.length === 1 ? 'tool' : 'tools'}`
    : agent.reachable
      ? `${agent.reachableToolCount} of ${agent.tools.length} · ${agent.allowedActions.join(', ')}`
      : agent.blockedToolCount > 0 ? 'Blocked by company policy' : 'No access'

  return (
    <div
      className="agm-node"
      data-reachable={agent.reachable}
      data-authored={agent.kind === 'authored'}
      role="button"
      tabIndex={0}
      title={agent.name}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
    >
      <Handle type="target" position={Position.Left} id="c" className="agm-hidden-handle" />
      <span className="agm-node-ic">
        {agent.reachable || !hasPerson ? <Bot size={14} /> : <CircleSlash size={14} />}
      </span>
      <div className="agm-node-t">
        <b>{agent.name}</b>
        <p>{line}</p>
      </div>
      {agent.config.container.mode === 'dedicated' ? (
        <span className="agm-node-badge" title="Runs in its own container"><Cpu size={11} /></span>
      ) : null}
    </div>
  )
}

const NODE_TYPES = { orchestrator: OrchestratorNode, agent: AgentNodeView }

/* ── Screen ────────────────────────────────────────────── */

export function AgentMap({ replay, toast }: Props) {
  const [r1] = useStaged([260], replay)
  const departments = useCompanyDepartments()
  const managed = useManagedDepartments()
  const [departmentId, setDepartmentId] = useState<string>('')
  const [userId, setUserId] = useState<string>('')
  const [showUnreachable, setShowUnreachable] = useState(true)
  const [openId, setOpenId] = useState<string | null>(null)
  const [draft, setDraft] = useState<AgentDefinition | null>(null)

  /*
   * Open on a team this viewer can actually read.
   *
   * The map is built on manager-scoped endpoints — `/departments/:id/manage`
   * and `/:id/tools` — which refuse for any team you do not manage. Opening on
   * whichever department sorted first therefore greeted most people with
   * "forbidden" on a page whose whole job is to answer a question, and a
   * company admin with three teams could read exactly one of them.
   *
   * Your own team first, then any team with members, then whatever exists. The
   * others stay in the picker and say plainly why they cannot be shown.
   */
  const activeDepartment = departmentId
    || managed.department?.id
    || departments.data.find((d) => d.memberCount > 0)?.id
    || departments.data[0]?.id
    || ''
  const graph = useAgentGraph(activeDepartment || undefined, userId || undefined)

  const openAgent = useCallback((id: string) => setOpenId(id), [])

  const visible = useMemo(
    () => (showUnreachable || !userId ? graph.agents : graph.agents.filter((a) => a.reachable)),
    [graph.agents, showUnreachable, userId],
  )

  const { nodes, edges } = useMemo(() => {
    // With nobody chosen there is no "cannot reach" — every agent sits on the
    // inner ring, and the map reads as a catalogue rather than a verdict.
    const inner = userId ? visible.filter((a) => a.reachable) : visible
    const outer = userId ? visible.filter((a) => !a.reachable) : []
    const rIn = radiusFor(inner.length, 260)
    const rOut = radiusFor(outer.length, rIn + 220)

    const person = graph.people.find((p) => p.userId === userId)
    const ns: Node[] = [{
      id: 'divo',
      type: 'orchestrator',
      position: { x: -NODE_W / 2, y: -NODE_H / 2 },
      data: {
        reachable: graph.reachableCount,
        total: graph.agents.length,
        person: person ? (person.name ?? person.email) : null,
      } satisfies OrchestratorData,
      draggable: false,
    }]
    const es: Edge[] = []

    const place = (list: AgentModel[], radius: number) => {
      list.forEach((agent, i) => {
        ns.push({
          id: agent.id,
          type: 'agent',
          position: ring(list.length, radius, i),
          data: {
            agent,
            hasPerson: Boolean(userId),
            onOpen: () => openAgent(agent.id),
          } satisfies AgentData,
          draggable: false,
        })
        es.push({
          id: `divo-${agent.id}`,
          source: 'divo',
          target: agent.id,
          sourceHandle: 'c',
          targetHandle: 'c',
          type: 'straight',
          className: agent.reachable && userId ? 'agm-edge on' : 'agm-edge off',
        })
      })
    }
    place(inner, rIn)
    place(outer, rOut)
    return { nodes: ns, edges: es }
  }, [visible, graph.agents.length, graph.reachableCount, graph.people, userId, openAgent])

  const selected = openId ? graph.agents.find((a) => a.id === openId) ?? null : null
  const personName = graph.people.find((p) => p.userId === userId)?.name ?? null

  /**
   * Every tool in the company, and which agent holds it.
   *
   * The picker needs the whole catalogue, not just one agent's slice, because
   * its job is to answer "what is still free" — a question you cannot ask from
   * inside a single agent.
   */
  const catalogue = useMemo(
    () => graph.agents.flatMap((a) => a.tools.map((tool) => ({ tool, ownerId: a.id, ownerName: a.name }))),
    [graph.agents],
  )

  if (departments.refused) {
    return (
      <NoAccess
        what="the agent map"
        who="This is a company-wide view of who may run what. Company admins can see it."
      />
    )
  }

  return (
    <>
      <PageHeader
        eyebrow="Company"
        title="Agent map"
        description="Divo sits in the middle of every request. Pick a person to see which agents their Divo can actually reach."
        actions={
          <button type="button" className="btn primary" onClick={() => setDraft(blankAgent())}>New agent</button>
        }
      />

      <Panel source="agentGraph">
        <div className="agm-bar">
          <label className="agm-field">
            <span>Team</span>
            <select
              className="select"
              value={activeDepartment}
              onChange={(e) => { setDepartmentId(e.target.value); setUserId('') }}
            >
              {/* The size is the part that decides whether this team can
                  answer anything, so it travels with the name rather than
                  being discovered by picking one and finding it empty. */}
              {departments.data.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}{d.memberCount === 0 ? ' — nobody in it' : ` · ${d.memberCount}`}
                </option>
              ))}
            </select>
          </label>

          <label className="agm-field">
            <span>Person</span>
            <select
              className="select"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              // Nothing to choose is not the same as choosing nothing. Left
              // enabled it was a control that opened onto one dead entry.
              disabled={!graph.loading && graph.people.length === 0}
            >
              <option value="">
                {graph.loading
                  ? 'Loading…'
                  : graph.people.length === 0 ? 'Nobody in this team' : 'Nobody selected'}
              </option>
              {graph.people.map((p) => (
                <option key={p.userId} value={p.userId}>{p.name ?? p.email}</option>
              ))}
            </select>
          </label>

          <div className="agm-bar-r">
            {graph.agents.length > 0 ? (
              <span className="agm-count">
                {graph.agents.length} agents · {graph.toolCount} tools
              </span>
            ) : null}
            {userId ? (
              <>
                <span className="ws-lbl" style={{ margin: '0 9px 0 16px' }}>Show unreachable</span>
                <Switch
                  on={showUnreachable}
                  onToggle={() => setShowUnreachable((v) => !v)}
                  label="Show unreachable agents"
                />
              </>
            ) : null}
          </div>
        </div>

        <div className="agm-canvas">
          {!r1 || graph.loading ? (
            /*
             * The shape of a graph, not a stray line.
             *
             * A single 180×11 bar sat in the middle of a 560px canvas, which
             * read as a broken page rather than a loading one — nothing about
             * it suggested a map was coming. These are the real node width and
             * the real ring the layout uses, so the arrival is a fill rather
             * than a jump.
             */
            <div className="agm-loading" aria-label="Loading the map">
              <div className="agm-skel-ring">
                {Array.from({ length: 6 }).map((_, i) => (
                  <span key={i} className="ws-skel block agm-skel-node" style={{ ['--i' as string]: i }} />
                ))}
                <span className="ws-skel block agm-skel-hub" />
              </div>
            </div>
          ) : graph.refused ? (
            /*
             * A refusal is an answer, and it was arriving as the bare word
             * "forbidden" under a generic title — the backend's vocabulary
             * printed at somebody who then has to guess whether the team is
             * empty, broken, or none of their business. Worse, a blank map
             * beside it reads as "this person can do nothing", which is the
             * opposite of "we could not look".
             */
            <Empty
              icon={CircleSlash}
              title="This team is not yours to read"
              body={managed.department
                ? `The map reads each team through its manager, and you manage ${managed.department.name}. Pick that one above to see it.`
                : 'The map reads each team through its manager, and you do not manage this one.'}
            />
          ) : graph.error ? (
            <Empty icon={CircleSlash} title="Could not read this team’s permissions" body={graph.error} />
          ) : graph.agents.length === 0 ? (
            <Empty
              icon={Boxes}
              title="No agents governed here"
              body="This team has no tools configured yet, so Divo has nothing to route to."
            />
          ) : (
            <ReactFlow
              // Remounted when the population changes so `fitView` runs again.
              // It only fits on init, and without this a new person's map opens
              // framed for the previous one — half of it off-screen.
              key={`${activeDepartment}:${userId}:${showUnreachable}:${nodes.length}`}
              nodes={nodes}
              edges={edges}
              nodeTypes={NODE_TYPES}
              fitView
              fitViewOptions={{ padding: 0.2 }}
              nodesConnectable={false}
              nodesDraggable={false}
              proOptions={{ hideAttribution: true }}
              minZoom={0.2}
              maxZoom={1.5}
            >
              <Background variant={BackgroundVariant.Dots} gap={22} size={1} className="agm-bg" />
              <Controls showInteractive={false} />
            </ReactFlow>
          )}
        </div>

        <div className="ws-panel-foot">
          {userId
            ? 'Lit edges are permissions the backend would really grant today. Everything editable in a drawer is stored in this browser only.'
            /* "Choose a person above" was pointing at an empty list whenever
               the team had nobody in it — an instruction the reader could not
               follow, which reads as the page being broken rather than the
               team being empty. Refused is kept apart from empty: the canvas
               above already explains that one, and calling it "nobody in it"
               would be a second wrong answer. */
            : graph.refused
              ? 'Pick a team you manage to see its map.'
              : graph.people.length === 0 && !graph.loading
                ? 'This team has nobody in it, so there is no one to ask about. Pick another team above.'
                : 'Choose a person above. Until then nothing is lit, because “what can this person do” has no answer yet.'}
        </div>
      </Panel>

      {selected ? (
        <AgentDrawer
          agent={selected}
          catalogue={catalogue}
          personName={personName}
          hasPerson={Boolean(userId)}
          onClose={() => setOpenId(null)}
          toast={toast}
        />
      ) : null}

      {draft ? (
        <AgentEditor
          mode="create"
          initial={draft}
          catalogue={catalogue}
          onClose={() => setDraft(null)}
          toast={toast}
        />
      ) : null}
    </>
  )
}

/* ── Shared pieces ─────────────────────────────────────── */

type CatalogueEntry = { tool: AgentTool; ownerId: string; ownerName: string }

const MODES: { value: ContainerMode; label: string }[] = [
  { value: 'dedicated', label: 'Own' },
  { value: 'shared', label: 'Shared' },
  { value: 'ephemeral', label: 'Per run' },
]

const SCOPES: MemoryScope[] = ['agent', 'user', 'department', 'company']

/**
 * The tool picker.
 *
 * Grouped by family, because that is how people think about tools — "give it
 * Google" is a real sentence and "give it googleSheets, googleDocs and
 * googleDrive" is not. A tool another agent already owns is shown, not hidden,
 * with the owner's name: knowing Gmail is taken by the Finance desk is more
 * useful than Gmail quietly not being on the list.
 */
function ToolPicker({ catalogue, selfId, selected, onToggle }: {
  catalogue: CatalogueEntry[]
  /** The agent being edited — its own tools count as available to it. */
  selfId: string
  selected: string[]
  onToggle: (toolId: string) => void
}) {
  const groups = useMemo(() => {
    const byFamily = new Map<ToolFamily, CatalogueEntry[]>()
    for (const entry of catalogue) {
      const family = familyOf(entry.tool.toolId)
      const bucket = byFamily.get(family)
      if (bucket) bucket.push(entry)
      else byFamily.set(family, [entry])
    }
    return Array.from(byFamily.entries())
      .map(([family, entries]) => ({ family, entries }))
      .sort((a, b) => familyName(a.family).localeCompare(familyName(b.family)))
  }, [catalogue])

  const isTaken = (entry: CatalogueEntry) =>
    entry.ownerId !== selfId && entry.ownerId.startsWith('agent:')

  const free = catalogue.filter((e) => !isTaken(e)).length

  return (
    <div className="agm-pick">
      <p className="agm-sec-p">
        {selected.length} selected · {free - selected.length} still free.
        An agent owns its tools exclusively, so taking one moves it out of wherever it lives now.
      </p>

      {groups.map(({ family, entries }) => {
        const pickable = entries.filter((e) => !isTaken(e))
        const allOn = pickable.length > 0 && pickable.every((e) => selected.includes(e.tool.toolId))
        return (
          <div key={family} className="agm-pick-g">
            <header>
              <b>{familyName(family)}</b>
              {pickable.length > 0 ? (
                <button
                  type="button"
                  className="agm-lnk"
                  onClick={() => pickable.forEach((e) => {
                    const on = selected.includes(e.tool.toolId)
                    if (allOn === on) onToggle(e.tool.toolId)
                  })}
                >
                  {allOn ? 'Clear' : 'Take all'}
                </button>
              ) : <span className="agm-pick-none">All taken</span>}
            </header>

            {entries.map((entry) => {
              const taken = isTaken(entry)
              const on = selected.includes(entry.tool.toolId)
              return (
                <label key={entry.tool.toolId} className="agm-pick-r" data-taken={taken}>
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={taken}
                    onChange={() => onToggle(entry.tool.toolId)}
                  />
                  <span className="agm-pick-n">{entry.tool.name}</span>
                  <span className="agm-pick-m">
                    {taken ? `In ${entry.ownerName}` : entry.tool.supportedActions.length + ' actions'}
                  </span>
                </label>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

/** Instructions, model, container and memory — the four things you author. */
function ConfigFields({ value, onChange, toast }: {
  value: AgentConfig
  onChange: (next: Partial<AgentConfig>) => void
  toast: Toast
}) {
  const models = useMyModelOptions()

  return (
    <>
      <section className="agm-sec">
        <header>
          <h3><Bot size={13} /> Instructions</h3>
          <DataNote source="agentConfig" />
        </header>
        <p className="agm-sec-p">
          Prepended to Divo’s company persona when this agent takes a turn — it narrows the
          orchestrator, it does not replace it.
        </p>
        <textarea
          className="input agm-prompt"
          rows={7}
          value={value.systemPrompt}
          placeholder="You are the finance desk. Read Zoho precisely and never round a figure…"
          onChange={(e) => onChange({ systemPrompt: e.target.value })}
        />
      </section>

      <section className="agm-sec">
        <header>
          <h3><Cpu size={13} /> Container</h3>
          <DataNote source="agentConfig" />
        </header>

        <label className="agm-row">
          <span>Model</span>
          <select
            className="select"
            value={value.modelId}
            onChange={(e) => onChange({ modelId: e.target.value })}
          >
            {/* Real list, from the proxy's own policy — offering a model the
                proxy would refuse turns this into a way to break a run. */}
            {models.allowedModels.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            {models.allowedModels.some((m) => m.id === value.modelId) ? null : (
              <option value={value.modelId}>{value.modelId}</option>
            )}
          </select>
        </label>

        <label className="agm-row">
          <span>Runs in</span>
          <Seg
            value={value.container.mode}
            onChange={(mode) => onChange({ container: { ...value.container, mode } })}
            options={MODES}
          />
        </label>

        <div className="agm-row3">
          <label>
            <span>vCPU</span>
            <input
              className="input" type="number" min={1} max={8} value={value.container.cpu}
              onChange={(e) => onChange({ container: { ...value.container, cpu: Number(e.target.value) } })}
            />
          </label>
          <label>
            <span>Memory (MB)</span>
            <input
              className="input" type="number" min={512} step={512} value={value.container.memoryMb}
              onChange={(e) => onChange({ container: { ...value.container, memoryMb: Number(e.target.value) } })}
            />
          </label>
          <label>
            <span>Idle stop (min)</span>
            <input
              className="input" type="number" min={1} max={240} value={value.container.idleStopMinutes}
              onChange={(e) => onChange({ container: { ...value.container, idleStopMinutes: Number(e.target.value) } })}
            />
          </label>
        </div>

        <p className="agm-warn">
          {CONTAINER_LABEL[value.container.mode]}. Today every person gets one container for all of
          Divo, keyed by company and user — per-agent containers do not exist yet, and eight runs
          may be in flight across the whole fleet at once.
        </p>
      </section>

      <section className="agm-sec">
        <header>
          <h3><Brain size={13} /> Memory</h3>
          <DataNote source="agentConfig" />
        </header>

        <label className="agm-row">
          <span>Remembers for</span>
          <select
            className="select"
            value={value.memory.scope}
            onChange={(e) => onChange({ memory: { ...value.memory, scope: e.target.value as MemoryScope } })}
          >
            {SCOPES.map((s) => <option key={s} value={s}>{MEMORY_SCOPE_LABEL[s]}</option>)}
          </select>
        </label>

        <label className="agm-row">
          <span>Keeps for (days)</span>
          <input
            className="input" type="number" min={1} placeholder="Indefinitely"
            value={value.memory.retentionDays ?? ''}
            onChange={(e) => onChange({
              memory: { ...value.memory, retentionDays: e.target.value ? Number(e.target.value) : null },
            })}
          />
        </label>

        <label className="agm-row">
          <span>Learns from runs</span>
          <Switch
            on={value.memory.learning}
            onToggle={() => {
              if (!value.memory.learning) {
                toast('Learning from runs has no implementation — memory is written by explicit tool calls today.')
              }
              onChange({ memory: { ...value.memory, learning: !value.memory.learning } })
            }}
            label="Learns from runs"
          />
        </label>

        {value.memory.scope === 'agent' ? (
          <p className="agm-warn">
            An agent-scoped memory bank does not exist. Banks are keyed by person, department or
            company today, so this agent would read the person’s.
          </p>
        ) : null}
      </section>
    </>
  )
}

/* ── Create ────────────────────────────────────────────── */

function AgentEditor({ mode, initial, catalogue, onClose, toast }: {
  mode: 'create'
  initial: AgentDefinition
  catalogue: CatalogueEntry[]
  onClose: () => void
  toast: Toast
}) {
  const [agent, setAgent] = useState<AgentDefinition>(initial)
  const { width, onGrab, reset } = useDrawerWidth('divo.admin.drawer.agentEditor', 720)

  const patch = (next: Partial<AgentDefinition>) => setAgent((a) => ({ ...a, ...next }))
  const toggle = (toolId: string) => setAgent((a) => ({
    ...a,
    toolIds: a.toolIds.includes(toolId) ? a.toolIds.filter((t) => t !== toolId) : [...a.toolIds, toolId],
  }))

  const ready = agent.name.trim().length > 0 && agent.toolIds.length > 0

  return (
    <>
      <div className="ws-scrim" onClick={onClose} />
      <aside className="ws-drawer agm-drawer" style={{ width }} role="dialog" aria-label="New agent">
        <DrawerGrip onGrab={onGrab} reset={reset} />

        <div className="ws-drawer-h">
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2>New agent</h2>
            <p>Name it for the job it does, then give it the tools that job needs.</p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="ws-drawer-b">
          <section className="agm-sec">
            <header>
              <h3><Sparkles size={13} /> Identity</h3>
              <DataNote source="agentConfig" />
            </header>
            <label className="agm-row">
              <span>Name</span>
              <input
                className="input"
                value={agent.name}
                placeholder="Finance desk"
                autoFocus
                onChange={(e) => patch({ name: e.target.value })}
              />
            </label>
            <p className="agm-sec-p">
              This is the name the orchestrator routes to and the name a person sees in a trace.
            </p>
          </section>

          <section className="agm-sec">
            <header>
              <h3><Wrench size={13} /> Tools</h3>
              <span className="ws-note" data-kind="live" title="The tool catalogue and its actions are live">Live</span>
            </header>
            <ToolPicker
              catalogue={catalogue}
              selfId={agent.id}
              selected={agent.toolIds}
              onToggle={toggle}
            />
          </section>

          <ConfigFields
            value={agent}
            onChange={(next) => patch(next)}
            toast={toast}
          />
        </div>

        <div className="ws-drawer-f">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="btn primary"
            disabled={!ready}
            title={ready ? undefined : 'An agent needs a name and at least one tool'}
            onClick={() => {
              saveAgent({ ...agent, name: agent.name.trim() })
              toast(`${agent.name.trim()} created — in this browser only, there is no agent table yet.`)
              onClose()
            }}
          >
            {mode === 'create' ? 'Create agent' : 'Save'}
          </button>
        </div>
      </aside>
    </>
  )
}

/* ── Inspect and edit ──────────────────────────────────── */

function AgentDrawer({ agent, catalogue, personName, hasPerson, onClose, toast }: {
  agent: AgentModel
  catalogue: CatalogueEntry[]
  personName: string | null
  hasPerson: boolean
  onClose: () => void
  toast: Toast
}) {
  const { width, onGrab, reset } = useDrawerWidth('divo.admin.drawer.agent', 620)
  const [config, setConfig] = useState<AgentConfig>(agent.config)
  const [name, setName] = useState(agent.name)
  const [toolIds, setToolIds] = useState<string[]>(agent.tools.map((t) => t.toolId))
  const authored = agent.kind === 'authored'

  const dirty = useMemo(() => (
    name !== agent.name
    || JSON.stringify(config) !== JSON.stringify(agent.config)
    || (authored && toolIds.join() !== agent.tools.map((t) => t.toolId).join())
  ), [name, config, toolIds, agent, authored])

  const save = () => {
    saveAgent({
      id: agent.id,
      name: name.trim() || agent.name,
      // A family agent's tools are derived from the taxonomy, so storing a list
      // for it would be a second source of truth that could drift.
      toolIds: authored ? toolIds : [],
      ...config,
    })
    toast('Saved in this browser only — the backend has no agent definition to store.')
    onClose()
  }

  return (
    <>
      <div className="ws-scrim" onClick={onClose} />
      <aside className="ws-drawer agm-drawer" style={{ width }} role="dialog" aria-label={agent.name}>
        <DrawerGrip onGrab={onGrab} reset={reset} />

        <div className="ws-drawer-h">
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2>{name || agent.name}</h2>
            <p>
              {agent.kind === 'authored' ? 'Authored agent · ' : ''}
              {agent.tools.length} {agent.tools.length === 1 ? 'tool' : 'tools'}
              {hasPerson ? ` · ${agent.reachableToolCount} reachable` : ''}
            </p>
          </div>
          {authored ? (
            <button
              type="button"
              className="icon-btn"
              title="Delete this agent"
              onClick={() => {
                deleteAgent(agent.id)
                toast(`${agent.name} deleted — its tools went back to their families.`)
                onClose()
              }}
            >
              <Trash2 size={14} />
            </button>
          ) : null}
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="ws-drawer-b">
          {/* ── Real ──────────────────────────────────────── */}
          <section className="agm-sec">
            <header>
              <h3><ShieldCheck size={13} /> What it can do</h3>
              <span className="ws-note" data-kind="live" title="Read from the live permission routes">Live</span>
            </header>

            <p className="agm-sec-p">
              {personName
                ? <>What <b>{personName}</b> may run through this agent right now.</>
                : 'Choose a person to see whose permissions these are.'}
            </p>

            <div className="agm-tools">
              {agent.tools.map((tool) => (
                <div key={tool.toolId} className="agm-tool" data-state={tool.reachable ? 'on' : 'off'}>
                  <div className="agm-tool-h">
                    <b>{tool.name}</b>
                    {tool.provenance ? (
                      <span className="agm-tool-prov">{PROVENANCE_LABEL[tool.provenance]}</span>
                    ) : null}
                  </div>
                  <div className="agm-chips">
                    {tool.supportedActions.map((action) => {
                      const allowed = tool.allowedActions.includes(action)
                      const blocked = tool.blockedActions.includes(action)
                      return (
                        <span
                          key={action}
                          className="agm-chip"
                          data-state={allowed ? 'on' : blocked ? 'blocked' : 'off'}
                          title={blocked ? 'Granted for this person, blocked by a company rule' : undefined}
                        >
                          {tool.actionLabels[action] ?? action}
                        </span>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* ── Proposed ──────────────────────────────────── */}
          {authored ? (
            <>
              <section className="agm-sec">
                <header>
                  <h3><Sparkles size={13} /> Identity</h3>
                  <DataNote source="agentConfig" />
                </header>
                <label className="agm-row">
                  <span>Name</span>
                  <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
                </label>
              </section>

              <section className="agm-sec">
                <header>
                  <h3><Wrench size={13} /> Tools</h3>
                  <span className="ws-note" data-kind="live">Live</span>
                </header>
                <ToolPicker
                  catalogue={catalogue}
                  selfId={agent.id}
                  selected={toolIds}
                  onToggle={(toolId) => setToolIds((ids) =>
                    ids.includes(toolId) ? ids.filter((t) => t !== toolId) : [...ids, toolId])}
                />
              </section>
            </>
          ) : null}

          <ConfigFields
            value={config}
            onChange={(next) => setConfig((c) => ({ ...c, ...next }))}
            toast={toast}
          />
        </div>

        <div className="ws-drawer-f">
          <button type="button" className="btn" onClick={onClose}>Close</button>
          <button type="button" className="btn primary" disabled={!dirty} onClick={save}>Save</button>
        </div>
      </aside>
    </>
  )
}
