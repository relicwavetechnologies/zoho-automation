export type InteractiveAction = {
  readonly label: string;
  readonly value: string;
  readonly url?: never;
  readonly style?: 'primary' | 'danger' | 'default';
} | {
  readonly label: string;
  readonly value?: never;
  readonly url: string;
  readonly style?: 'primary' | 'danger' | 'default';
};

export interface ChannelBranding {
  readonly departmentLabel?: string;
  readonly departmentColor?: 'green' | 'blue' | 'purple' | 'orange' | 'red' | 'turquoise' | 'grey';
}

export type ChannelPlanStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

/**
 * One row of the run's activity list: a tool call, or a group of consecutive
 * calls to the same tool.
 *
 * `outcome` carries what the step produced ("4 results", "Created INV-1043") and
 * nothing else. It must never restate the status — the row's marker already
 * shows running/done/failed, and writing "Done" beside a ✓ is the duplication
 * that made the old card feel padded.
 *
 * `children` is one level deep, for work a step farms out: a subagent's tasks
 * sit under the `divo_subagents` row rather than becoming peers of it.
 */

/**
 * One agent working under a step that farmed work out.
 *
 * It has its own shape rather than being another `ChannelLedgerRow`, because it
 * is not one and never was: it has no count, no vendor, no children of its own,
 * and it is not a tool call — it is an agent, with a role, a task, and a clock.
 * Typed as a row, every surface drawing one had to carry fields that could not
 * mean anything here and reach past them for the three that could.
 */
export interface ChannelLedgerChild {
  /** The agent's role. This is what names it on screen. */
  readonly label:    string;
  /** What it was asked to do. */
  readonly outcome?: string;
  readonly status:   ChannelPlanStepStatus;
  /**
   * How long it has been working, while it still is.
   *
   * Deliberately outside every redraw fingerprint downstream: it changes once a
   * second by design, and a card that repaints because a number ticked is a
   * card that repaints for no reader.
   */
  readonly elapsed?: string;
}
/**
 * One entry in the run's log, in the order it happened.
 *
 * `say` is something the model told the user; `tool` is something it did;
 * `thought` is the model reasoning to itself on the way. They share a list
 * because they share a timeline — a run that only shows its tool calls reads as
 * a machine grinding, and one that only shows its talking hides the work.
 * Interleaved, the three explain each other.
 *
 * Not every surface prints all three. A `thought` is the model addressing
 * itself, and a Lark card is read by a whole chat, so that surface drops them —
 * a decision about who is looking at the card, made where the card is built.
 */
export interface ChannelLedgerRow {
  /** Defaults to `tool`; rows written before this field existed are tool rows. */
  readonly kind?:     'tool' | 'say' | 'thought';
  /**
   * What this row is, for as long as the run remembers it.
   *
   * A surface draws a list, and a list needs to know which entry is which one
   * from last time. Without this the only thing to key off is position, and
   * position is not identity: a sentence that gets reclassified, or a row that
   * appears above another, renumbers everything after it and the renderer tears
   * down rows that never changed. The reducer already had this — it keys its own
   * map by it — and was dropping it on the way out.
   */
  readonly id?:       string;
  /**
   * For a `say` row: the model went on to do something after saying it, so the
   * sentence was an aside rather than the reply it landed on.
   *
   * The reply has its own place on every surface, so this is what tells a work
   * log which sentences are its to draw. It is deliberately absent — not
   * `false` — while the turn is still open: nothing has followed the sentence
   * *yet*, and a run that ends right here ended on it.
   */
  readonly aside?:    true;
  readonly label:     string;
  readonly count:     number;
  readonly outcome?:  string;
  readonly status:    ChannelPlanStepStatus;
  readonly children?: ReadonlyArray<ChannelLedgerChild>;
  /**
   * Who was called, in the wire's own words rather than the reader's.
   *
   * `label` is English — "Google Gmail", "Terminal" — and English is a one-way
   * street: a surface that wants to draw the Gmail mark beside that row has to
   * parse a sentence back into a vendor, and gets it wrong the moment the
   * wording changes. The reducer is handed both of these at `tool_start` and
   * used to drop them on the floor.
   *
   * `toolId` is a `CANONICAL_TOOL_IDS` entry (`googleGmail`, `zohoBooks`) for a
   * governed call; `toolName` is the container's own tool (`bash`, `read`,
   * `divo_gateway`) and is all there is for an ungoverned one. A surface that
   * only prints text ignores both — Lark does — and one that draws marks keys
   * off them exactly as the desktop work log does.
   */
  readonly toolId?:   string;
  readonly toolName?: string;
}

/**
 * A checklist the model committed to up front (manageTodos). This is the only
 * source of a trustworthy denominator — step counts derived from "tool calls so
 * far" cannot produce one, because the total is unknowable mid-run.
 */
export interface ChannelDeclaredPlan {
  readonly done:     number;
  readonly total:    number;
  readonly current?: string;
  readonly next?:    string;
  /**
   * The checklist itself, when the producer names its steps. Rendered folded —
   * a plan is context for the current step, not the headline.
   */
  readonly items?:   ReadonlyArray<{
    readonly title:  string;
    readonly status: ChannelPlanStepStatus;
  }>;
}

export type ChannelRunState =
  | 'queued'
  | 'thinking'
  | 'planning'
  | 'working'
  | 'writing'
  | 'done'
  | 'blocked';

export interface ChannelTimeline {
  /**
   * Short restatement of what the user asked for. Titles the status card so a
   * chat with several Divo cards stays scannable — the bot's own name is already
   * printed above every card by the client.
   */
  readonly subject?:       string;
  /** Header subtitle, e.g. "Executing · 2/5" */
  readonly phase?:         string;
  /** Coarse run state — drives the status card title. */
  readonly state?:         ChannelRunState;
  /** 0–100 for progress chart */
  readonly progressPct?:   number;
  readonly completedSteps?: number;
  readonly totalSteps?:     number;
  /** Tool calls performed so far. Counts up; never used as a denominator. */
  readonly actionCount?:   number;
  /**
   * When the run started (epoch ms). Renderers compute elapsed time at draw
   * time — a pre-computed duration freezes on any redraw that reuses the last
   * snapshot, such as the Lark heartbeat during a long tool call.
   */
  readonly startedAtMs?:   number;
  /** Set only when the model declared a checklist — then a fraction is honest. */
  readonly declared?:      ChannelDeclaredPlan;
  /** Full run ledger, grouped by tool family. */
  readonly ledger?:        ReadonlyArray<ChannelLedgerRow>;
  readonly liveLabel?:      string;
  /** Rolling live sentences from model stream (max 3 committed). */
  readonly narration?:      ReadonlyArray<string>;
  /** In-progress sentence not yet committed to a line. */
  readonly narrationActive?: string;
}

export interface StatusUpdate {
  readonly kind:      'status';
  readonly text?:     string;
  readonly branding?: ChannelBranding;
  readonly timeline?: ChannelTimeline;
  readonly terminal:  boolean;
}

export interface FinalReply {
  readonly kind:            'final';
  readonly text:            string;
  readonly format:          'text' | 'markdown' | 'interactive_card';
  readonly branding?:       ChannelBranding;
  readonly actions?:        readonly InteractiveAction[];
  readonly attachments?:    readonly { url: string; label?: string }[];
  /**
   * The run's activity log, structured.
   *
   * Sent as rows rather than as pre-rendered text: a Lark card folds it into a
   * collapsible panel under a character budget, a browser draws it as steps.
   * Flattening it here would have made the first renderer's shape everyone's.
   */
  readonly ledger?: ReadonlyArray<ChannelLedgerRow>;
  /** Protected replies may be delivered but must never be retained for replay. */
  readonly retention?: 'transient';
}
