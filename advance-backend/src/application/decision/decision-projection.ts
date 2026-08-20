/**
 * A stored row, read back as the question it is.
 *
 * Two kinds of row arrive here and both leave as a `Decision`. That is the
 * whole point of the file: the surfaces built on this module gained every
 * approval the product already had on the day they shipped, rather than after a
 * migration, because a manager approval written months ago projects into a
 * one-question decision with two options and draws in the same card as a form
 * asked this morning.
 *
 * Native rows carry their questions in the payload. Tool approvals and
 * requester confirmations carry a tool call, and the only question anyone was
 * ever asked about one of those was yes or no. Automation plans are the one
 * stored batch shape, so they get their title and preview from the immutable
 * plan payload instead of being described as a fake single tool call.
 *
 * Pure, and separate from the module that does the loading, because this is the
 * part that can be silently wrong: a projection that drops a question or
 * mislabels an option produces a card that asks the wrong thing and settles
 * anyway.
 */
import {
  confirmQuestion,
  type Decision,
  type DecisionContinuation,
  type DecisionQuestion,
} from '../../domain/decision/decision';
import { describeToolAction, type ToolActionDescription } from '../approval/describe-tool-action';
import { subjectFromToolAction } from './subject-from-tool-action';
import type { DecisionSubject } from '../../domain/decision/decision-subject';
import type { RuntimeApprovalRow } from '../../infrastructure/persistence/runtime-approval.repository';

/** The row kind a decision asked through this module is stored under. */
export const DECISION_ROW_KIND = 'decision';

/**
 * The tool id a native decision is filed against.
 *
 * `RuntimeApproval.toolId` is not nullable and every existing row means a real
 * tool by it. A decision that is not about a tool needs a value that cannot be
 * mistaken for one, rather than an empty string that reads as a missing tool.
 */
export const DECISION_TOOL_ID = 'divoDecision';

export interface DecisionPayload {
  readonly questions: readonly DecisionQuestion[];
  readonly continuation: DecisionContinuation;
}

/**
 * What a person is being asked, whoever wrote the row.
 *
 * `canAnswer` is separate from the decision itself: two people can be shown the
 * same request — the approver and the person who asked for it — and only one of
 * them may settle it. Folding that into the value would mean projecting it
 * twice per reader.
 */
export interface ProjectedDecision {
  readonly decision: Decision;
  readonly questions: readonly DecisionQuestion[];
  readonly continuation: DecisionContinuation;
  /** The stored row's kind, so settlement knows which machinery owns it. */
  readonly rowKind: string;
  readonly toolId: string;
  readonly action: string;
  readonly status: string;
  /** Who may answer. Empty when the row names nobody, which never settles. */
  readonly approverUserId: string | null;
  readonly requestedByUserId: string | null;
  /** The exact arguments, for a reader who wants to see everything. */
  readonly payload: unknown;
  /**
   * The fields the installed Desktop clients read, kept whole.
   *
   * `Decision` deliberately drops most of them — a question does not need a
   * tool id or a department to be asked. But a shipped client cannot be updated
   * in step with this repo, and the route it calls promised these. Carried here
   * so the compatibility adapter can answer in the old shape without going back
   * to the row and describing it a second time.
   */
  readonly presentation: {
    readonly description: ToolActionDescription;
    readonly requestedByName: string;
    readonly approverName: string;
    readonly departmentName: string | null;
    readonly deliveredVia: string;
  };
}

export function projectDecision(row: RuntimeApprovalRow): ProjectedDecision {
  const meta = asRecord(row.metadataJson);
  const payload = asRecord(row.payloadJson);
  const native = row.kind === DECISION_ROW_KIND ? readPayload(payload) : null;
  const automation = row.kind === 'automation_script_plan' ? readAutomationPayload(payload) : null;
  const args = 'args' in payload ? payload['args'] : payload;
  const requesterName = readString(meta['requesterName'])
    ?? readString(meta['requesterEmail'])
    ?? row.requestedBy
    ?? 'Someone';

  const described = native || automation ? null : describeToolAction(row.toolId, row.actionGroup, args);
  const questions = native
    ? native.questions
    : automation
      ? [confirmQuestion({ ask: `Approve this exact ${automation.invocationCount}-call automation plan?` })]
      : [confirmQuestion({ ask: described!.title })];
  const title = native
    ? (readString(meta['title']) ?? row.summary)
    : automation?.title ?? described!.title;
  /* A native ask declares its own subject when it has one; a tool approval has
     never declared anything, so its subject is read back out of the call it
     already stores. That is what gives every approval written before this
     existed a logo and a preview without a migration or a new producer. */
  const subject = native
    ? readSubject(meta['subject'])
    : automation
      ? undefined
      : subjectFromToolAction(row.toolId, row.actionGroup, args);

  return {
    decision: {
      id: row.id,
      title,
      ...(detailOf(native, automation, meta, described) ? { detail: detailOf(native, automation, meta, described)! } : {}),
      source: native ? (readString(meta['source']) ?? 'Divo') : requesterName,
      ...(subject ? { subject } : {}),
      questions,
      requestedAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      threadId: webThreadIdOf(meta),
    },
    questions,
    continuation: native
      ? native.continuation
      : automation
        ? { kind: 'run', toolId: row.toolId, action: row.actionGroup, argsHash: readString(meta['planHash']) ?? '' }
      /* A tool approval has always resumed by re-running the exact stored call.
         Saying so here rather than leaving it implied is what lets settlement
         switch on one field instead of reading four pieces of metadata. */
      : { kind: 'run', toolId: row.toolId, action: row.actionGroup, argsHash: readString(payload['argsHash']) ?? '' },
    rowKind: row.kind,
    toolId: row.toolId,
    action: row.actionGroup,
    status: row.status,
    approverUserId: readString(meta['resolvedManagerUserId'])
      ?? readString(meta['resolvedDecisionUserId'])
      ?? null,
    requestedByUserId: row.requestedBy,
    payload: args,
    presentation: {
      description: described ?? {
        tool: 'Divo',
        title,
        /* A native decision has no tool call to describe, so its questions are
           the detail. Written as label/value pairs because that is what the
           shape promises and what the old client lays out in rows. */
        details: questions.map(question => ({ label: 'Asks', value: question.ask })),
      },
      requestedByName: requesterName,
      approverName: readString(meta['resolvedManagerName']) ?? 'your approver',
      departmentName: readString(meta['departmentName']) ?? null,
      deliveredVia: row.channel,
    },
  };
}

/**
 * The web thread this was asked in, when it was asked in one.
 *
 * `execution.threadId` first, because that is where the answer actually is on
 * every row the product writes today. The gate stores its chat id as
 * `gateway:company:<c>:requester:<u>:thread:web_…:run:<r>` — a namespacing key
 * rather than a conversation — so a version of this that only looked at the
 * chat ids returned null for every real approval, and the thread card it feeds
 * could never appear on any thread.
 *
 * This is presentation, not authority, and must not be read as either. The
 * execution context is client-supplied and only shape-checked, so what makes it
 * safe to route on is not its provenance: it is that the surrounding query is
 * already scoped to the reader's own decisions, so the worst a forged thread id
 * can do is put one of your own requests in front of your own composer.
 *
 * Everything is still gated on the web-thread shape. A Lark approval's chat id
 * is an open-chat id and a scheduled run's is a synthetic key; treating either
 * as a thread would put an unrelated approval in front of somebody's composer,
 * which is exactly what this exists to stop. Anything unrecognised is null, and
 * a null decision simply lives on the Approvals page.
 */
const WEB_THREAD_ID = /^web_[A-Za-z0-9-]{8,64}$/;

function webThreadIdOf(meta: Record<string, unknown>): string | null {
  const execution = asRecord(meta['execution']);
  const candidates = [
    readString(execution['threadId']),
    readString(meta['conversationKey']),
    readString(meta['sourceChatId']),
    readString(meta['chatId']),
  ];
  return candidates.find((value): value is string => Boolean(value && WEB_THREAD_ID.test(value))) ?? null;
}

/**
 * The lines under the title, joined into one readable block.
 *
 * `describeToolAction` returns label/value pairs because a card lays them out
 * as rows; this surface wants a paragraph, and building it here keeps the two
 * from disagreeing about which details are worth showing.
 */
function detailOf(
  native: DecisionPayload | null,
  automation: AutomationPayloadView | null,
  meta: Record<string, unknown>,
  described: { readonly details: ReadonlyArray<{ label: string; value: string }> } | null,
): string | undefined {
  if (native) return readString(meta['detail']);
  if (automation) {
    const storedDetail = readString(meta['detail']);
    if (storedDetail) return storedDetail;
    const preview = automation.callSummaries.slice(0, 12)
      .map((call, index) => `${index + 1}. ${call}`)
      .join('\n');
    const remaining = automation.callSummaries.length - 12;
    return [
      `**What will happen**\n${automation.summary}`,
      `**Exact preflighted calls**\n${preview || 'No calls'}${remaining > 0 ? `\n… and ${remaining} more exact calls` : ''}`,
      'Approval permits only this preflighted batch. New, changed, or unplanned actions need a new approval.',
    ].join('\n\n');
  }
  const details = described?.details ?? [];
  if (details.length === 0) return undefined;
  return details.map(entry => `${entry.label}: ${entry.value}`).join('\n');
}

interface AutomationPayloadView {
  readonly title: string;
  readonly summary: string;
  readonly invocationCount: number;
  readonly callSummaries: readonly string[];
}

function readAutomationPayload(payload: Record<string, unknown>): AutomationPayloadView | null {
  const title = readString(payload['title']);
  const summary = readString(payload['summary']);
  const invocations = payload['invocations'];
  if (!title || !summary || !Array.isArray(invocations)) return null;
  const callSummaries = invocations.flatMap(entry => {
    const record = asRecord(entry);
    const callSummary = readString(record['callSummary']);
    return callSummary ? [callSummary] : [];
  });
  return {
    title,
    summary,
    invocationCount: invocations.length,
    callSummaries,
  };
}

/**
 * Read a native payload, or nothing.
 *
 * A row claiming to be a decision whose questions will not parse is treated as
 * a row that is not one — it projects as a confirm rather than as a card with
 * no buttons. Anything else means a schema change or a corrupted write leaves
 * a request nobody can answer and nobody can see.
 */
function readPayload(payload: Record<string, unknown>): DecisionPayload | null {
  const questions = payload['questions'];
  if (!Array.isArray(questions) || questions.length === 0) return null;
  const parsed = questions.filter(isQuestion);
  if (parsed.length !== questions.length) return null;
  return { questions: parsed, continuation: readContinuation(payload['continuation']) };
}

function isQuestion(value: unknown): value is DecisionQuestion {
  const question = asRecord(value);
  if (!readString(question['id']) || !readString(question['ask'])) return false;
  if ('text' in question) return asRecord(question['text']) !== null || question['text'] === undefined;
  const pick = question['pick'];
  if (pick !== 'one' && pick !== 'many') return false;
  const options = question['options'];
  if (!Array.isArray(options) || options.length === 0) return false;
  return options.every(option => {
    const entry = asRecord(option);
    return Boolean(readString(entry['value'])) && Boolean(readString(entry['label']));
  });
}

function readContinuation(value: unknown): DecisionContinuation {
  const record = asRecord(value);
  if (record['kind'] === 'run') {
    const toolId = readString(record['toolId']);
    const action = readString(record['action']);
    if (toolId && action) {
      return { kind: 'run', toolId, action, argsHash: readString(record['argsHash']) ?? '' };
    }
  }
  /* Anything else becomes "nobody is waiting" rather than a guess — including a
     row written by an earlier build carrying the removed `tell` arm. Guessing
     `run` would execute a tool call nobody could name; reading a `tell` row as
     `none` says the true thing, which is that no continuation this build can
     carry out was recorded. */
  return { kind: 'none' };
}

/**
 * A stored subject, read back only as far as it can be trusted.
 *
 * `brand` and `action` are the two fields a card cannot draw without, so a row
 * missing either yields no subject at all rather than a strip with a blank logo.
 * The preview is carried through as stored: it was written by this build's own
 * ask, and re-validating every arm of it here would be a second copy of the
 * type that drifts from the first.
 */
function readSubject(value: unknown): DecisionSubject | undefined {
  const record = asRecord(value);
  const brand = readString(record['brand']);
  const action = readString(record['action']);
  if (!brand || !action) return undefined;
  return { ...record, brand, action } as DecisionSubject;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
