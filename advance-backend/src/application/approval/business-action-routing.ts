import type { ChannelKey } from '../../domain/channel/incoming-message';
import type { ToolActionGroup } from '../../domain/permissions/tool-action-group';
import type { PersonalGate } from '../../domain/approval/personal-gate';
import { requiresPersonalConfirmation } from '../../domain/approval/gate-forecast';

export interface BusinessActionRoutingInput {
  readonly toolId: string;
  readonly action: ToolActionGroup;
  readonly channel?: ChannelKey;
  readonly reviewAlreadyRecorded?: boolean;
  /** The requester's own "ask me before Divo does this", per action. */
  readonly personal?: PersonalGate | null;
}

/**
 * Requester confirmation is a product decision, not a runtime capability test.
 * Web and Lark both rely on conversational review and proceed to central
 * governance. Desktop and AirNote keep their client-owned confirmation
 * adapters until those products intentionally adopt the same interaction.
 *
 * The two clauses below are the ones this module owns: a read is never
 * confirmed, and neither is a payload whose review was already recorded
 * elsewhere. Who confirms the rest is `requiresPersonalConfirmation` in the
 * domain, called rather than restated so the settings screen and this function
 * cannot disagree about what is about to happen.
 */
export function requiresRequesterConfirmation(input: BusinessActionRoutingInput): boolean {
  if (input.action === 'read' || input.reviewAlreadyRecorded) return false;
  return requiresPersonalConfirmation({
    channel: input.channel,
    toolId: input.toolId,
    action: input.action,
    ...(input.personal ? { personal: input.personal } : {}),
  });
}
