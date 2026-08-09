import type { Logger } from '../../shared/logger';
import type { InfraError } from '../../shared/errors';
import { ok, type Result } from '../../shared/result';
import type { MailOpsRepository } from '../../infrastructure/persistence/mail-ops.repository';
import { hasGoogleScopeGroups } from '../../domain/google/google-workspace-scope';
import { googleScopeGroupsForToolIds } from '../google/google-scope-request';
import { DEFAULT_MAIL_BRIEF_SCHEDULE } from './mail-brief.schedule';

export interface MailBriefOnboardingInput {
  companyId: string;
  userId: string;
  connectionId: string;
  mailboxEmail: string;
}

export interface MailBriefOnboardingResult {
  subscriptionId: string;
  briefId: string;
  mailboxCreated: boolean;
  briefCreated: boolean;
  firstBriefQueued: boolean;
}

export const MAIL_BRIEF_GOOGLE_TOOL_ID = 'mailAutomations';

const MAIL_BRIEF_GOOGLE_SCOPE_GROUPS = googleScopeGroupsForToolIds([MAIL_BRIEF_GOOGLE_TOOL_ID]);

export function canStartMailBriefFromGoogleScopes(scopes: readonly string[]): boolean {
  return hasGoogleScopeGroups(scopes, MAIL_BRIEF_GOOGLE_SCOPE_GROUPS);
}

export function canStartMailBriefFromGoogleAuthorization(input: {
  requestedToolIds: readonly string[];
  grantedScopes: readonly string[];
}): boolean {
  return input.requestedToolIds.includes(MAIL_BRIEF_GOOGLE_TOOL_ID)
    && canStartMailBriefFromGoogleScopes(input.grantedScopes);
}

export function createMailBriefOnboarding(deps: {
  repo: Pick<MailOpsRepository, 'ensureMailboxForConnection' | 'ensureBrief' | 'scheduleBriefNow'>;
  wakeMailOps: () => void;
  logger: Logger;
  now?: () => Date;
}) {
  const log = deps.logger.child({ service: 'mail-brief-onboarding' });
  const now = () => deps.now?.() ?? new Date();

  return async function startMailBriefForGoogleConnection(
    input: MailBriefOnboardingInput,
  ): Promise<Result<MailBriefOnboardingResult, InfraError>> {
    const dueAt = now();
    const mailbox = await deps.repo.ensureMailboxForConnection({
      ...input,
      now: dueAt,
    });
    if (!mailbox.ok) return mailbox;

    const brief = await deps.repo.ensureBrief({
      companyId: input.companyId,
      userId: input.userId,
      subscriptionId: mailbox.value.subscriptionId,
      ...DEFAULT_MAIL_BRIEF_SCHEDULE,
      nextRunAt: dueAt,
    });
    if (!brief.ok) return brief;

    const scheduled = await deps.repo.scheduleBriefNow({
      briefId: brief.value.briefId,
      now: dueAt,
    });
    if (!scheduled.ok) return scheduled;

    deps.wakeMailOps();
    log.info('mail_brief.onboarding_started', {
      userId: input.userId,
      connectionId: input.connectionId,
      subscriptionId: mailbox.value.subscriptionId,
      briefId: brief.value.briefId,
      mailboxCreated: mailbox.value.created,
      briefCreated: brief.value.created,
      firstBriefQueued: scheduled.value,
    });

    return ok({
      subscriptionId: mailbox.value.subscriptionId,
      briefId: brief.value.briefId,
      mailboxCreated: mailbox.value.created,
      briefCreated: brief.value.created,
      firstBriefQueued: scheduled.value,
    });
  };
}
