/**
 * The rule builder — a chain of nodes, with Divo beside it.
 *
 * Shape first, because it is the argument. A mail rule runs in one straight
 * line: something arrives, it either matches or it does not, an optional AI
 * step either passes it or holds it, and then exactly one action happens. So
 * the builder is a straight line. A free canvas would look more capable and
 * would be a lie — it invites branches and joins the runtime cannot execute.
 *
 * The AI step is a node like any other, inserted between the match and the
 * action, removable, and carrying its own price. That placement is the design:
 *   · after the match, because matching is free and runs on everything
 *   · before the action, because the model's answer is what gates the action
 * and never anywhere else, which is why the "+" between the other nodes says
 * what it will not accept instead of opening an empty menu.
 *
 * What the model may decide is deliberately narrow — pass, label, or extract.
 * It never chooses the action, the destination, or the recipient. Those are the
 * two rows a person is accountable for, so the destination node states the
 * limit on its face rather than in a tooltip.
 */
import { useMemo, useRef, useState } from 'react'
import {
  ArrowRight, Ban, Brain as BrainIcon, Check, Clock, CornerDownLeft, Forward,
  EyeOff, Inbox, Lock, PenLine, Plus, Sparkles, Tag, Trash2, X,
} from 'lucide-react'
import { GmailMark, LarkMark } from '@/pages/workspace/brand'
import { AI_SCRIPT, ME, type Brain, type BrainMode, type Rule } from './data'
import { Note, Pill, inr } from './kit'

type Draft = Pick<Rule, 'kind' | 'name' | 'match' | 'deadline' | 'brain' | 'action' | 'destination'>

const EMPTY: Draft = {
  kind: 'arrival',
  name: '',
  match: {},
  action: { type: 'forward' },
  destination: { type: 'none' },
}

/*
 * Two modes, not three.
 *
 * Classify — a closed label list — was designed, built, and cut. A label is
 * only worth paying a model for if something downstream consumes it, and
 * nothing does: every use case collapsed into "post the label into a chat",
 * which Judge already answers for less. The model here either **gates** a
 * message or **produces** something from it, and that is the whole taxonomy.
 */
const MODE_COPY: Record<BrainMode, { title: string; blurb: string; verb: string }> = {
  judge: {
    title: 'Judge',
    blurb: 'Ask one yes-or-no question about the message. A no stops the rule.',
    verb: 'Question',
  },
  extract: {
    title: 'Extract',
    blurb: 'Name the fields to pull out. Only those fields are sent on — not the whole message.',
    verb: 'What to pull out',
  },
}

/* ── Node frame ──────────────────────────────────────── */
function Node({
  n, title, icon, tone, right, changed, children,
}: {
  n: number
  title: string
  icon: React.ReactNode
  tone?: 'ai' | 'locked'
  right?: React.ReactNode
  changed?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="mp-node" data-tone={tone} data-changed={changed ? 'true' : undefined}>
      <div className="mp-node-h">
        <span className="mp-node-n">{n}</span>
        <span className="mp-node-ic">{icon}</span>
        <b>{title}</b>
        {right ? <span className="mp-node-r">{right}</span> : null}
      </div>
      <div className="mp-node-b">{children}</div>
    </div>
  )
}

/**
 * The connector between two nodes.
 *
 * Three states, and the middle one is the interesting one. With `onAdd` it is
 * an invitation. With `refuse` it is a dim "+" that, pressed, says why nothing
 * may go here — better than a menu that opens empty, and better than no
 * affordance at all, which reads as an oversight. With neither it is just a
 * line.
 */
function Joint({ onAdd, refuse }: { onAdd?: () => void; refuse?: string }) {
  const [open, setOpen] = useState(false)
  if (!onAdd && !refuse) return <div className="mp-joint"><span className="mp-joint-line" style={{ height: 26 }} /></div>
  return (
    <div className="mp-joint">
      <span className="mp-joint-line" />
      {onAdd ? (
        <button type="button" className="mp-joint-add" onClick={() => { onAdd(); setOpen(false) }}>
          <Plus size={13} /> Insert an AI step
        </button>
      ) : (
        <button
          type="button"
          className="mp-joint-add"
          data-refuse="true"
          onClick={() => setOpen((v) => !v)}
          title={refuse}
        >
          <Plus size={13} />
        </button>
      )}
      {open && refuse ? <span className="mp-joint-why">{refuse}</span> : null}
      <span className="mp-joint-line" />
    </div>
  )
}

/* ── Field ───────────────────────────────────────────── */
const Field = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => (
  <label className="mp-field">
    <span className="l">{label}</span>
    {children}
    {hint ? <span className="h">{hint}</span> : null}
  </label>
)

/* ── The builder ─────────────────────────────────────── */
export function RuleBuilder({
  initial, onSave, onCancel, editing,
}: {
  initial?: Draft
  onSave: (d: Draft) => void
  onCancel: () => void
  editing?: boolean
}) {
  const [draft, setDraft] = useState<Draft>(initial ?? EMPTY)
  const [touched, setTouched] = useState<string[]>([])
  const [log, setLog] = useState<{ who: 'me' | 'divo'; text: string }[]>([
    {
      who: 'divo',
      text: editing
        ? 'Tell me what to change and I will move the nodes. Everything I touch lights up on the left.'
        : 'Describe the rule in your own words. I will build the chain on the left — you can edit any node by hand afterwards.',
    },
  ])
  const [used, setUsed] = useState<string[]>([])
  const [input, setInput] = useState('')
  const [testing, setTesting] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)

  const patch = (p: Partial<Draft>, touches: string[]) => {
    setDraft((d) => ({ ...d, ...p }))
    setTouched(touches)
    window.setTimeout(() => setTouched([]), 1800)
  }

  const send = (text: string) => {
    const turn = AI_SCRIPT.find((t) => t.ask === text)
      ?? AI_SCRIPT.find((t) => !used.includes(t.ask) && text.trim().length > 0)
    setLog((l) => [...l, { who: 'me', text }])
    setInput('')
    if (!turn) return
    setUsed((u) => [...u, turn.ask])
    window.setTimeout(() => {
      setLog((l) => [...l, ...turn.say.map((s) => ({ who: 'divo' as const, text: s }))])
      patch(turn.patch as Partial<Draft>, turn.touches)
      logRef.current?.scrollTo({ top: 9e5, behavior: 'smooth' })
    }, 280)
  }

  const chips = useMemo(() => AI_SCRIPT.filter((t) => !used.includes(t.ask)).slice(0, 3), [used])

  const brain = draft.brain
  const isWatch = draft.kind === 'watch'
  const isDraft = draft.action.type === 'draft'
  const monthly = brain ? Math.round(brain.costPerMessage * 134) : 0

  const setBrain = (p: Partial<Brain>) =>
    setDraft((d) => (d.brain ? { ...d, brain: { ...d.brain, ...p } } : d))

  const addBrain = () =>
    patch({
      brain: {
        mode: 'judge',
        prompt: '',
        onReject: 'stop',
        failure: 'open',
        costPerMessage: 0.04,
        monthlyCeiling: 400,
      },
    }, ['brain'])

  return (
    <div className="mp-build">
      {/* ── the chain ── */}
      <div className="mp-chain">
        <div className="mp-build-h">
          <input
            className="mp-name"
            value={draft.name}
            placeholder="Name this rule"
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          />
          <div className="mp-build-act">
            <button type="button" className="btn" onClick={onCancel}>Cancel</button>
            <button type="button" className="btn" onClick={() => setTesting(true)}>Test on last 30 days</button>
            <button type="button" className="btn primary" onClick={() => onSave(draft)}>
              {editing ? 'Save changes' : 'Turn it on'}
            </button>
          </div>
        </div>

        <Note n={1} title="A line, not a canvas">
          The runtime executes one straight path per message. A drag-and-drop canvas would let you
          draw a branch it cannot run, so the builder only offers the shape that exists. The single
          decision worth making — whether a model gets a say — is the one insertable node.
        </Note>

        <Node
          n={1}
          title={isWatch ? 'When mail does not arrive' : 'When mail arrives'}
          icon={isWatch ? <EyeOff size={14} /> : <Inbox size={14} />}
          right={<span className="mp-mailbox"><GmailMark size={13} /> {ME.email}</span>}
          changed={touched.includes('trigger')}
        >
          <div className="mp-trig">
            {([
              { id: 'arrival' as const, label: 'Mail arrives', blurb: 'The normal case. Something lands, the rule runs.' },
              { id: 'watch' as const, label: 'Mail does not arrive', blurb: 'Nothing lands by a deadline you set, and Divo tells you.' },
            ]).map((t) => (
              <button
                key={t.id}
                type="button"
                className="mp-act"
                data-on={draft.kind === t.id}
                onClick={() => setDraft((d) => (
                  t.id === 'watch'
                    ? { ...d, kind: 'watch', brain: undefined, action: { type: 'deliver' }, destination: { type: 'lark_dm', value: ME.name } }
                    : { ...d, kind: 'arrival', deadline: undefined }
                ))}
              >
                <b>{t.label}</b>
                <span>{t.blurb}</span>
              </button>
            ))}
          </div>
          <p className="mp-node-p">
            {isWatch
              ? 'Divo searches the mailbox on a schedule instead of waiting for a push. There is no message to read, so this kind of rule costs nothing to run.'
              : 'Only new mail landing in the inbox. Anything a native Gmail filter has already archived, and anything in Spam, is never seen by this rule.'}
          </p>
        </Node>

        <Note n={2} title="The rule kind no mail client has">
          A filter needs a message to match, so no filter anywhere can tell you the GST
          acknowledgement never came. A watch is the only rule here that fires on something
          <em> not</em> happening — and because it is a scheduled search with no model, it is free.
        </Note>

        <Joint refuse="Nothing goes here. A rule starts on arriving mail, or on mail failing to arrive, and on nothing else." />

        <Node
          n={2}
          title={isWatch ? 'What you are expecting' : 'If it matches'}
          icon={<Check size={14} />}
          changed={touched.includes('match')}
        >
          <div className="mp-grid2">
            <Field label="From" hint="Leave blank for anyone.">
              <input
                className="input"
                value={draft.match.from ?? ''}
                placeholder="billing@acme-supplies.com"
                onChange={(e) => setDraft((d) => ({ ...d, match: { ...d.match, from: e.target.value } }))}
              />
            </Field>
            <Field label="Subject contains">
              <input
                className="input"
                value={draft.match.subjectContains ?? ''}
                placeholder="invoice"
                onChange={(e) => setDraft((d) => ({ ...d, match: { ...d.match, subjectContains: e.target.value } }))}
              />
            </Field>
            <Field label="Never from" hint="Checked before anything is paid for.">
              <input
                className="input"
                value={draft.match.notFrom ?? ''}
                placeholder="no-reply@"
                onChange={(e) => setDraft((d) => ({ ...d, match: { ...d.match, notFrom: e.target.value } }))}
              />
            </Field>
            <Field label="Only between">
              <div className="mp-window">
                <Clock size={13} />
                {draft.match.window
                  ? <span>{draft.match.window.days}, {draft.match.window.start}–{draft.match.window.end} · {draft.match.window.timeZone}</span>
                  : <span className="muted">Any time</span>}
              </div>
            </Field>
          </div>
          <label className="mp-check">
            <input
              type="checkbox"
              checked={!!draft.match.hasAttachment}
              onChange={(e) => setDraft((d) => ({ ...d, match: { ...d.match, hasAttachment: e.target.checked } }))}
            />
            Must carry an attachment
          </label>

          {isWatch ? (
            <div className="mp-grid2">
              <Field label="Tell me if it has not arrived by" hint="Late is not the same as missing. Pick the hour it stops being late.">
                <input
                  className="input"
                  value={draft.deadline?.by ?? ''}
                  placeholder="the 11th, 18:00"
                  onChange={(e) => setDraft((d) => ({ ...d, deadline: { by: e.target.value, repeats: d.deadline?.repeats ?? 'every month' } }))}
                />
              </Field>
              <Field label="And check again">
                <select
                  className="select"
                  value={draft.deadline?.repeats ?? 'every month'}
                  onChange={(e) => setDraft((d) => ({ ...d, deadline: { by: d.deadline?.by ?? '', repeats: e.target.value } }))}
                >
                  <option>every month</option>
                  <option>every week</option>
                  <option>never — this is a one-off</option>
                </select>
              </Field>
            </div>
          ) : null}
        </Node>

        {brain ? (
          <>
            <Joint />
            <Node
              n={3}
              title="Divo reads it"
              tone="ai"
              icon={<BrainIcon size={14} />}
              changed={touched.includes('brain')}
              right={
                <>
                  <Pill tone="ai">{inr(brain.costPerMessage)} / message</Pill>
                  <button
                    type="button"
                    className="mp-node-x"
                    aria-label="Remove the AI step"
                    onClick={() => setDraft((d) => ({ ...d, brain: undefined }))}
                  >
                    <Trash2 size={13} />
                  </button>
                </>
              }
            >
              <div className="mp-modes">
                {(Object.keys(MODE_COPY) as BrainMode[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    className="mp-mode"
                    data-on={brain.mode === m}
                    onClick={() => setBrain({ mode: m })}
                  >
                    <b>{MODE_COPY[m].title}</b>
                    <span>{MODE_COPY[m].blurb}</span>
                  </button>
                ))}
              </div>

              <Field label={MODE_COPY[brain.mode].verb} hint="Plain words. This is the whole instruction the model gets, plus the message.">
                <textarea
                  className="input mp-ta"
                  rows={3}
                  value={brain.prompt}
                  placeholder={brain.mode === 'judge'
                    ? 'Is this a real invoice addressed to us, rather than marketing?'
                    : 'Pull out the one-time code and who it is for.'}
                  onChange={(e) => setBrain({ prompt: e.target.value })}
                />
              </Field>

              {brain.mode === 'extract' ? (
                <Field label="Fields" hint="Only these are passed on. The rest of the message is not.">
                  <div className="mp-tags">
                    {(brain.fields ?? ['code', 'service', 'expiresIn']).map((f) => (
                      <span className="mp-tag" key={f}>{f}<X size={11} /></span>
                    ))}
                    <button type="button" className="mp-tag add"><Plus size={11} /> Add</button>
                  </div>
                </Field>
              ) : null}

              <div className="mp-grid2">
                <Field label="If the answer is no">
                  <select
                    className="select"
                    value={brain.onReject}
                    onChange={(e) => setBrain({ onReject: e.target.value as Brain['onReject'] })}
                  >
                    <option value="stop">Stop — do nothing, and record why</option>
                    <option value="continue">Carry on anyway</option>
                  </select>
                </Field>
                <Field
                  label="If Divo cannot answer"
                  hint={brain.failure === 'open'
                    ? 'An extra forward is recoverable. A silently dropped invoice is not.'
                    : 'Nothing is sent. Right for extract, where a wrong value is worse than no value.'}
                >
                  <select
                    className="select"
                    value={brain.failure}
                    onChange={(e) => setBrain({ failure: e.target.value as Brain['failure'] })}
                  >
                    <option value="open">Carry on without a verdict</option>
                    <option value="closed">Stop and flag it</option>
                  </select>
                </Field>
              </div>

              <div className="mp-cost">
                <span>About <b>{inr(monthly)} a month</b> at your last 30 days of matched mail (134 messages).</span>
                <span className="muted">Stops at {inr(brain.monthlyCeiling)} and reverts to forwarding everything, with a warning on the rule.</span>
              </div>

              <Note n={2} title="Where the cost is stated">
                On the node, in rupees per message and rupees per month, before it is saved — not on
                an invoice at the end of it. The ceiling degrades to the free behaviour rather than
                failing, because a rule that stops working silently is the worst outcome available.
              </Note>
            </Node>
          </>
        ) : null}

        {/* The one place a node can be added, and the only node there is to add. */}
        <Joint
          onAdd={brain || isWatch ? undefined : addBrain}
          refuse={
            isWatch
              ? 'There is no message to read — that is the point of a watch. Nothing to judge, and nothing to pay for.'
              : brain
                ? 'The AI step is already in. There is only ever one — a second read would double the bill to answer the same question.'
                : undefined
          }
        />

        <Node
          n={brain ? 4 : 3}
          title="Then"
          icon={<ArrowRight size={14} />}
          changed={touched.includes('action')}
          right={isDraft ? <Pill tone="ai">{inr(draft.action.costPerMessage ?? 0.11)} / message</Pill> : undefined}
        >
          {isWatch ? (
            <p className="mp-node-p">
              A watch has exactly one outcome: it tells you. There is no message to forward, nothing
              to label, and nothing to draft a reply to.
            </p>
          ) : (
            <>
              <div className="mp-acts">
                {([
                  { id: 'forward', label: 'Forward the message', icon: <Forward size={14} />, blurb: 'The whole message, unchanged, including attachments.' },
                  { id: 'deliver', label: 'Send it to Lark', icon: <LarkMark size={14} />, blurb: 'Plain text, up to 20,000 characters. No attachments.' },
                  { id: 'draft', label: 'Draft a reply', icon: <PenLine size={14} />, blurb: 'Written into your Gmail drafts. Divo never sends it.' },
                  { id: 'organize', label: 'Label and file it', icon: <Tag size={14} />, blurb: 'Stays in Gmail. Nothing leaves.' },
                ] as const).map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    className="mp-act"
                    data-ai={a.id === 'draft' ? 'true' : undefined}
                    data-on={draft.action.type === a.id}
                    onClick={() => setDraft((d) => ({
                      ...d,
                      action: a.id === 'draft'
                        ? { ...d.action, type: 'draft', costPerMessage: 0.11 }
                        : { ...d.action, type: a.id, costPerMessage: undefined },
                      destination: a.id === 'draft' ? { type: 'gmail_draft' } : d.destination,
                    }))}
                  >
                    <span className="ic">{a.icon}</span>
                    <b>{a.label}</b>
                    <span>{a.blurb}</span>
                  </button>
                ))}
              </div>

              {isDraft ? (
                <>
                  <Field
                    label="How to write it"
                    hint="Style and substance, in your words. Divo does not invent facts it cannot find in the thread."
                  >
                    <textarea
                      className="input mp-ta"
                      rows={3}
                      value={draft.action.instruction ?? ''}
                      placeholder="Acknowledge the specific problem in their own words, say what happens next, and give a date."
                      onChange={(e) => setDraft((d) => ({ ...d, action: { ...d.action, instruction: e.target.value } }))}
                    />
                  </Field>
                  <div className="mp-cost">
                    <span>Writing costs more than judging — about <b>{inr(0.11)} a message</b>, roughly {inr(15)} a month here.</span>
                    <span className="muted">A draft is the only write action Divo has, and it is unsent by construction. The worst outcome is an unread draft.</span>
                  </div>
                  <Note n={3} title="Why drafting is allowed and sending is not">
                    Every other AI mail product sends. The reason this one will not is that a bad
                    forward is recoverable and a bad send is a letter from your company, in your
                    name, to a customer. A draft keeps the model's speed and leaves the last human
                    act — pressing send — where it belongs.
                  </Note>
                </>
              ) : null}

              <Field label="At most, per hour" hint="Past this Divo stops and records what it dropped. It does not queue.">
                <input
                  className="input"
                  style={{ maxWidth: 120 }}
                  value={draft.action.rateLimitPerHour ?? ''}
                  placeholder="No limit"
                  onChange={(e) => setDraft((d) => ({
                    ...d,
                    action: { ...d.action, rateLimitPerHour: Number(e.target.value) || undefined },
                  }))}
                />
              </Field>
            </>
          )}
        </Node>

        <Joint refuse="Nothing goes after the action. One message, one outcome." />

        <Node
          n={brain ? 5 : 4}
          title={isDraft ? 'Where the reply goes' : 'Deliver to'}
          tone="locked"
          icon={<Lock size={13} />}
          changed={touched.includes('destination')}
        >
          {isDraft ? (
            <div className="mp-locked">
              <PenLine size={13} />
              <div>
                <b>Your Gmail drafts, addressed to whoever wrote to you</b>
                <p>
                  There is no field here on purpose. A reply has exactly one correct recipient — the
                  person who sent the message — and letting anything choose a different one would
                  turn a draft into an outbound campaign.
                </p>
              </div>
            </div>
          ) : (
            <Field label={draft.action.type === 'forward' ? 'Email address' : 'Lark chat or person'}>
              <input
                className="input"
                value={draft.destination.value ?? ''}
                placeholder={draft.action.type === 'forward' ? 'finance@emiactech.com' : 'Customer Service'}
                onChange={(e) => setDraft((d) => ({
                  ...d,
                  destination: {
                    type: d.action.type === 'forward' ? 'email' : 'lark_chat',
                    value: e.target.value,
                  },
                }))}
              />
            </Field>
          )}

          <div className="mp-locked">
            <Lock size={13} />
            <div>
              <b>Divo cannot change this</b>
              <p>
                The AI step decides whether a message continues, and on a draft rule it writes the
                words — never where anything goes. Destination, action and recipient are yours, and
                a change to any of them is recorded against your name.
              </p>
            </div>
          </div>

          {!isDraft && draft.destination.value && !draft.destination.value.endsWith('@emiactech.com') && draft.action.type === 'forward' ? (
            <div className="mp-warn">
              <Ban size={13} />
              <div>
                <b>This address is outside {ME.company}</b>
                <p>A forward carries the whole message. Rules that leave the company need your admin's approval before the first send.</p>
              </div>
            </div>
          ) : null}

          <Note n={4} title="The one thing the model may not touch">
            Judge gates a message, Extract pulls fields out of it, Draft writes a reply to it. None
            of the three selects a recipient. That boundary is what makes an AI-driven mail rule
            auditable — the blast radius of a bad verdict is "it did or did not act", never "it
            reached somebody new".
          </Note>
        </Node>
      </div>

      {/* ── Divo beside it ── */}
      <aside className="mp-ai">
        <div className="mp-ai-h">
          <span className="mp-ai-ic"><Sparkles size={13} /></span>
          <div>
            <b>Build it by asking</b>
            <span>Every change lands as a node you can edit or delete.</span>
          </div>
        </div>

        <div className="mp-ai-log" ref={logRef}>
          {log.map((m, i) => (
            <div key={i} className="mp-ai-msg" data-who={m.who}>
              {m.who === 'divo' ? <span className="mp-ai-av"><Sparkles size={11} /></span> : null}
              <p>{m.text}</p>
            </div>
          ))}
        </div>

        {chips.length ? (
          <div className="mp-ai-chips">
            {chips.map((c) => (
              <button key={c.ask} type="button" className="mp-chip" onClick={() => send(c.ask)}>{c.ask}</button>
            ))}
          </div>
        ) : null}

        <form
          className="mp-ai-in"
          onSubmit={(e) => { e.preventDefault(); send(input) }}
        >
          <input
            value={input}
            placeholder="Ask for a change…"
            onChange={(e) => setInput(e.target.value)}
          />
          <button type="submit" aria-label="Send"><CornerDownLeft size={14} /></button>
        </form>

        <Note n={4} title="Why a sidebar and not a describe-box">
          A one-shot "describe your rule" field produces a rule you did not write and cannot check.
          Here the sentence and the nodes stay side by side: Divo proposes, the chain shows exactly
          what changed, and you keep editing by hand. The compile endpoint already exists — this is
          the surface it was waiting for.
        </Note>
      </aside>

      {testing ? (
        <DryRun draft={draft} onClose={() => setTesting(false)} />
      ) : null}
    </div>
  )
}

/**
 * The dry run.
 *
 * It runs the AI step too, and says what that costs before spending it. A test
 * that skips the expensive half of the rule is testing a different rule.
 */
function DryRun({ draft, onClose }: { draft: Draft; onClose: () => void }) {
  const [ran, setRan] = useState(false)
  const cost = draft.brain ? draft.brain.costPerMessage * 134 : 0

  return (
    <>
      <div className="ws-scrim" onClick={onClose} />
      <div className="ws-modal-wrap">
        <div className="ws-modal mp-dry" role="dialog" aria-label="Test this rule">
          <div className="ws-modal-h">
            <h2>Test on the last 30 days</h2>
            <p>Nothing is forwarded and nobody is messaged. This only tells you what would have happened.</p>
          </div>
          <div className="ws-modal-b">
            {!ran ? (
              <>
                <div className="mp-dry-cost">
                  <b>134 messages matched</b>
                  {draft.brain ? (
                    <p>Reading all of them costs about <b>{inr(Number(cost.toFixed(2)))}</b>, charged once, now.</p>
                  ) : (
                    <p>There is no AI step, so this is free.</p>
                  )}
                </div>
                <button type="button" className="btn primary" onClick={() => setRan(true)}>
                  {draft.brain ? `Run it — ${inr(Number(cost.toFixed(2)))}` : 'Run it'}
                </button>
              </>
            ) : (
              <div className="mp-dry-res">
                <div className="mp-dry-bar">
                  <i style={{ flex: 96 }} data-k="ok" />
                  <i style={{ flex: 38 }} data-k="held" />
                </div>
                <ul>
                  <li><b>96</b> would have been forwarded to finance@emiactech.com</li>
                  <li><b>38</b> would have been held back by the AI step</li>
                  <li><b>7</b> matched but their body has passed the 30-day limit — matched, body expired, not judged</li>
                  <li><b>0</b> would have hit the hourly ceiling</li>
                </ul>
                <p className="muted">
                  The seven are not a failure. Divo deletes message bodies after 30 days, so a test
                  reaching further back than that can match a message it can no longer read.
                </p>
              </div>
            )}
          </div>
          <div className="ws-modal-f">
            <button type="button" className="btn" onClick={onClose}>Close</button>
            {ran ? <button type="button" className="btn primary" onClick={onClose}>Looks right</button> : null}
          </div>
        </div>
      </div>
    </>
  )
}
