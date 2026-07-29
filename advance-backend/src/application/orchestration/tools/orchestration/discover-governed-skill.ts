import { dynamicTool } from 'ai';
import { z } from 'zod';
import type { CatalogSkill, SkillCatalogService } from '../../../skills/skill-catalog.service';
import type { PermissionResult } from '../../../permissions/permission.types';
import type { Tool as AppTool } from '../tool.contract';
import type { WorkBootstrapService } from '../../../gateway/work-bootstrap.service';
import { renderWorkBootstrapBrief } from './work-bootstrap-brief';
import { asToolId } from '../../../../shared/ids';

const variantsSchema = z.array(z.string().trim().min(1).max(2_000)).max(2).optional()
  .describe('At most two short, intent-preserving router-search variants');
const skillIdSchema = z.string().trim().min(1).optional()
  .describe('Exact approved skill ID or slug to load after choosing a router or specialist');
const inputSchema = z.object({
  query: z.string().trim().min(1).max(2_000)
    .describe('The original user request, preserved verbatim'),
  variants: variantsSchema,
  skillId: skillIdSchema,
}).strict();

export interface GovernedSkillDiscoveryContext {
  readonly skillCatalog: SkillCatalogService;
  readonly companyId: string;
  readonly departmentId?: string;
  readonly permission: PermissionResult;
  readonly grantedSkillIds: ReadonlySet<string>;
  readonly expectedQuery?: string;
  readonly visibleSkills: readonly CatalogSkill[];
  readonly permittedTools: ReadonlyArray<AppTool<unknown, unknown>>;
  readonly userId?: string;
  /**
   * Mirrors the desktop gateway attaching a bootstrap to `skills.get`. This is
   * the attach point that matters when no company recipe matched: the model
   * falls through to discovery, and without accounts here it reaches a provider
   * tool holding nothing it can pass as a connectionId.
   */
  readonly workBootstrap?: WorkBootstrapService;
  readonly resolveDepartmentPermission?: (
    departmentId: string,
  ) => Promise<PermissionResult | null>;
  readonly onSkillLoaded?: (input: {
    skill: CatalogSkill;
    permission: PermissionResult;
    departmentId?: string;
  }) => void;
  readonly onTerminalFailure?: (failure: {
    status: 'permission_denied' | 'routing_unavailable';
    message: string;
  }) => void;
  readonly onDiscovery?: (event: {
    query: string;
    outcome: 'candidates' | 'success' | 'failure';
    skillId?: string;
    departmentId?: string;
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
  let activeDepartmentId = context.departmentId;
  let activePermission = context.permission;
  let terminalFailure: {
    status: 'permission_denied' | 'routing_unavailable';
    message: string;
  } | undefined;
  const runtimeInputSchema = context.expectedQuery === undefined
    ? inputSchema
    : z.object({
      variants: variantsSchema,
      skillId: skillIdSchema,
    }).strict().describe('The server preserves the exact current request. Do not supply or replace its query.');

  return dynamicTool({
    description: 'Search compact approved router cards, then load one exact approved router or specialist and its permitted tool schema.',
    inputSchema: runtimeInputSchema as never,
    execute: async (input: unknown): Promise<string> => {
      const parsed = runtimeInputSchema.safeParse(input);
      if (!parsed.success) {
        return `error: invalid discover_skill input — ${parsed.error.errors
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`;
      }
      const query = context.expectedQuery
        ?? (parsed.data as z.infer<typeof inputSchema>).query;

      if (terminalFailure) {
        return `${terminalFailure.status}: ${terminalFailure.message}`;
      }

      if (!parsed.data.skillId) {
        const candidates = await context.skillCatalog.searchVisibleRouters({
          companyId: context.companyId,
          ...(activeDepartmentId ? { departmentId: activeDepartmentId } : {}),
          permission: activePermission,
          grantedSkillIds: context.grantedSkillIds,
          includeGrantedDepartments: true,
          query,
          ...(parsed.data.variants ? { variants: parsed.data.variants } : {}),
          limit: 3,
        });
        if (candidates.length === 0) {
          context.onDiscovery?.({ query, outcome: 'failure' });
          return 'No approved router matched the request. Ask one concise clarification or explain that the required capability is not approved.';
        }
        context.onDiscovery?.({ query, outcome: 'candidates' });
        return [
          'Approved router candidates (advisory only; none has been loaded):',
          ...candidates.map((candidate) =>
            `- ${candidate.skillId} — ${candidate.name}: ${candidate.description} (matched: ${candidate.matchedTerms.join(', ')})`),
          context.expectedQuery === undefined
            ? 'Choose one exact candidate, reject them all, or ask one concise clarification. To load one, call discover_skill again with the original query and its exact skillId.'
            : 'Choose one exact candidate, reject them all, or ask one concise clarification. To load one, call discover_skill again with only its exact skillId; the server preserves the original request.',
        ].join('\n');
      }

      let selected = await context.skillCatalog.getVisible({
        companyId: context.companyId,
        ...(activeDepartmentId ? { departmentId: activeDepartmentId } : {}),
        permission: activePermission,
        grantedSkillIds: context.grantedSkillIds,
        includeGrantedDepartments: true,
        skillId: parsed.data.skillId,
      });
      if (!selected) {
        context.onDiscovery?.({ query, outcome: 'failure' });
        terminalFailure = {
          status: 'routing_unavailable',
          message:
            'The exact selected skill is unavailable or inconsistent with the current DB skill catalogue. '
            + 'Do not substitute another router or capability.',
        };
        context.onTerminalFailure?.(terminalFailure);
        return `${terminalFailure.status}: ${terminalFailure.message}`;
      }

      if (selected.departmentId && selected.departmentId !== activeDepartmentId) {
        const scopedPermission = await context.resolveDepartmentPermission?.(selected.departmentId);
        if (!scopedPermission) {
          context.onDiscovery?.({ query, outcome: 'failure', skillId: selected.id });
          terminalFailure = {
            status: 'permission_denied',
            message:
              `You do not have access to the department required by "${selected.name}". `
              + 'No tool was run. Ask a company administrator to grant the required department access.',
          };
          context.onTerminalFailure?.(terminalFailure);
          return `${terminalFailure.status}: ${terminalFailure.message}`;
        }
        activeDepartmentId = selected.departmentId;
        activePermission = scopedPermission;
        if (
          selected.toolIds.length > 0
          && !selected.toolIds.some(toolId => activePermission.allowedToolIds.has(asToolId(toolId)))
        ) {
          context.onDiscovery?.({
            query,
            outcome: 'failure',
            skillId: selected.id,
            departmentId: activeDepartmentId,
          });
          terminalFailure = {
            status: 'permission_denied',
            message:
              `You do not have access to any executable tool required by "${selected.name}". `
              + 'No tool was run. Ask a company administrator to grant the required capability.',
          };
          context.onTerminalFailure?.(terminalFailure);
          return `${terminalFailure.status}: ${terminalFailure.message}`;
        }
        selected = await context.skillCatalog.getVisible({
          companyId: context.companyId,
          departmentId: activeDepartmentId,
          permission: activePermission,
          grantedSkillIds: context.grantedSkillIds,
          skillId: selected.id,
        });
        if (!selected) {
          context.onDiscovery?.({ query, outcome: 'failure' });
          terminalFailure = {
            status: 'routing_unavailable',
            message:
              'The selected DB skill could not be loaded consistently after department access was resolved. '
              + 'Do not substitute another router or capability.',
          };
          context.onTerminalFailure?.(terminalFailure);
          return `${terminalFailure.status}: ${terminalFailure.message}`;
        }
      }

      const toolDocs = selected.toolIds.flatMap((toolId) => {
        if (!activePermission.allowedToolIds.has(asToolId(toolId))) return [];
        const tool = permittedTools.get(toolId);
        if (!tool) return [];
        return [`### ${tool.id}\n${tool.description}\n${tool.parameterDocs}`];
      });

      context.onDiscovery?.({
        query,
        outcome: 'success',
        skillId: selected.id,
        ...(activeDepartmentId ? { departmentId: activeDepartmentId } : {}),
      });
      context.onSkillLoaded?.({
        skill: selected,
        permission: activePermission,
        ...(activeDepartmentId ? { departmentId: activeDepartmentId } : {}),
      });

      let brief = '';
      if (context.workBootstrap && context.userId && selected.toolIds.length > 0) {
        try {
          brief = renderWorkBootstrapBrief(await context.workBootstrap.build({
            companyId: context.companyId,
            userId: context.userId,
            permission: activePermission,
            registryRevision: 0,
            query,
            toolIds: selected.toolIds,
          }));
        } catch {
          brief = '';
        }
      }

      return [
        `[Approved skill loaded: ${selected.name}]`,
        `## Instructions\n${selected.instructions}`,
        toolDocs.length > 0
          ? `## Permitted tools\n${toolDocs.join('\n\n')}`
          : '## Permitted tools\nNo executable tools from this skill are allowed for the current member.',
        brief,
      ].filter(Boolean).join('\n\n');
    },
  });
}
