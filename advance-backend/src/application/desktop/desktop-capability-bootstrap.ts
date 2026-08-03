import type { CatalogSkill } from '../skills/skill-catalog.service';
import type { PermissionResult } from '../permissions/permission.types';
import { GOVERNED_LOCAL_WORKFLOW_CRITERION } from '../skills/governed-local-routing';
import {
  TOOL_FAMILY_DEFINITIONS,
  TOOL_FAMILY_IDS,
  TOOL_FAMILY_MAP,
  isCanonicalToolId,
} from '../../domain/tools/tool-id';
import { toolLabel } from '../../domain/tools/tool-labels';

const FINANCE_TOOL_PRIORITY = ['zohoBooks', 'zohoCrm', 'webSearch'] as const;
const ACTION_PRIORITY = ['read', 'create', 'update', 'delete', 'send', 'execute'] as const;
const FINANCE_SKILL_PRIORITY = [
  'finance-ops-core',
  'zoho-books-bill',
  'zoho-bill-notify-accounts',
] as const;

export interface DesktopCapabilityBootstrap {
  readonly version: 3;
  readonly registryRevision: number;
  readonly departmentFunction: 'finance' | 'general';
  readonly companyRole: string;
  readonly departmentRole: string;
  readonly availableSkills: readonly {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
    readonly description: string;
    readonly revision: number;
  }[];
  readonly availableTools: readonly {
    readonly toolId: string;
    readonly actions: readonly string[];
  }[];
  readonly families: readonly {
    readonly familyId: string;
    readonly displayName: string;
    readonly connectionMode: 'member_selectable' | 'backend_managed' | 'none';
    readonly connectionProvider?: string;
    readonly skillMode: 'none' | 'optional' | 'required';
    readonly tools: readonly {
      readonly toolId: string;
      readonly displayName: string;
      readonly description: string;
      readonly actions: readonly string[];
    }[];
    readonly skills: readonly {
      readonly skillId: string;
      readonly name: string;
      readonly mode: 'none' | 'optional' | 'required';
    }[];
  }[];
  readonly preferredSkills: readonly {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
    readonly description: string;
  }[];
  readonly preferredTools: readonly {
    readonly toolId: string;
    readonly actions: readonly string[];
  }[];
  readonly routingHints: readonly string[];
  readonly zohoConnection?: {
    readonly accessibleCount: number;
    readonly connectionId?: string;
    readonly label?: string;
    readonly access?: string;
  };
}

export interface DesktopCapabilityConnection {
  readonly connectionId: string;
  readonly label: string;
  readonly access: string;
}

export function buildDesktopCapabilityBootstrap(input: {
  readonly departmentName: string;
  readonly departmentSlug: string;
  readonly companyRole: string;
  readonly permission: PermissionResult;
  readonly visibleSkills: readonly CatalogSkill[];
  readonly registryRevision: number;
  readonly zohoConnections?: readonly DesktopCapabilityConnection[];
}): DesktopCapabilityBootstrap {
  const finance = isFinanceDepartment(input.departmentName, input.departmentSlug);

  const availableTools = [...input.permission.allowedToolIds]
    .map(toolId => ({
      toolId: String(toolId),
      actions: ACTION_PRIORITY.filter(action =>
        input.permission.allowedActionsByTool.get(toolId)?.has(action)
      ),
    }))
    .filter(tool => tool.actions.length > 0)
    .sort((left, right) => left.toolId.localeCompare(right.toolId));

  const availableSkills = input.visibleSkills
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, 50)
    .map(skill => ({
      id: skill.id,
      slug: skill.slug,
      name: skill.name,
      description: skill.description,
      revision: skill.revision,
    }));

  const families = TOOL_FAMILY_IDS.flatMap((familyId) => {
    const tools = availableTools.flatMap((tool) => {
      if (!isCanonicalToolId(tool.toolId) || TOOL_FAMILY_MAP[tool.toolId] !== familyId) return [];
      const label = toolLabel(tool.toolId);
      return [{
        ...tool,
        displayName: label.name,
        description: `Use ${label.name} for governed access to ${label.noun}.`,
      }];
    });
    if (tools.length === 0) return [];

    const familyToolIds = new Set(tools.map(tool => tool.toolId));
    const definition = TOOL_FAMILY_DEFINITIONS[familyId];
    const skills = input.visibleSkills
      .filter(skill => skill.toolIds.some(toolId => familyToolIds.has(toolId)))
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, 8)
      .map(skill => ({
        skillId: skill.id,
        name: skill.name,
        mode: definition.skillMode,
      }));

    return [{
      familyId,
      displayName: definition.displayName,
      connectionMode: definition.connectionMode,
      ...(definition.connectionProvider
        ? { connectionProvider: definition.connectionProvider }
        : {}),
      skillMode: definition.skillMode,
      tools,
      skills,
    }];
  });

  const preferredTools = finance ? FINANCE_TOOL_PRIORITY.flatMap((toolId) => {
    const actions = input.permission.allowedActionsByTool.get(toolId as never);
    if (!actions?.size) return [];
    return [{
      toolId,
      actions: ACTION_PRIORITY.filter(action => actions.has(action)),
    }];
  }) : [];
  const availableToolIds = new Set<string>(availableTools.map(tool => tool.toolId));
  const preferredToolIds = new Set<string>(preferredTools.map(tool => tool.toolId));
  const booksActions = new Set(
    preferredTools.find(tool => tool.toolId === 'zohoBooks')?.actions ?? [],
  );

  const skillPriority = new Map<string, number>(
    FINANCE_SKILL_PRIORITY.map((slug, index) => [slug, index]),
  );
  const preferredSkills = finance ? input.visibleSkills
    .filter(skill => {
      if (!skill.toolIds.some(toolId => preferredToolIds.has(toolId))) return false;
      if (skill.slug === 'zoho-books-bill') return booksActions.has('create');
      if (skill.slug === 'zoho-bill-notify-accounts') {
        return booksActions.has('create')
          && input.permission.allowedToolIds.has('larkMessaging' as never);
      }
      return true;
    })
    .sort((left, right) =>
      (skillPriority.get(left.slug) ?? Number.MAX_SAFE_INTEGER)
      - (skillPriority.get(right.slug) ?? Number.MAX_SAFE_INTEGER)
      || left.name.localeCompare(right.name))
    .slice(0, 4)
    .map(skill => ({
      id: skill.id,
      slug: skill.slug,
      name: skill.name,
      description: skill.description,
    })) : [];
  const localWorkflowSkill = input.visibleSkills.find(skill => skill.slug === 'divo-python-automation');
  if (localWorkflowSkill && !preferredSkills.some(skill => skill.id === localWorkflowSkill.id)) {
    preferredSkills.push({
      id: localWorkflowSkill.id,
      slug: localWorkflowSkill.slug,
      name: localWorkflowSkill.name,
      description: localWorkflowSkill.description,
    });
  }

  /**
   * The skill that declares a tool, which is what makes the tool invocable.
   *
   * A routing hint must say which skill to load, never "invoke X directly":
   * the gateway refuses any tools.invoke whose tool was not registered by a
   * divo_skill_view load in the same run, so a hint that skips loading sends
   * the model into a guaranteed refusal.
   */
  const skillForTool = (toolId: string) =>
    input.visibleSkills.find(skill => skill.toolIds.includes(toolId));

  /** Prefixes the mechanics with the load step, or omits them if no skill declares the tool. */
  const viaSkill = (toolId: string, route: string, mechanics: string): string | null => {
    const skill = skillForTool(toolId);
    if (!skill) return null;
    return `${route} -> load ${skill.id} with divo_skill_view, then ${mechanics}`;
  };

  const routingHints: string[] = [];
  if (booksActions.has('read')) {
    routingHints.push(
      ...[
        viaSkill('zohoBooks', 'Unpaid or overdue invoices', 'invoke zohoBooks with op build_overdue_report or list_invoices.'),
        viaSkill('zohoBooks', 'Recent customer payments', 'invoke zohoBooks with op list_payments.'),
        viaSkill('zohoBooks', 'Bills, expenses, or bank transactions', 'invoke zohoBooks with op list_bills, list_expenses, list_bank_transactions, or search_transactions.'),
        viaSkill('zohoBooks', 'Tax summary', 'invoke zohoBooks with op get_tax_summary.'),
      ].filter((hint): hint is string => hint !== null),
    );
  }
  if (preferredToolIds.has('zohoCrm')) {
    routingHints.push('Customer, contact, account, deal, or relationship context -> use zohoCrm read operations.');
  }
  if (availableToolIds.has('webSearch')) {
    const webHint = viaSkill(
      'webSearch',
      'Ordinary current external facts, pricing, comparisons, laws, market information, or verification',
      'invoke webSearch with args { query, limit }. Reserve an exact indexed deep-research skill for requests that are explicitly thorough or deep, or that the persona already links.',
    );
    if (webHint) routingHints.push(webHint);
  }
  if (availableToolIds.has('menhoodData')) {
    const menhoodHint = viaSkill(
      'menhoodData',
      'Menhood orders, customers, products, delivered sales, RTO, COD, campaign, or pincode analysis',
      'invoke menhoodData. Do not use Airtable Records or reuse an Airtable/Python checkpoint.',
    );
    if (menhoodHint) routingHints.push(menhoodHint);
  }
  if (localWorkflowSkill) {
    routingHints.push(
      `Work with ${GOVERNED_LOCAL_WORKFLOW_CRITERION} (for example Gmail/CRM → Sheets) -> call the unified Divo work resolver once with the user's complete original request, plus at most one source-oriented and one destination-oriented intent-preserving variant. Do not fetch ${localWorkflowSkill.name} by itself: the resolver must load that recipe together with the relevant source/destination recipes, exact governed tool contracts, and accessible accounts. Then use one persistent Python file and credential-free divo-local, not model-carried records or direct provider access.`,
    );
  }

  for (const specialistSlug of ['zoho-books-bill', 'zoho-bill-notify-accounts']) {
    const skill = preferredSkills.find(candidate => candidate.slug === specialistSlug);
    if (!skill) continue;
    routingHints.push(
      `${skill.description} -> fetch and follow skillId ${skill.id} directly; resolver discovery is unnecessary.`,
    );
  }

  const connections = finance ? input.zohoConnections : undefined;
  const soleConnection = connections?.length === 1 ? connections[0] : undefined;

  return {
    version: 3,
    registryRevision: input.registryRevision,
    departmentFunction: finance ? 'finance' : 'general',
    companyRole: input.companyRole,
    departmentRole: String(input.permission.department?.roleSlug ?? 'member'),
    availableSkills,
    availableTools,
    families,
    preferredSkills,
    preferredTools,
    routingHints,
    ...(connections ? {
      zohoConnection: {
        accessibleCount: connections.length,
        ...(soleConnection ? {
          connectionId: soleConnection.connectionId,
          label: soleConnection.label,
          access: soleConnection.access,
        } : {}),
      },
    } : {}),
  };
}

export function isFinanceDepartment(name: string, slug: string): boolean {
  const normalized = `${name} ${slug}`.toLowerCase();
  return /\b(finance|financial|accounting|accounts|treasury)\b/.test(normalized);
}
