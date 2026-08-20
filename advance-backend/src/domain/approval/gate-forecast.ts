/**
 * "If I ask for this, will Divo stop and check with somebody?"
 *
 * Nobody could answer that. Four rules decide it and they live in four places:
 * whether the action is gated (`managerApprovalJson` on the department),
 * whether the asker happens to be the approver (self-bypass, in the gate
 * service), whether the channel does requester confirmations at all
 * (`business-action-routing`), and whether an identical call was already
 * approved (an args-hash grant). Three of those four are invisible, so the
 * honest answer to "will this ask me?" was "run it and find out".
 *
 * This is that answer, computed once. It is deliberately a *forecast* — the
 * same inputs the runtime holds, arranged to say what will happen rather than
 * to make it happen — so a screen can render it without pretending to execute.
 *
 * The point of the module is that both sides read it. A screen that recomputed
 * this from its own copy of the rules would be right on the day it shipped and
 * wrong the first time one rule moved, which is exactly the failure being fixed.
 *
 * Pure. No I/O, no clock, no database. Every input is a value the caller
 * already has.
 */
import type { ChannelKey } from '../channel/incoming-message';
import type { ToolActionGroup } from '../permissions/tool-action-group';
import { personallyGated, type PersonalGate } from './personal-gate';

/** The gating config as stored on a department, reduced to what decides this. */
export interface GatePolicy {
  readonly enabled: boolean;
  readonly requiredActions: readonly {
    readonly toolId: string;
    readonly actions: readonly string[];
  }[];
  /** Any tool calling one of these action groups is gated, whatever the tool. */
  readonly requiredActionGroups?: readonly string[];
  /** Legacy: every non-read action on these tools is gated. */
  readonly requiredToolIds?: readonly string[];
}

export interface GateForecastInput {
  readonly toolId: string;
  readonly action: ToolActionGroup;
  /** Null when the asker's department has no policy at all. */
  readonly policy: GatePolicy | null;
  /** Where the asking happens. Decides whether personal confirmation applies. */
  readonly channel: ChannelKey;
  /** Is the person asking also the person whose yes this policy names? */
  readonly askerIsApprover: boolean;
  /** `DIVO_APPROVAL_DISABLE_MANAGER_SELF_BYPASS`, or the test flag. */
  readonly selfBypassDisabled: boolean;
  /**
   * The reader's own "ask me before Divo does this", per action.
   *
   * Independent of the department policy on purpose. The gate decides what a
   * manager must see; this decides what somebody wants to see of their own
   * work. It is also the only way an approver sees their own actions at all,
   * since the gate implies their yes.
   */
  readonly personal: PersonalGate | null;
  /** False when the department has a policy but nobody holds the approver role. */
  readonly approverExists: boolean;
}

/**
 * What will happen, and the one sentence that explains it.
 *
 * `because` is part of the value rather than something the screen writes,
 * because the explanation is the whole product here. "Manager approves" with no
 * reason is the state people are already in.
 */
export type GateForecast =
  | { readonly kind: 'immediate'; readonly because: ImmediateReason }
  | { readonly kind: 'you_confirm'; readonly because: PersonalReason }
  | { readonly kind: 'approver_says_yes' }
  | { readonly kind: 'blocked'; readonly because: 'no_approver' };

export type PersonalReason =
  /** They named this exact action in their own list, or asked for everything. */
  | 'you_picked'
  /** Their channel confirms with the requester whatever they picked. */
  | 'channel';

export type ImmediateReason =
  /** Reads are never gated, anywhere, by anyone. */
  | 'read'
  /** The department has a policy and this action is not in it. */
  | 'not_listed'
  /** The department has no policy, or its policy is switched off. */
  | 'no_policy'
  /** It is gated, but the asker is the approver, so their own yes is implied. */
  | 'self_bypass';

export function forecastGate(input: GateForecastInput): GateForecast {
  if (input.action === 'read') return { kind: 'immediate', because: 'read' };

  if (personallyGated(input.personal, input.toolId, input.action)) {
    return { kind: 'you_confirm', because: 'you_picked' };
  }
  if (requiresPersonalConfirmation(input)) {
    return { kind: 'you_confirm', because: 'channel' };
  }

  if (!input.policy?.enabled) return { kind: 'immediate', because: 'no_policy' };
  if (!isGated(input.policy, input.toolId, input.action)) {
    return { kind: 'immediate', because: 'not_listed' };
  }

  /* Ordered after the gating test on purpose. Somebody who is the approver for
     an action nobody gated is not "bypassing" anything, and telling them they
     are would imply a rule exists where none does. */
  if (input.askerIsApprover && !input.selfBypassDisabled) {
    return { kind: 'immediate', because: 'self_bypass' };
  }

  if (!input.approverExists) return { kind: 'blocked', because: 'no_approver' };
  return { kind: 'approver_says_yes' };
}

/**
 * Whether the person who asked for the work is the one who confirms it.
 *
 * The whole rule, in one place. `requiresRequesterConfirmation` in the
 * application layer used to restate the channel half and drifted the moment the
 * personal gate arrived, so it now calls this instead. One function, two
 * readers: the runtime raising the confirmation and the screen predicting it.
 */
export function requiresPersonalConfirmation(input: {
  /** Undefined reads as "not a channel that skips this", the long-standing default. */
  readonly channel: ChannelKey | undefined;
  readonly toolId: string;
  readonly action: ToolActionGroup;
  readonly personal?: PersonalGate | null;
}): boolean {
  /* Two independent causes, and the person's own choice is checked first
     because it is the one they can see and change. Desktop and AirNote confirm
     by default through their own client-owned adapters; web and Lark only ever
     confirm because somebody asked to be asked about this action. */
  if (personallyGated(input.personal, input.toolId, input.action)) return true;
  return input.channel !== 'lark' && input.channel !== 'web';
}

function isGated(policy: GatePolicy, toolId: string, action: ToolActionGroup): boolean {
  const byToolAndAction = policy.requiredActions.some(
    (entry) => entry.toolId === toolId && entry.actions.includes(action),
  );
  const byActionGroup = policy.requiredActionGroups?.includes(action) ?? false;
  const byLegacyTool = policy.requiredToolIds?.includes(toolId) ?? false;
  return byToolAndAction || byActionGroup || byLegacyTool;
}

/**
 * The forecast as one short phrase, for a row in a list.
 *
 * Here rather than in the screen so the wording is the same in every place that
 * shows it, including anywhere it is shown next to the toggle that changes it.
 */
export function forecastLabel(forecast: GateForecast): string {
  if (forecast.kind === 'you_confirm') return 'You confirm';
  if (forecast.kind === 'approver_says_yes') return 'Your manager approves';
  if (forecast.kind === 'blocked') return 'Blocked';
  return 'Runs straight away';
}

/** Why, in one sentence a person can act on. */
export function forecastReason(forecast: GateForecast, approverName?: string): string {
  switch (forecast.kind) {
    case 'you_confirm':
      return forecast.because === 'you_picked'
        ? 'You asked to be checked with on this. Divo shows you exactly what it is about to do and waits for your yes.'
        : 'This channel always checks with whoever asked. Divo shows you what it is about to do and waits for your yes.';
    case 'approver_says_yes':
      return approverName
        ? `${approverName} is asked before this happens.`
        : 'Your department manager is asked before this happens.';
    case 'blocked':
      return 'This is set to need approval, but nobody in the department holds the approver role. Divo cannot run it or ask anyone.';
    case 'immediate':
      switch (forecast.because) {
        case 'read':
          return 'Looking something up never needs approval.';
        case 'not_listed':
          return 'Your department gates some actions, and this is not one of them.';
        case 'no_policy':
          return 'Your department has not switched on approvals.';
        case 'self_bypass':
          return 'This action needs the manager to say yes, and that is you, so it runs.';
      }
  }
}
