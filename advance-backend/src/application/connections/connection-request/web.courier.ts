import type { DecisionService } from '../../decision/decision.service';
import type { DecisionQuestion } from '../../../domain/decision/decision';
import { surfaceCapabilities } from '../../../domain/channel/surface-capabilities';
import type { RunContext } from '../../../domain/orchestration/run-context';
import type { ScopeGap } from '../../../domain/connections/scope-gap';
import type { ConnectAskOutcome } from './connection-request.service';

const WEB_CONNECT_DECISION_TTL_MS = 10 * 60_000;

export interface WebConnectionAskInput {
  readonly gap: ScopeGap;
  readonly runContext: RunContext;
  readonly intentId: string;
  readonly authorizeUrl: string;
}

export interface WebConnectionAskCourier {
  deliver(input: WebConnectionAskInput): Promise<ConnectAskOutcome>;
}

/** Put the Google authorization link into the decision already mounted in web chat. */
export function createWebConnectionAskCourier(deps: {
  readonly decisions: Pick<DecisionService, 'ask'>;
}): WebConnectionAskCourier {
  return {
    async deliver(input): Promise<ConnectAskOutcome> {
      const surface = surfaceCapabilities(input.runContext.channel);
      if (input.runContext.channel !== 'web' || surface.decisions !== 'form') {
        return { status: 'unreachable' };
      }

      const conversationKey = input.runContext.chatId?.trim();
      if (!conversationKey) return { status: 'unreachable' };

      const asked = await deps.decisions.ask({
        companyId: String(input.runContext.companyId),
        approver: {
          userId: String(input.runContext.userId),
          ...(input.runContext.requesterEmail
            ? { displayName: input.runContext.requesterEmail }
            : {}),
          larkOpenId: null,
        },
        requestedBy: {
          userId: String(input.runContext.userId),
          ...(input.runContext.requesterEmail
            ? { displayName: input.runContext.requesterEmail }
            : {}),
        },
        title: 'Connect Google Workspace',
        detail: detailFor(input.gap),
        source: 'Divo',
        subject: {
          brand: 'google',
          action: 'Connect Google Workspace',
          target: 'Google access',
          preview: {
            kind: 'access',
            scopes: labelsFor(input.gap),
          },
        },
        questions: [connectQuestion(input.authorizeUrl, input.gap)],
        continuation: { kind: 'none' },
        channel: 'web',
        conversationKey,
        idempotencyKey: input.intentId,
        expiresInMs: WEB_CONNECT_DECISION_TTL_MS,
      });

      if (!asked.ok) return { status: 'unreachable' };
      return asked.created
        ? { status: 'sent', intentId: input.intentId }
        : { status: 'already_pending', intentId: input.intentId };
    },
  };
}

function connectQuestion(authorizeUrl: string, gap: ScopeGap): DecisionQuestion {
  return {
    id: 'google-connection',
    ask: gap.reason === 'not_connected'
      ? 'Connect Google Workspace to continue?'
      : 'Widen Google Workspace access to continue?',
    pick: 'one',
    options: [{
      value: 'connect',
      label: 'Connect Google',
      tone: 'primary',
      href: authorizeUrl,
    }],
  };
}

function detailFor(gap: ScopeGap): string {
  return gap.reason === 'not_connected'
    ? `Divo needs ${labelsFor(gap).join(' and ')} access to continue this request.`
    : `The connected Google account needs ${labelsFor(gap).join(' and ')} access for this request.`;
}

function labelsFor(gap: ScopeGap): string[] {
  const labels = (gap.toolIds ?? [gap.toolId]).map(toolId => {
    switch (toolId) {
      case 'googleGmail': return 'Gmail';
      case 'googleDrive': return 'Google Drive';
      case 'googleSheets': return 'Google Sheets';
      case 'googleCalendar': return 'Google Calendar';
      case 'googleDocs': return 'Google Docs';
      case 'googleSlides': return 'Google Slides';
      case 'googleForms': return 'Google Forms';
      case 'googleTasks': return 'Google Tasks';
      case 'googleContacts': return 'Google Contacts';
      case 'googleChat': return 'Google Chat';
      case 'googleAppsScript': return 'Google Apps Script';
      case 'mailAutomations': return 'Gmail automation';
      default: return 'Google Workspace';
    }
  });
  return [...new Set(labels)];
}
