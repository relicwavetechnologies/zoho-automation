export interface InteractiveAction {
  readonly label: string;
  readonly value: string;
  readonly style?: 'primary' | 'danger' | 'default';
}

export interface ChannelBranding {
  readonly departmentLabel?: string;
  readonly departmentColor?: 'green' | 'blue' | 'purple' | 'orange' | 'red' | 'turquoise' | 'grey';
}

export interface ChannelTimeline {
  readonly plan?: ReadonlyArray<{
    status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
    title:  string;
  }>;
  readonly recent?:    ReadonlyArray<string>;
  readonly liveLabel?: string;
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
  readonly kind:        'final';
  readonly text:        string;
  readonly format:      'text' | 'markdown' | 'interactive_card';
  readonly branding?:   ChannelBranding;
  readonly actions?:    readonly InteractiveAction[];
  readonly attachments?: readonly { url: string; label?: string }[];
}

export type OutboundEvent = StatusUpdate | FinalReply;
