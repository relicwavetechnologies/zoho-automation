import type { ToolActionGroup } from '../../tools/tool-action-groups';
import type { RuntimeChannel } from './runtime.types';

export type RuntimeToolAuthorizationInput = {
  toolId: string;
  actionGroup: ToolActionGroup;
  allowedToolIds: string[];
  allowedActionsByTool: Record<string, ToolActionGroup[]>;
  blockedToolIds: string[];
  channel: RuntimeChannel;
  engineMode?: 'primary' | 'shadow';
};

export type RuntimeToolAuthorizationResult = {
  allowed: boolean;
  requiresApproval: boolean;
  failureReason?: string;
};

const MUTATING_ACTION_GROUPS = new Set<ToolActionGroup>(['create', 'update', 'delete', 'send', 'execute']);

export class RuntimeToolPolicy {
  authorize(input: RuntimeToolAuthorizationInput): RuntimeToolAuthorizationResult {
    if (input.blockedToolIds.includes(input.toolId)) {
      return {
        allowed: false,
        requiresApproval: false,
        failureReason: `Tool "${input.toolId}" is blocked for channel ${input.channel}.`,
      };
    }

    if (!input.allowedToolIds.includes(input.toolId)) {
      return {
        allowed: false,
        requiresApproval: false,
        failureReason: `Tool "${input.toolId}" is not allowed for the requester.`,
      };
    }

    const allowedActions = input.allowedActionsByTool[input.toolId] ?? [];
    if (!allowedActions.includes(input.actionGroup)) {
      return {
        allowed: false,
        requiresApproval: false,
        failureReason: `Action group "${input.actionGroup}" is not allowed for tool "${input.toolId}".`,
      };
    }

    if (input.engineMode === 'shadow' && MUTATING_ACTION_GROUPS.has(input.actionGroup)) {
      return {
        allowed: false,
        requiresApproval: false,
        failureReason: 'Mutating tool actions are disabled in shadow mode.',
      };
    }

    return {
      allowed: true,
      requiresApproval: MUTATING_ACTION_GROUPS.has(input.actionGroup),
    };
  }
}

export const runtimeToolPolicy = new RuntimeToolPolicy();

