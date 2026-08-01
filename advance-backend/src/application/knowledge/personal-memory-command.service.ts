import { asCompanyId, asToolId, asUserId } from '../../shared/ids';
import { asCompanyRoleSlug } from '../../domain/permissions/company-role';
import type { ChannelKey } from '../../domain/channel/incoming-message';
import type { PermissionService } from '../permissions/permission.service';
import type { KnowledgeMutationService } from './knowledge-mutation.service';
import { KnowledgeMutationError } from './knowledge-mutation.errors';
import type { KnowledgeProjectionService } from './knowledge-projection.service';
import type { KnowledgeResourceQueryService } from './knowledge-resource-query.service';
import { knowledgeMemoryContentSchema } from './knowledge-content-validator';

export type PersonalMemoryCommand =
  | {
      readonly action: 'set';
      readonly subject: string;
      readonly logicalKey: string;
      readonly facts: readonly string[];
    }
  | {
      readonly action: 'delete';
      readonly subject: string;
      readonly logicalKey: string;
    };

export interface PersonalMemoryCommandResult {
  readonly action: 'created' | 'updated' | 'unchanged' | 'deleted';
  readonly logicalKey: string;
  readonly resourceId: string;
  readonly version: number;
  readonly projection: 'completed' | 'queued';
}

const MIN_SUBJECT_TERM_COVERAGE = 0.6;
const MIN_UNIQUE_MATCH_SCORE_RATIO = 1.5;

/**
 * Synchronous, explicit personal-memory command path.
 *
 * This is intentionally separate from the asynchronous conversation learner:
 * an explicit user command receives an authoritative result in the same run,
 * while implicit observations remain advisory background learning. Scope is
 * fixed to the authenticated user and every write still passes live RBAC,
 * policy, optimistic versioning, canonical validation, and projection.
 */
export class PersonalMemoryCommandService {
  constructor(private readonly deps: {
    readonly permissions: Pick<PermissionService, 'canInvoke'>;
    readonly resources: Pick<
      KnowledgeResourceQueryService,
      'getPersonalMemoryByLogicalKey' | 'searchMemories'
    >;
    readonly mutations: KnowledgeMutationService;
    readonly projections: KnowledgeProjectionService;
  }) {}

  async execute(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly companyRole: string;
    readonly channel: ChannelKey;
    readonly command: PersonalMemoryCommand;
    readonly sourceRef?: string;
    readonly sourceType?: 'user_explicit' | 'automatic_learning';
    readonly evidence?: unknown;
    readonly requireExisting?: boolean;
  }): Promise<PersonalMemoryCommandResult> {
    const exact = await this.deps.resources.getPersonalMemoryByLogicalKey({
      companyId: input.companyId,
      userId: input.userId,
      logicalKey: input.command.logicalKey,
    });
    const current = exact ?? await this.resolveBySubject({
      companyId: input.companyId,
      userId: input.userId,
      subject: input.command.subject,
    });

    if (input.requireExisting && !current) {
      throw new KnowledgeMutationError('not_found', 'That personal memory does not exist.');
    }

    if (input.command.action === 'delete' && !current) {
      throw new KnowledgeMutationError('not_found', 'That personal memory does not exist.');
    }

    const facts = input.command.action === 'set'
      ? normalizeFacts(input.command.facts)
      : undefined;
    if (input.command.action === 'set' && facts?.length === 0) {
      throw new KnowledgeMutationError('invalid_request', 'Personal memory requires at least one fact.');
    }

    if (current && facts && sameFacts(current.content, facts)) {
      return {
        action: 'unchanged',
        logicalKey: current.logicalKey,
        resourceId: current.resourceId,
        version: current.currentVersion,
        projection: 'completed',
      };
    }

    const mutationAction = input.command.action === 'delete'
      ? 'delete'
      : current ? 'update' : 'create';
    const logicalKey = current?.logicalKey ?? input.command.logicalKey;
    const allowed = await this.deps.permissions.canInvoke({
      companyId: asCompanyId(input.companyId),
      userId: asUserId(input.userId),
      companyRole: asCompanyRoleSlug(input.companyRole),
      channel: input.channel,
    }, {
      toolId: asToolId('knowledge'),
      action: mutationAction,
    });
    if (!allowed.ok) {
      throw new KnowledgeMutationError('permission_denied', allowed.error.message, allowed.error);
    }

    const mutation = await this.deps.mutations.propose({
      target: {
        scope: 'personal',
        companyId: asCompanyId(input.companyId),
        userId: asUserId(input.userId),
      },
      requester: { companyId: input.companyId, userId: input.userId },
      kind: 'memory',
      logicalKey,
      action: mutationAction,
      ...(current ? { baseVersion: current.currentVersion } : {}),
      ...(facts ? { content: { facts } } : {}),
      ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
      sourceType: input.sourceType ?? 'user_explicit',
      ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
    });
    if (mutation.status !== 'approved' && mutation.status !== 'applied') {
      throw new KnowledgeMutationError(
        'policy_invalid',
        'Explicit personal memory must not enter a human-review state.',
      );
    }

    const applied = await this.deps.mutations.apply({
      mutationId: mutation.id,
      companyId: mutation.companyId,
    });
    let projection: PersonalMemoryCommandResult['projection'] = 'completed';
    try {
      await this.deps.projections.projectMutation(mutation.id);
    } catch {
      projection = 'queued';
    }

    return {
      action: input.command.action === 'delete'
        ? 'deleted'
        : current ? 'updated' : 'created',
      logicalKey,
      resourceId: applied.resourceId,
      version: applied.version,
      projection,
    };
  }

  private async resolveBySubject(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly subject: string;
  }) {
    const subject = input.subject.replaceAll('\u0000', '').normalize('NFKC').trim().slice(0, 500);
    if (!subject) {
      throw new KnowledgeMutationError('invalid_request', 'Personal memory requires a clear subject.');
    }
    const matches = await this.deps.resources.searchMemories({
      companyId: input.companyId,
      userId: input.userId,
      query: subject,
      scope: 'personal',
      limit: 3,
    });
    const best = matches[0];
    if (!best || best.coverage < MIN_SUBJECT_TERM_COVERAGE) return null;
    const runnerUp = matches[1];
    if (runnerUp && best.score < runnerUp.score * MIN_UNIQUE_MATCH_SCORE_RATIO) {
      throw new KnowledgeMutationError(
        'conflict',
        'More than one personal memory matches that subject. Clarify the exact topic before changing it.',
      );
    }
    return best.resource;
  }
}

function normalizeFacts(facts: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of facts) {
    const fact = raw.replaceAll('\u0000', '').trim().slice(0, 500);
    const key = fact.normalize('NFKC').replace(/\s+/g, ' ').toLocaleLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(fact);
  }
  return result.slice(0, 100);
}

function sameFacts(content: unknown, facts: readonly string[]): boolean {
  const parsed = knowledgeMemoryContentSchema.safeParse(content);
  if (!parsed.success) return false;
  return JSON.stringify(normalizeFacts(parsed.data.facts)) === JSON.stringify(facts);
}
