import { dynamicTool } from 'ai';
import { z } from 'zod';
import type { CatalogSkill, SkillCatalogService } from '../../../skills/skill-catalog.service';
import type { PermissionResult } from '../../../permissions/permission.types';
import type { Tool as AppTool } from '../tool.contract';

const inputSchema = z.object({
  query: z.string().min(1).describe('The capability needed, for example "create a Lark document" or "send Gmail"'),
});

export interface GovernedSkillDiscoveryContext {
  readonly skillCatalog: SkillCatalogService;
  readonly companyId: string;
  readonly departmentId?: string;
  readonly permission: PermissionResult;
  readonly grantedSkillIds: ReadonlySet<string>;
  readonly visibleSkills: readonly CatalogSkill[];
  readonly permittedTools: ReadonlyArray<AppTool<unknown, unknown>>;
  readonly onDiscovery?: (event: {
    query: string;
    outcome: 'success' | 'failure';
    skillId?: string;
  }) => void;
}

/**
 * Request-scoped DB skill discovery for server orchestration.
 *
 * The visible skill list has already passed explicit skill grants. Tool
 * documentation is then intersected with the PermissionService result so the
 * model never receives an unusable tool as an executable capability.
 */
export function createGovernedDiscoverSkillTool(context: GovernedSkillDiscoveryContext) {
  const permittedTools = new Map(context.permittedTools.map((tool) => [String(tool.id), tool]));
  const availableSkills = context.visibleSkills
    .map((skill) => `${skill.name} — ${skill.description}`)
    .join('\n');

  return dynamicTool({
    description: 'Load an admin-approved company skill and the permitted tool schema needed to perform the requested work.',
    inputSchema: inputSchema as never,
    execute: async (input: unknown): Promise<string> => {
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success) {
        return `error: invalid discover_skill input — ${parsed.error.errors
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`;
      }

      const matches = await context.skillCatalog.searchVisible({
        companyId: context.companyId,
        ...(context.departmentId ? { departmentId: context.departmentId } : {}),
        permission: context.permission,
        grantedSkillIds: context.grantedSkillIds,
        query: parsed.data.query,
        limit: 3,
      });

      const selected = matches[0]?.skill;
      if (!selected) {
        context.onDiscovery?.({ query: parsed.data.query, outcome: 'failure' });
        return availableSkills.length > 0
          ? `No approved skill matched "${parsed.data.query}". Approved skills:\n${availableSkills}`
          : 'No skills are approved for this member. Ask a company administrator to grant the required skill.';
      }

      const toolDocs = selected.toolIds.flatMap((toolId) => {
        const tool = permittedTools.get(toolId);
        if (!tool) return [];
        return [`### ${tool.id}\n${tool.description}\n${tool.parameterDocs}`];
      });
      const alternatives = matches.slice(1)
        .map((match) => `${match.skill.name} — ${match.skill.description}`)
        .join('\n');

      context.onDiscovery?.({
        query: parsed.data.query,
        outcome: 'success',
        skillId: selected.id,
      });

      return [
        `[Approved skill loaded: ${selected.name}]`,
        `## Instructions\n${selected.instructions}`,
        toolDocs.length > 0
          ? `## Permitted tools\n${toolDocs.join('\n\n')}`
          : '## Permitted tools\nNo executable tools from this skill are allowed for the current member.',
        alternatives.length > 0 ? `## Other possible matches\n${alternatives}` : '',
      ].filter(Boolean).join('\n\n');
    },
  });
}
