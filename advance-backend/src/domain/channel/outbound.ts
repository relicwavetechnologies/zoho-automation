export interface InteractiveAction {
  readonly label: string;
  readonly value: string;
  readonly style?: 'primary' | 'danger' | 'default';
}

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

/** One row of the grouped run ledger: consecutive calls to the same tool family. */
export interface ChannelLedgerRow {
  readonly label:   string;
  readonly count:   number;
  readonly outcome: string;
  readonly status:  ChannelPlanStepStatus;
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
  readonly actions?:  readonly InteractiveAction[];
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
}
