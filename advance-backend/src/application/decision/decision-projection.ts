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
 * Native rows carry their questions in the payload. Everything else — the
 * manager gate's `tool_action`, the requester's `business_action` — carries a
 * tool call, and the only question anyone was ever asked about one of those was
 * yes or no. So that is what it becomes, with `describeToolAction` supplying
 * the words it already supplies to the card and the inbox.
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
import { describeToolAction } from '../approval/describe-tool-action';
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
}

export function projectDecision(row: RuntimeApprovalRow): ProjectedDecision {
  const meta = asRecord(row.metadataJson);
  const payload = asRecord(row.payloadJson);
  const native = row.kind === DECISION_ROW_KIND ? readPayload(payload) : null;
  const args = 'args' in payload ? payload['args'] : payload;
  const requesterName = readString(meta['requesterName'])
    ?? readString(meta['requesterEmail'])
    ?? row.requestedBy
    ?? 'Someone';

  const described = native ? null : describeToolAction(row.toolId, row.actionGroup, args);
  const questions = native
    ? native.questions
    : [confirmQuestion({ ask: described!.title })];

  return {
    decision: {
      id: row.id,
      title: native ? (readString(meta['title']) ?? row.summary) : described!.title,
      ...(detailOf(native, meta, described) ? { detail: detailOf(native, meta, described)! } : {}),
      source: native ? (readString(meta['source']) ?? 'Divo') : requesterName,
      questions,
      requestedAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    },
    questions,
    continuation: native
      ? native.continuation
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
  };
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
  meta: Record<string, unknown>,
  described: { readonly details: ReadonlyArray<{ label: string; value: string }> } | null,
): string | undefined {
  if (native) return readString(meta['detail']);
  const details = described?.details ?? [];
  if (details.length === 0) return undefined;
  return details.map(entry => `${entry.label}: ${entry.value}`).join('\n');
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
  if (record['kind'] === 'tell') return { kind: 'tell' };
  /* An unreadable continuation becomes "nobody is waiting" rather than a guess.
     Guessing `run` would execute a tool call nobody could name. */
  return { kind: 'none' };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
