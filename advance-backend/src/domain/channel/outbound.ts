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

export type ChannelToolFamily =
  | 'zoho'
  | 'lark'
  | 'google'
  | 'context'
  | 'orchestration'
  | 'other';

export interface ChannelPlanStep {
  readonly status:     ChannelPlanStepStatus;
  readonly title:      string;
  readonly subtitle?:  string;
  readonly toolFamily?: ChannelToolFamily;
}

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
 * One entry in the run's log, in the order it happened.
 *
 * `say` is something the model told the user; `tool` is something it did. They
 * share a list because they share a timeline — a run that only shows its tool
 * calls reads as a machine grinding, and one that only shows its talking hides
 * the work. Interleaved, the two explain each other.
 */
export interface ChannelLedgerRow {
  /** Defaults to `tool`; rows written before this field existed are tool rows. */
  readonly kind?:     'tool' | 'say';
  readonly label:     string;
  readonly count:     number;
  readonly outcome?:  string;
  readonly status:    ChannelPlanStepStatus;
  readonly children?: ReadonlyArray<ChannelLedgerRow>;
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
  readonly plan?:           ReadonlyArray<ChannelPlanStep>;
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
  readonly executionTrace?: string;
  /** Protected replies may be delivered but must never be retained for replay. */
  readonly retention?: 'transient';
}
