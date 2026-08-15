import type {
  ChannelDeclaredPlan,
  ChannelLedgerRow,
  ChannelRunState,
  ChannelTimeline,
} from '../../domain/channel/outbound';
import type { RunProgressDetail, RunProgressEvent } from '../runtime/run-progress';
import { gatewayOpPhrase, toolLabel } from '../../domain/tools/tool-labels';
import { isProtectedShopifyToolId } from '../shopify/shopify-protected-result';

/**
 * Turns the frames a container emits into the neutral timeline every surface
 * renders.
 *
 * This is the single place a run becomes something a person can read, and it
 * knows about no channel at all. What it produces is a `ChannelTimeline`; how
 * that timeline becomes a Lark card, or a stream in a browser, is the renderer's
 * problem and nothing here changes when a surface is added.
 */

/**
 * How soon the caller should show what just changed.
 *
 * `immediate` is for a state change a user is waiting on; `throttled` is the
 * ordinary case, where publishing every frame would cost more than it tells
 * anyone. The reducer says which because it is the only thing that knows what
 * the frame meant — the caller only knows one arrived.
 */
export type TimelineUrgency = 'immediate' | 'throttled';

export interface RunTimelineReducer {
  /** Fold one progress frame in. Returns how soon it deserves to be shown. */
  apply(event: RunProgressEvent): TimelineUrgency;
  /**
   * The work is over and the answer is being prepared.
   *
   * Called when the run returns, so the last thing a reader sees before the
   * reply lands is not a card still claiming to be working.
   */
  finishing(): void;
  /** The run as it stands, ready to hand to any renderer. */
  timeline(): ChannelTimeline;
  /**
   * Record protected data the reducer could not have seen itself — the runtime
   * reports some only when the run ends.
   *
   * Held here rather than beside the caller so there is exactly one answer to
   * "did this run touch data we must not keep?". A second copy is a second thing
   * to update, and the one that gets missed is the one that leaks.
   */
  observedProtectedData(): void;
  /**
   * True once the run touched data that must not be retained. The caller uses
   * this to mark its delivery transient.
   */
  readonly protectedDataUsed: boolean;
}

export interface RunTimelineReducerInput {
  /** Epoch ms. Renderers compute elapsed time at draw time from this. */
  readonly startedAtMs: number;
}

export function createRunTimelineReducer(input: RunTimelineReducerInput): RunTimelineReducer {
  const ledger = new Map<string, ChannelLedgerRow>();
  let phase = 'Thinking';
  let state: ChannelRunState = 'thinking';
  let liveLabel = 'Thinking…';
  let actionCount = 0;
  let declared: ChannelDeclaredPlan | undefined;
  /** Bumped per tool call so each stretch of talking gets its own ledger keys. */
  let sayTurn = 0;
  let protectedDataUsed = false;

  const put = (id: string, row: Omit<ChannelLedgerRow, 'id'>): void => {
    ledger.set(id, { ...row, id });
  };

  /**
   * The model stopped thinking, because it did something else.
   *
   * A thought has no end event of its own — it ends by being followed. That is
   * observable exactly here, where the following event arrives, and nowhere
   * else: a renderer handed the finished list can only guess from position, and
   * position is not the same fact. It used to guess, and got it wrong whenever
   * the list was reshaped for an unrelated reason.
   */
  const settleThoughts = (): void => {
    for (const [id, row] of ledger) {
      if (row.kind === 'thought' && row.status === 'running') {
        ledger.set(id, { ...row, status: 'done' });
      }
    }
  };

  /**
   * The model carried on working, so everything it had said becomes an aside.
   *
   * Returns whether anything was actually reclassified. It matters to the
   * caller: a sentence that has just changed meaning is a state change a reader
   * is looking straight at, and holding it for the next throttled frame leaves
   * the surface showing the old reading for up to a second.
   */
  const closeSayTurn = (): boolean => {
    let closed = false;
    for (const [id, row] of ledger) {
      if (row.kind === 'say' && !row.aside) {
        ledger.set(id, { ...row, aside: true });
        closed = true;
      }
    }
    return closed;
  };

  /**
   * A tool that reported work underneath itself: subagents become children of
   * the row that spawned them, and a declared checklist becomes the run's plan.
   *
   * The checklist is the run's, not the call's, so it outlives the tool call
   * that declared it — otherwise the plan would vanish the moment the tool
   * returned, which is exactly when the user starts wanting it.
   */
  const applyProgressDetail = (callId: string, detail: RunProgressDetail): void => {
    // A call the model addressed by UUID can only be named once it returns.
    if (detail.detail) {
      const current = ledger.get(callId);
      if (current) ledger.set(callId, { ...current, outcome: detail.detail });
    }
    if (detail.children?.length) {
      const current = ledger.get(callId);
      if (current) {
        ledger.set(callId, {
          ...current,
          children: detail.children.map(child => ({
            label: child.label,
            status: child.status,
            ...(child.detail ? { outcome: child.detail } : {}),
            ...(child.elapsed ? { elapsed: child.elapsed } : {}),
          })),
        });
      }
    }
    if (detail.todos?.length) {
      const items = detail.todos.map(todo => ({ title: todo.title, status: todo.status }));
      const settled = items.filter(i => i.status === 'done' || i.status === 'skipped').length;
      const current = items.find(i => i.status === 'running')?.title;
      const next = items.find(i => i.status === 'pending')?.title;
      declared = {
        done: settled,
        total: items.length,
        ...(current ? { current } : next ? { next } : {}),
        items,
      };
    }
  };

  const apply = (event: RunProgressEvent): TimelineUrgency => {
    // Live answer prose has its own web stream. It is not a timeline row: the
    // sentence-sized `say` projection below remains the readable work-log and
    // Lark-card representation of the same model output.
    if (event.type === 'answer_delta' || event.type === 'answer_reset') return 'throttled';
    const beginsProtectedRead = event.type === 'tool_start'
      && !!event.toolId
      && isProtectedShopifyToolId(event.toolId);
    if (beginsProtectedRead) {
      protectedDataUsed = true;
      ledger.clear();
      declared = undefined;
      actionCount = 0;
    }
    if (protectedDataUsed) {
      // Tool arguments, progress details, model narration, and declared plans
      // may all contain customer/order data. Keep only a generic live state
      // once a protected read starts; the final reply is transient.
      phase = 'Working';
      state = 'working';
      liveLabel = 'Working…';
      return 'immediate';
    }

    if (event.type === 'starting') {
      phase = 'Starting';
      state = 'queued';
      // The container says which stage it is in and names it. Discarding that
      // and printing "Thinking…" was the worst moment in the run to be vague:
      // a cold container can take tens of seconds to come up, and a reader
      // watching an unchanging label has no way to tell booting from hung.
      liveLabel = event.label.trim() || 'Starting…';
    } else if (event.type === 'working') {
      phase = 'Thinking';
      state = 'thinking';
      liveLabel = 'Thinking…';
    } else if (event.type === 'ready' || event.type === 'thinking') {
      phase = 'Thinking';
      state = 'thinking';
      liveLabel = 'Thinking…';
    } else if (event.type === 'say') {
      phase = 'Writing';
      state = 'writing';
      liveLabel = 'Preparing your response…';
      // Talking is doing something other than thinking, so it ends the thought
      // that led to it.
      settleThoughts();
      // Keyed by turn as well as block, because a block index restarts at zero
      // in each new assistant message — without the turn, the second thing the
      // model says would overwrite the first instead of following it.
      put(`say:${sayTurn}:${event.index}`, {
        kind: 'say',
        label: event.text,
        count: 1,
        status: 'done',
      });
    } else if (event.type === 'thought') {
      phase = 'Thinking';
      state = 'thinking';
      liveLabel = 'Thinking…';
      // A new block of reasoning ends the one before it: they are separate rows,
      // and only the newest is still being written.
      settleThoughts();
      // Keyed the same way a `say` is, and in the same turn space, so a run that
      // thinks and then talks keeps them in the order it produced them. The two
      // must not share a key prefix: a thought and a sentence can carry the same
      // block index within one message, and one would silently replace the
      // other.
      put(`thought:${sayTurn}:${event.index}`, {
        kind: 'thought',
        label: event.text,
        count: 1,
        status: 'running',
      });
    } else if (event.type === 'tool_start') {
      const tool = toolRowLabels(event.toolName, event.toolId);
      phase = 'Working';
      state = 'working';
      liveLabel = tool.liveLabel;
      actionCount += 1;
      settleThoughts();
      // A tool call closes whatever the model was saying; what it says next
      // belongs after this row, not merged into the sentence before it. It also
      // settles what those sentences *were*: the model went on working, so they
      // were asides and not the reply.
      sayTurn += 1;
      const reclassified = closeSayTurn();
      // The outcome starts as what the call is *about* — the command, the file,
      // the capability — because "what it produced" is not known yet and a bare
      // "In progress" beside a ● is the restatement the card is built to avoid.
      const about = callSubject(event.toolName, event.toolId, event.detail);
      put(event.callId, {
        kind: 'tool',
        label: tool.label,
        count: 1,
        status: 'running',
        ...(about ? { outcome: about } : {}),
        // Carried, not just rendered. A surface that draws vendor marks needs
        // to know who was called, and the label it would otherwise have to
        // parse is English written for a reader.
        toolName: event.toolName,
        ...(event.toolId ? { toolId: event.toolId } : {}),
      });
      // A sentence that has just stopped being the reply is the one thing on
      // screen a reader is actively looking at. Waiting for the next throttled
      // frame would leave it drawn as the reply for up to a second after it
      // stopped being one.
      if (reclassified) return 'immediate';
    } else if (event.type === 'tool_progress') {
      applyProgressDetail(event.callId, event);
      phase = 'Working';
      state = 'working';
    } else if (event.type === 'tool_end') {
      applyProgressDetail(event.callId, event);
      const current = ledger.get(event.callId);
      if (current) {
        ledger.set(event.callId, {
          ...current,
          status: event.isError ? 'failed' : 'done',
        });
      }
      phase = 'Working';
      state = 'working';
      liveLabel = event.isError ? 'A step failed; checking what can continue…' : 'Continuing…';
    } else {
      phase = 'Writing';
      state = 'writing';
      liveLabel = 'Preparing your response…';
    }
    return 'throttled';
  };

  const observedProtectedData = (): void => {
    protectedDataUsed = true;
  };

  const finishing = (): void => {
    phase = 'Writing';
    state = 'writing';
    liveLabel = 'Preparing your response…';
    // Nothing is still being reasoned about once the run is writing its reply,
    // and a record kept with a thought left open would replay as one.
    settleThoughts();
  };

  const timeline = (): ChannelTimeline => ({
    phase,
    state,
    liveLabel,
    actionCount,
    startedAtMs: input.startedAtMs,
    ...(ledger.size > 0 ? { ledger: [...ledger.values()] } : {}),
    ...(declared ? { declared, ...fractionOf(declared) } : {}),
  });

  return {
    apply,
    observedProtectedData,
    finishing,
    timeline,
    get protectedDataUsed() { return protectedDataUsed; },
  };
}

/**
 * The only honest denominator a run has.
 *
 * Derived from the declared checklist and nothing else: a fraction counted from
 * "tool calls so far" has no total, because the total is unknowable until the
 * run ends. Absent a checklist these stay unset, and a renderer that wants a
 * progress bar simply does not draw one.
 */
function fractionOf(declared: ChannelDeclaredPlan): Pick<
  ChannelTimeline,
  'completedSteps' | 'totalSteps' | 'progressPct'
> {
  if (declared.total <= 0) return {};
  const done = Math.min(declared.done, declared.total);
  return {
    completedSteps: done,
    totalSteps: declared.total,
    progressPct: Math.round((done / declared.total) * 100),
  };
}

/**
 * How a tool call is titled in the run log, and what the run says it is doing
 * while the call is open.
 */
export function toolRowLabels(toolName: string, toolId?: string): {
  label: string;
  liveLabel: string;
} {
  // A governed call is named by the tool it ran, not by the gateway it went
  // through. Heading the row "Divo" spent its widest word on plumbing and then
  // repeated the real name in the detail beside it; and the vendor-prefix
  // guesses this replaced said "Google" where the tool table already knows to
  // say "Google Drive".
  if (toolId) {
    const { name } = toolLabel(toolId);
    return { label: name, liveLabel: `Working in ${name}…` };
  }
  if (toolName === 'bash') return { label: 'Terminal', liveLabel: 'Running a terminal command…' };
  if (toolName === 'read') return { label: 'Files', liveLabel: 'Reading files…' };
  if (toolName === 'write') return { label: 'Files', liveLabel: 'Writing files…' };
  if (toolName === 'edit') return { label: 'Files', liveLabel: 'Editing files…' };
  // Named rather than left to the humanizer below, which was rendering these
  // as "Skill view" and "Todos" — an internal tool id spelled out with a space
  // in it, on a card a customer reads.
  if (toolName === 'divo_skill_view') return { label: 'Skill', liveLabel: 'Loading a Divo skill…' };
  if (toolName === 'divo_skill_resolve') {
    return { label: 'Skill', liveLabel: 'Finding the right Divo skill…' };
  }
  if (toolName === 'divo_todos') return { label: 'Plan', liveLabel: 'Planning the work…' };
  if (toolName === 'divo_subagents') {
    return { label: 'Subagents', liveLabel: 'Running a subagent…' };
  }
  if (toolName === 'divo_artifact') {
    return { label: 'Artifact', liveLabel: 'Preparing an artifact…' };
  }
  if (toolName === 'divo_gateway') {
    return { label: 'Divo', liveLabel: 'Using a company capability…' };
  }
  // Never a bare "Tool": the activity row exists to say what ran, and an
  // anonymous row is a line of card height spent on nothing. Any unmapped tool
  // is still readable once its identifier is written out as words.
  const humanized = toolName
    .replace(/^divo_/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
  const label = humanized ? humanized.charAt(0).toUpperCase() + humanized.slice(1) : 'Tool';
  return { label, liveLabel: `Running ${label.toLowerCase()}…` };
}

/**
 * What a step is about, in words rather than identifiers.
 *
 * The container sends the argument that names the work, untranslated, because
 * the table that turns `omsSiteData` into "OMS Site Data" lives on this side — a
 * log reading `omsSiteData · tools.invoke` shows the user two internal
 * identifiers and an internal namespace. A shell command or a file name is
 * already words and is passed through as it stands.
 */
export function callSubject(
  toolName: string,
  toolId: string | undefined,
  detail: string | undefined,
): string | undefined {
  if (toolName === 'divo_gateway' || toolId) return gatewayOpPhrase(detail);
  // An older container still sends a skill's UUID here. It names nothing to a
  // reader, and the row is labelled properly when the call returns anyway.
  return detail && UUID_ONLY.test(detail) ? undefined : detail;
}

const UUID_ONLY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
