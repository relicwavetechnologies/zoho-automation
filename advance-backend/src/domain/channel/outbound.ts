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

export interface ChannelTimeline {
  /** Header subtitle, e.g. "Executing · 2/5" */
  readonly phase?:         string;
  /** 0–100 for progress chart */
  readonly progressPct?:   number;
  readonly completedSteps?: number;
  readonly totalSteps?:     number;
  readonly plan?:           ReadonlyArray<ChannelPlanStep>;
  readonly recent?:         ReadonlyArray<string>;
  readonly liveLabel?:      string;
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

export type OutboundEvent = StatusUpdate | FinalReply;
