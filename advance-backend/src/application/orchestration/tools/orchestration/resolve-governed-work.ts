import { dynamicTool } from 'ai';
import { z } from 'zod';
import type { PermissionResult } from '../../../permissions/permission.types';
import type { WorkResolutionService, WorkResolution } from '../../../gateway/work-resolution.service';
import type { WorkBootstrapService } from '../../../gateway/work-bootstrap.service';
import { renderWorkBootstrapBrief } from './work-bootstrap-brief';

const inputSchema = z.object({
  query: z.string().trim().min(3).max(2_000)
    .describe('The exact original user request. Do not summarize or replace it.'),
  variants: z.array(z.string().trim().min(3).max(2_000)).max(2).optional()
    .describe('At most two intent-preserving variants for distinct domain, output, integration, or scheduling needs.'),
});

export function createResolveGovernedWorkTool(input: {
  readonly resolver: WorkResolutionService;
  readonly companyId: string;
  readonly userId: string;
  readonly departmentId?: string;
  readonly permission: PermissionResult;
  readonly expectedQuery?: string;
  readonly abortSignal?: AbortSignal;
  /**
   * Discovery context for the recipes this resolves to — the same bootstrap the
   * desktop gateway attaches to `work.resolve`. Optional so a caller without a
   * connection registry still resolves work; when absent the model simply has
   * no accounts preloaded, exactly as before.
   */
  readonly workBootstrap?: WorkBootstrapService;
  readonly onResolution?: (event: {
    readonly query: string;
    readonly outcome: 'success' | 'failure';
    readonly resolution?: WorkResolution;
  }) => void;
}) {
  const runtimeInputSchema = input.expectedQuery === undefined
    ? inputSchema
    : z.object({}).describe('Call with no arguments to resolve the exact current user request.');

  return dynamicTool({
    description:
      'Resolve meaningful Divo/company work against the authenticated member’s department persona and approved company skills. ' +
      'Returns exact persona-linked recipes, strong complementary recipes, provenance, and rejected weak matches.',
    inputSchema: runtimeInputSchema as never,
    execute: async (value: unknown): Promise<string> => {
      let query: string;
      let variants: readonly string[] | undefined;
      if (input.expectedQuery !== undefined) {
        query = input.expectedQuery;
      } else {
        const parsed = inputSchema.safeParse(value);
        if (!parsed.success) {
          return `error: invalid resolve_work input — ${parsed.error.errors
            .map(issue => `${issue.path.join('.')}: ${issue.message}`)
            .join('; ')}`;
        }
        query = parsed.data.query;
        variants = parsed.data.variants;
      }

      try {
        input.abortSignal?.throwIfAborted();
        const resolution = await input.resolver.resolve({
          companyId: input.companyId,
          userId: input.userId,
          ...(input.departmentId ? { departmentId: input.departmentId } : {}),
          permission: input.permission,
          query,
          ...(variants ? { variants } : {}),
          ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
        });
        input.abortSignal?.throwIfAborted();
        input.onResolution?.({ query, outcome: 'success', resolution });
        const brief = input.workBootstrap
          ? await buildBootstrapBrief({
              service: input.workBootstrap,
              companyId: input.companyId,
              userId: input.userId,
              permission: input.permission,
              query,
              resolution,
              ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
            })
          : '';
        return [formatWorkResolution(resolution, Boolean(brief)), brief].filter(Boolean).join('\n\n');
      } catch (error) {
        input.abortSignal?.throwIfAborted();
        input.onResolution?.({ query, outcome: 'failure' });
        return `error: work context could not be resolved — ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });
}

/**
 * Never let discovery context sink the resolution it decorates. Without the
 * brief the model is where it was before this existed; without the recipes it
 * has nothing at all, so a bootstrap failure is swallowed on purpose.
 */
async function buildBootstrapBrief(input: {
  readonly service: WorkBootstrapService;
  readonly companyId: string;
  readonly userId: string;
  readonly permission: PermissionResult;
  readonly query: string;
  readonly resolution: WorkResolution;
  readonly abortSignal?: AbortSignal;
}): Promise<string> {
  const toolIds = [
    ...input.resolution.persona.linkedSkills.flatMap(item => item.skill.toolIds),
    ...input.resolution.additionalSkills.flatMap(item => item.skill.toolIds),
  ];
  try {
    const bootstrap = await input.service.build({
      companyId: input.companyId,
      userId: input.userId,
      permission: input.permission,
      registryRevision: input.resolution.registryRevision,
      query: input.query,
      toolIds,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    });
    return renderWorkBootstrapBrief(bootstrap);
  } catch {
    input.abortSignal?.throwIfAborted();
    return '';
  }
}

function formatWorkResolution(resolution: WorkResolution, hasCanonicalBootstrap: boolean): string {
  const lines = [
    `[Divo work context resolved for: ${resolution.originalQuery}]`,
    'Apply the current user request and backend policy first. Do not use rejected recipes.',
  ];

  if (resolution.persona.rules.length > 0) {
    lines.push('', '## Matching manager persona rules');
    for (const rule of resolution.persona.rules) {
      lines.push(`- ${rule.scopeKey}/${rule.ruleKey}: ${rule.instruction}`);
    }
  }

  const selected = [
    ...resolution.persona.linkedSkills.map(item => ({
      source: 'exact persona-linked recipe',
      skill: item.skill,
    })),
    ...resolution.additionalSkills.map(item => ({
      source: `complementary search recipe (${item.reason})`,
      skill: item.skill,
    })),
  ];
  if (selected.length > 0) {
    lines.push('', '## Approved recipes');
    for (const item of selected) {
      lines.push(`### ${item.skill.name} — ${item.source}`);
      lines.push(item.skill.instructions);
      if (item.skill.toolIds.length > 0) {
        lines.push(`Permitted capability targets: ${item.skill.toolIds.join(', ')}`);
      }
    }
  } else {
    lines.push(
      '',
      hasCanonicalBootstrap
        ? 'No approved recipe matched. Canonical capability contracts and accounts for the explicitly named provider are loaded below. Use that context directly; do not load an unrelated skill.'
        : 'No exact or strong company recipe matched. Use discover_skill only as a bounded fallback, then use call_tool only for permitted capabilities.',
    );
  }

  if (resolution.rejectedSkills.length > 0) {
    lines.push('', '## Rejected matches — never use automatically');
    for (const item of resolution.rejectedSkills) lines.push(`- ${item.name}: ${item.reason}`);
  }
  return lines.join('\n');
}
