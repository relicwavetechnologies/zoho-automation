import { dynamicTool } from 'ai';
import { z } from 'zod';
import type { PermissionResult } from '../../../permissions/permission.types';
import type { WorkResolutionService, WorkResolution } from '../../../gateway/work-resolution.service';

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
  readonly onResolution?: (event: {
    readonly query: string;
    readonly outcome: 'success' | 'failure';
    readonly resolution?: WorkResolution;
  }) => void;
}) {
  return dynamicTool({
    description:
      'Resolve meaningful Divo/company work against the authenticated member’s department persona and approved company skills. ' +
      'Returns exact persona-linked recipes, strong complementary recipes, provenance, and rejected weak matches.',
    inputSchema: inputSchema as never,
    execute: async (value: unknown): Promise<string> => {
      const parsed = inputSchema.safeParse(value);
      if (!parsed.success) {
        return `error: invalid resolve_work input — ${parsed.error.errors
          .map(issue => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`;
      }

      try {
        const resolution = await input.resolver.resolve({
          companyId: input.companyId,
          userId: input.userId,
          ...(input.departmentId ? { departmentId: input.departmentId } : {}),
          permission: input.permission,
          query: parsed.data.query,
          ...(parsed.data.variants ? { variants: parsed.data.variants } : {}),
        });
        input.onResolution?.({ query: parsed.data.query, outcome: 'success', resolution });
        return formatWorkResolution(resolution);
      } catch (error) {
        input.onResolution?.({ query: parsed.data.query, outcome: 'failure' });
        return `error: work context could not be resolved — ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });
}

function formatWorkResolution(resolution: WorkResolution): string {
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
    lines.push('', 'No exact or strong company recipe matched. Use discover_skill only as a bounded fallback, then use call_tool only for permitted capabilities.');
  }

  if (resolution.rejectedSkills.length > 0) {
    lines.push('', '## Rejected matches — never use automatically');
    for (const item of resolution.rejectedSkills) lines.push(`- ${item.name}: ${item.reason}`);
  }
  return lines.join('\n');
}
