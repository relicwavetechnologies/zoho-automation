import { dynamicTool } from 'ai';
import type { ToolSet } from 'ai';
import { z } from 'zod';
import type { DynamicAgentDescriptor } from '../../../agents/dynamic-agent-descriptor';
import type { AgentRunCtx } from '../agent-run-ctx';
import { resolveToolsByIdFiltered } from '../../tools/tool-resolver';
import { runDynamicAgent } from './dynamic-agent.runner';

const taskSchema = z.object({
  task: z.string().describe('Task to delegate to this agent'),
});

export function buildAgentAsTool(
  childAgent: DynamicAgentDescriptor,
  allAgents: readonly DynamicAgentDescriptor[],
  ctx: AgentRunCtx,
  opts: { depth?: number; path?: readonly string[] } = {},
) {
  const depth = opts.depth ?? 0;
  const path = opts.path ?? [];

  return dynamicTool({
    description: childAgent.capabilityDescription,
    inputSchema: taskSchema as never,
    execute: async (input: unknown): Promise<string> => {
      const { task } = input as { task: string };
      const childCapabilities = buildCapabilitiesForAgent(childAgent, allAgents, ctx, {
        depth: depth + 1,
        path,
      });
      const result = await runDynamicAgent({
        task,
        agent:           childAgent,
        ctx,
        additionalTools: childCapabilities,
        depth:           depth + 1,
        path,
      });
      return result.result;
    },
  });
}

export function buildCapabilitiesForAgent(
  agent: DynamicAgentDescriptor,
  allAgents: readonly DynamicAgentDescriptor[],
  ctx: AgentRunCtx,
  opts: { depth?: number; path?: readonly string[] } = {},
): ToolSet {
  const depth = opts.depth ?? 0;
  const path = opts.path ?? [];

  if (depth > 3 || path.includes(agent.id)) {
    return {} as ToolSet;
  }

  ctx.logger.info('agent_as_tool.resolve_start', {
    agentSlug: agent.slug,
    agentToolIds: agent.toolIds,
    allowedToolIds: [...ctx.perm.allowedToolIds],
    allToolsAvailable: ctx.allTools.map(t => String(t.id)),
    depth,
  });

  const directTools = resolveToolsByIdFiltered(
    agent.toolIds,
    ctx.perm.allowedToolIds,
    ctx.allTools,
    {
      runContext: ctx.runContext,
      perm:       ctx.perm,
      logger:     ctx.logger,
      clock:      ctx.clock,
      ...(ctx.approvalGate ? { approvalGate: ctx.approvalGate } : {}),
      ...(ctx.chatId !== undefined ? { chatId: ctx.chatId } : {}),
    },
    ctx.toolById,
  );

  ctx.logger.info('agent_as_tool.resolve_done', {
    agentSlug: agent.slug,
    resolvedToolNames: Object.keys(directTools),
    resolvedCount: Object.keys(directTools).length,
  });

  const children = allAgents.filter(candidate => candidate.parentId === agent.id);
  const childTools = Object.fromEntries(
    children.map(child => [
      `agent_${child.slug.replace(/-/g, '_')}`,
      buildAgentAsTool(child, allAgents, ctx, { depth, path: [...path, agent.id] }),
    ]),
  ) as unknown as ToolSet;

  return {
    ...directTools,
    ...childTools,
  } as unknown as ToolSet;
}
