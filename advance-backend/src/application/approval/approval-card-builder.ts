import type { ApprovalAuthority } from './approval.types';
import type { DecisionSkillEvidence } from '../../domain/decision/decision';
import { focusedSkillReviewBlocks } from '../knowledge/knowledge-review-presentation';

export interface ApprovalCardInput {
  approvalId:     string;
  toolId:         string;
  action:         string;
  args:           unknown;
  summary:        string;
  requesterName:  string;
  approverName:   string;
  authority:      ApprovalAuthority;
  departmentName: string;
  decisionEvidence?: DecisionSkillEvidence;
}

export function buildApprovalResolutionCard(
  decision: 'approved' | 'rejected',
  resolvedByName: string,
  resolvedAt: Date,
  originalRequest?: Omit<ApprovalCardInput, 'approvalId' | 'approverName'>,
): string {
  const card = buildApprovalResolutionCardData(
    decision,
    resolvedByName,
    resolvedAt,
    originalRequest,
  );

  return JSON.stringify({
    msg_type: 'interactive',
    card:     JSON.stringify(card),
  });
}

export function buildApprovalResolutionCardData(
  decision: 'approved' | 'rejected',
  resolvedByName: string,
  resolvedAt: Date,
  originalRequest?: Omit<ApprovalCardInput, 'approvalId' | 'approverName'>,
): Record<string, unknown> {
  const emoji   = decision === 'approved' ? '✅' : '❌';
  const label   = decision === 'approved' ? 'Approved' : 'Rejected';
  const timeStr = resolvedAt.toLocaleString('en-US', { timeZone: 'UTC', hour12: false });
  const presentation = originalRequest
    ? buildApprovalPresentation({
        ...originalRequest,
        approvalId: '',
        approverName: resolvedByName,
      })
    : null;

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `${emoji} ${label} by ${resolvedByName}` },
      template: decision === 'approved' ? 'green' : 'red',
    },
    elements: [
      ...(originalRequest && presentation
        ? [
            {
              tag: 'div',
              fields: [
                {
                  is_short: true,
                  text: {
                    tag: 'lark_md',
                    content: `**Requested by**\n${escapeLarkMarkdown(originalRequest.requesterName)}`,
                  },
                },
                {
                  is_short: true,
                  text: {
                    tag: 'lark_md',
                    content: `**Department**\n${escapeLarkMarkdown(originalRequest.departmentName)}`,
                  },
                },
              ],
            },
            {
              tag: 'div',
              text: {
                tag: 'lark_md',
                content: `**Request**\n${presentation.description}`,
              },
            },
            ...presentation.details.map((details, index) => ({
              tag: 'div',
              text: {
                tag: 'lark_md',
                content: index === 0 ? `**${presentation.detailsLabel}**\n${details}` : details,
              },
            })),
          ]
        : []),
      {
        tag: 'note',
        elements: [{
          tag: 'plain_text',
          content: `${label} by ${resolvedByName} at ${timeStr} UTC.`,
        }],
      },
    ],
  };
}

interface ApprovalPresentation {
  readonly title: string;
  readonly requestType: string;
  readonly actionLabel: string;
  readonly description: string;
  readonly detailsLabel: string;
  readonly details: readonly string[];
  readonly safetyNote: string;
  readonly approveLabel: string;
}

function buildApprovalPresentation(input: ApprovalCardInput): ApprovalPresentation {
  const knowledge = readGovernedKnowledgeRequest(input);
  if (knowledge?.kind === 'memory') {
    const countLabel = `${knowledge.facts.length} ${knowledge.facts.length === 1 ? 'fact' : 'facts'}`;
    const targetLabel = knowledge.scope === 'department'
      ? `${input.departmentName} department memory`
      : 'company memory';
    return {
      title: knowledge.scope === 'department'
        ? '🧠 Department memory approval'
        : '🧠 Company memory approval',
      requestType: knowledge.scope === 'department'
        ? 'Department memory update'
        : 'Company memory update',
      actionLabel: `Add ${countLabel}`,
      description: escapeLarkMarkdown(`Add ${countLabel} to ${targetLabel}.`),
      detailsLabel: 'Information to add',
      details: [knowledge.facts
        .map((fact, index) => `${index + 1}. ${escapeLarkMarkdown(fact)}`)
        .join('\n')],
      safetyNote: knowledge.scope === 'department'
        ? `Nothing has been saved yet. If approved, only these exact facts will be added to ${input.departmentName} department memory and may be recalled for members of that department.`
        : 'Nothing has been saved yet. If approved, only these exact facts will be added to company memory and may be recalled across the company.',
      approveLabel: '✅ Approve memory update',
    };
  }
  if (knowledge?.kind === 'skill') {
    const target = knowledge.scope === 'department'
      ? `${input.departmentName} department`
      : 'the company';
    return {
      title: knowledge.scope === 'department'
        ? '📘 Department procedure approval'
        : '📘 Company procedure approval',
      requestType: 'Shared procedure',
      actionLabel: 'Publish reviewed procedure',
      description: escapeLarkMarkdown(`Publish “${knowledge.name}” for ${target}.`),
      detailsLabel: 'Procedure to publish',
      details: input.decisionEvidence?.kind === 'skill'
        ? focusedSkillReviewBlocks(input.decisionEvidence)
        : ['Focused change details are unavailable for this older request. Review it in Divo before deciding.'],
      safetyNote: 'Nothing is published yet. Approval applies only to this exact reviewed version; any edit requires a new review and approval.',
      approveLabel: '✅ Approve procedure',
    };
  }
  if (knowledge?.kind === 'file') {
    const target = knowledge.scope === 'department'
      ? `${input.departmentName} department`
      : 'the company';
    return {
      title: knowledge.scope === 'department'
        ? '📎 Department file approval'
        : '📎 Company file approval',
      requestType: 'Shared file',
      actionLabel: 'Publish file visibility',
      description: escapeLarkMarkdown(`Make “${knowledge.fileName}” available to ${target}.`),
      detailsLabel: 'File',
      details: [[
        `**Name:** ${escapeLarkMarkdown(knowledge.fileName)}`,
        `**Type:** ${escapeLarkMarkdown(knowledge.mimeType)}`,
        `**Size:** ${formatBytes(knowledge.sizeBytes)}`,
      ].join('\n')],
      safetyNote: 'Approval changes access only for this exact uploaded file. It does not authorize other files or future replacements.',
      approveLabel: '✅ Approve file sharing',
    };
  }

  return {
    title: '🔐 Approval required',
    requestType: `${humanizeIdentifier(input.toolId)} request`,
    actionLabel: humanizeIdentifier(input.action),
    description: escapeLarkMarkdown(input.summary || 'Perform the requested action.'),
    detailsLabel: 'Request details',
    details: [],
    safetyNote: 'Approving permits only this exact request. Any changed or additional action requires a new approval.',
    approveLabel: '✅ Approve exact request',
  };
}

type GovernedKnowledgeRequest =
  | { readonly kind: 'memory'; readonly scope: 'department' | 'company'; readonly facts: readonly string[] }
  | { readonly kind: 'skill'; readonly scope: 'department' | 'company'; readonly name: string; readonly summary: string; readonly markdown: string }
  | { readonly kind: 'file'; readonly scope: 'department' | 'company'; readonly fileName: string; readonly mimeType: string; readonly sizeBytes: number };

function readGovernedKnowledgeRequest(
  input: Pick<ApprovalCardInput, 'toolId' | 'action' | 'args'>,
): GovernedKnowledgeRequest | null {
  if (!isRecord(input.args)) return null;
  if (input.toolId !== 'knowledge' || input.args['operation'] !== 'apply') return null;
  const scope = input.args['scope'];
  if (scope !== 'department' && scope !== 'company') return null;
  const kind = input.args['kind'];
  const content = isRecord(input.args['content']) ? input.args['content'] : {};
  if (kind === 'memory') {
    const facts = Array.isArray(content['facts'])
      ? content['facts'].filter((fact): fact is string => typeof fact === 'string' && fact.trim().length > 0)
      : [];
    return facts.length > 0 ? { kind, scope, facts } : null;
  }
  if (kind === 'skill') {
    const name = content['name'];
    const markdown = content['markdown'];
    const summary = content['summary'];
    return typeof name === 'string' && typeof markdown === 'string'
      ? { kind, scope, name, markdown, summary: typeof summary === 'string' ? summary : '' }
      : null;
  }
  if (kind === 'file') {
    const fileName = content['fileName'];
    const mimeType = content['mimeType'];
    const sizeBytes = content['sizeBytes'];
    return typeof fileName === 'string' && typeof mimeType === 'string' && typeof sizeBytes === 'number'
      ? { kind, scope, fileName, mimeType, sizeBytes }
      : null;
  }
  return null;
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}

function humanizeIdentifier(value: string): string {
  const words = value
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .trim();
  return words.length > 0
    ? words.charAt(0).toUpperCase() + words.slice(1)
    : 'Action';
}

function escapeLarkMarkdown(value: string): string {
  return value.replace(/([\\*_~`[\]])/g, '\\$1');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
