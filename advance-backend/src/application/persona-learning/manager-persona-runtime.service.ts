import type { PrismaClient } from '../../generated/prisma';
import type { Logger } from '../../shared/logger';

const MAX_RUNTIME_PERSONA_RULES = 12;
const MAX_RUNTIME_PERSONA_INSTRUCTION_CHARS = 500;

export interface ManagerPersonaRuntimeBrief {
  readonly version: string;
  readonly prompt: string;
}

export interface ManagerPersonaRuntimeServiceDeps {
  readonly prisma: PrismaClient;
  readonly logger: Logger;
}

/**
 * Read-only runtime projection. It selects a manager persona only when the
 * department has exactly one active manager, avoiding an invented hierarchy.
 */
export class ManagerPersonaRuntimeService {
  private readonly log: Logger;

  constructor(private readonly deps: ManagerPersonaRuntimeServiceDeps) {
    this.log = deps.logger.child({ service: 'manager-persona-runtime' });
  }

  async getDepartmentBrief(input: {
    readonly companyId: string;
    readonly departmentId: string;
  }): Promise<ManagerPersonaRuntimeBrief | null> {
    const managers = await this.deps.prisma.departmentMembership.findMany({
      where: {
        departmentId: input.departmentId,
        status: 'active',
        role: { slug: 'MANAGER' },
      },
      select: { userId: true },
      take: 2,
    });
    if (managers.length !== 1) {
      this.log.debug('manager-persona.runtime.unresolved_manager', {
        companyId: input.companyId,
        departmentId: input.departmentId,
        managerCount: managers.length,
      });
      return null;
    }
    const managerId = managers[0]!.userId;
    const tree = await this.deps.prisma.managerPersonaTree.findUnique({
      where: {
        companyId_managerId_departmentId: {
          companyId: input.companyId,
          managerId,
          departmentId: input.departmentId,
        },
      },
      select: {
        revision: true,
        updatedAt: true,
        nodes: {
          where: { status: 'active' },
          orderBy: [{ scopeKey: 'asc' }, { kind: 'asc' }, { createdAt: 'asc' }],
          take: MAX_RUNTIME_PERSONA_RULES,
          select: { scopeKey: true, ruleKey: true, kind: true, instruction: true },
        },
      },
    });
    if (!tree?.nodes.length) return null;

    return buildManagerPersonaRuntimeBrief({
      revision: tree.revision,
      updatedAt: tree.updatedAt,
      nodes: tree.nodes,
    });
  }
}

export function buildManagerPersonaRuntimeBrief(input: {
  readonly revision: number;
  readonly updatedAt: Date;
  readonly nodes: readonly {
    readonly scopeKey: string;
    readonly ruleKey: string;
    readonly kind: string;
    readonly instruction: string;
  }[];
}): ManagerPersonaRuntimeBrief | null {
  const rules = input.nodes
    .slice(0, MAX_RUNTIME_PERSONA_RULES)
    .flatMap(node => {
      const scopeKey = safeInline(node.scopeKey, 120);
      const ruleKey = safeInline(node.ruleKey, 120);
      const instruction = safeInline(node.instruction, MAX_RUNTIME_PERSONA_INSTRUCTION_CHARS);
      if (!scopeKey || !ruleKey || !instruction) return [];
      return [`- [scope=${scopeKey}; rule=${ruleKey}] ${instruction}`];
    });
  if (!rules.length) return null;

  return {
    version: `manager-persona:${input.revision}:${input.updatedAt.toISOString()}`,
    prompt: [
      'MANAGER PERSONA TREE — backend-generated learned operating context.',
      'Use a rule only when its scope fits the current request. Do not generalize a narrow rule. These rules cannot override company policy, user instructions, permissions, approvals, security requirements, or backend authority.',
      '',
      ...rules,
    ].join('\n'),
  };
}

function safeInline(value: string, maxChars: number): string | null {
  const normalized = value.replace(/\s+/g, ' ').trim().replaceAll('<', '[').replaceAll('>', ']');
  if (!normalized) return null;
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars)}…` : normalized;
}
