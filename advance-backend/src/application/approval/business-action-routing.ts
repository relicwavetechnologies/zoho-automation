import type { ChannelKey } from '../../domain/channel/incoming-message';
import type { ToolActionGroup } from '../../domain/permissions/tool-action-group';

export interface BusinessActionRoutingInput {
  readonly action: ToolActionGroup;
  readonly channel?: ChannelKey;
  readonly reviewAlreadyRecorded?: boolean;
}

/**
 * Requester confirmation is a product decision, not a runtime capability test.
 * Web and Lark both rely on conversational review and proceed to central
 * governance. Desktop and AirNote keep their client-owned confirmation
 * adapters until those products intentionally adopt the same interaction.
 */
export function requiresRequesterConfirmation(input: BusinessActionRoutingInput): boolean {
  if (input.action === 'read' || input.reviewAlreadyRecorded) return false;
  return input.channel !== 'lark' && input.channel !== 'web';
}
