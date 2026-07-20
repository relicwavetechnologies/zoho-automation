import type { CatalogSkill } from '../skills/skill-catalog.service';
import type { PermissionResult } from '../permissions/permission.types';

const FINANCE_TOOL_PRIORITY = ['zohoBooks', 'zohoCrm', 'webSearch'] as const;
const ACTION_PRIORITY = ['read', 'create', 'update', 'delete', 'send', 'execute'] as const;
const FINANCE_SKILL_PRIORITY = [
  'finance-ops-core',
  'zoho-books-bill',
  'zoho-bill-notify-accounts',
] as const;

export interface DesktopCapabilityBootstrap {
  readonly version: 2;
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

  const routingHints: string[] = [];
  if (booksActions.has('read')) {
    routingHints.push(
      'Unpaid or overdue invoices -> invoke zohoBooks with op build_overdue_report or list_invoices.',
      'Recent customer payments -> invoke zohoBooks with op list_payments.',
      'Bills, expenses, or bank transactions -> invoke zohoBooks with op list_bills, list_expenses, list_bank_transactions, or search_transactions.',
      'Tax summary -> invoke zohoBooks with op get_tax_summary.',
    );
  }
  if (preferredToolIds.has('zohoCrm')) {
    routingHints.push('Customer, contact, account, deal, or relationship context -> use zohoCrm read operations.');
  }
  if (availableToolIds.has('webSearch')) {
    routingHints.push(
      'Ordinary current external facts, pricing, comparisons, laws, market information, or verification -> invoke webSearch directly with args { query, limit }; do not resolve or search for a research skill first. Use an exact indexed deep-research skill only when the request is explicitly thorough/deep or the persona already links it.',
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
    version: 2,
    registryRevision: input.registryRevision,
    departmentFunction: finance ? 'finance' : 'general',
    companyRole: input.companyRole,
    departmentRole: String(input.permission.department?.roleSlug ?? 'member'),
    availableSkills,
    availableTools,
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
