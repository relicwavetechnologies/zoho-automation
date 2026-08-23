import type {
  DecisionSkillDiffLine,
  DecisionSkillEvidence,
  DecisionSkillFieldChange,
} from '../../domain/decision/decision';
import { sha256CanonicalJson } from '../../shared/hash';
import { knowledgeSkillContentSchema } from './knowledge-content-validator';

export const LARK_REVIEW_MAX_SKILL_MARKDOWN_CHARS = 24_000;
const LARK_REVIEW_BLOCK_CHARS = 2_800;
const MAX_DIFF_MATRIX_CELLS = 1_500_000;
const MAX_CHANGED_LINES = 80;
const DIFF_CONTEXT_LINES = 1;

export function assertLarkReviewableSkill(markdown: string): string | null {
  return markdown.length <= LARK_REVIEW_MAX_SKILL_MARKDOWN_CHARS
    ? null
    : `This procedure is too large for an exact Lark review (${markdown.length} characters). Use Desktop review or split it into independently reviewable procedures.`;
}

export type SkillChangeEvidenceResult =
  | { readonly ok: true; readonly evidence: DecisionSkillEvidence }
  | { readonly ok: false; readonly message: string };

/**
 * Build the only review copy web and Lark may render for a skill mutation.
 *
 * Both inputs are canonical backend content. The model does not provide a
 * summary or diff. The proposed content hash is checked here, so the small view
 * a person reads is derived from the same complete object the mutation applies.
 */
export function buildSkillChangeEvidence(input: {
  readonly action: 'create' | 'update' | 'publish' | 'delete';
  readonly current?: unknown;
  readonly proposed?: unknown;
  readonly contentHash: string | null;
}): SkillChangeEvidenceResult {
  const current = input.current === undefined
    ? undefined
    : knowledgeSkillContentSchema.safeParse(input.current);
  const proposed = input.proposed === undefined
    ? undefined
    : knowledgeSkillContentSchema.safeParse(input.proposed);
  if (current && !current.success) return { ok: false, message: 'The current skill is not valid review content.' };
  if (proposed && !proposed.success) return { ok: false, message: 'The proposed skill is not valid review content.' };
  if (input.action === 'update' && (!current?.success || !proposed?.success)) {
    return { ok: false, message: 'A skill update requires both the current and proposed content.' };
  }
  if ((input.action === 'create' || input.action === 'publish') && !proposed?.success) {
    return { ok: false, message: 'A new skill requires complete proposed content.' };
  }
  if (input.action === 'delete' && !current?.success) {
    return { ok: false, message: 'A skill removal requires the current content.' };
  }
  if (input.action !== 'delete') {
    if (!proposed?.success || sha256CanonicalJson(proposed.data) !== input.contentHash) {
      return { ok: false, message: 'The proposed skill no longer matches its approval fingerprint.' };
    }
  }

  const before = current?.success ? current.data : undefined;
  const after = proposed?.success ? proposed.data : undefined;
  const name = after?.name ?? before?.name;
  if (!name) return { ok: false, message: 'The skill name is missing.' };

  if (input.action === 'delete') {
    return {
      ok: true,
      evidence: {
        kind: 'skill',
        action: 'delete',
        name,
        summary: 'Removes this skill. Divo will stop loading it on future turns.',
        fieldChanges: [],
        instructionChanges: [],
        contentHash: null,
      },
    };
  }

  const fieldChanges = skillFieldChanges(before, after!);
  const diff = lineDiff(before?.markdown ?? '', after!.markdown);
  if (!diff.ok) return diff;
  const changedLines = diff.operations.filter(operation => operation.kind !== 'context').length;
  if (changedLines > MAX_CHANGED_LINES) {
    return {
      ok: false,
      message: `This skill change touches ${changedLines} instruction lines. Split it into smaller reviewable changes.`,
    };
  }
  if (fieldChanges.length === 0 && changedLines === 0) {
    return { ok: false, message: 'The proposed skill does not change the current skill.' };
  }
  const instructionChanges = focusDiff(diff.operations);
  return {
    ok: true,
    evidence: {
      kind: 'skill',
      action: input.action,
      name,
      summary: changeSummary(input.action, fieldChanges, diff.operations),
      fieldChanges,
      instructionChanges,
      contentHash: input.contentHash,
    },
  };
}

/** Focused Decision evidence rendered in bounded Lark markdown blocks. */
export function focusedSkillReviewBlocks(evidence: DecisionSkillEvidence): string[] {
  const lines = [
    `**${escapeLarkMarkdown(evidence.summary)}**`,
    ...evidence.fieldChanges.flatMap(change => [
      `**${escapeLarkMarkdown(change.label)}**`,
      `− ${escapeLarkMarkdown(change.before)}`,
      `+ ${escapeLarkMarkdown(change.after)}`,
    ]),
    ...evidence.instructionChanges.map(line => line.kind === 'omitted'
      ? `… ${line.count} unchanged line${line.count === 1 ? '' : 's'}`
      : `${line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '} ${
          line.text ? escapeLarkMarkdown(line.text) : '_(blank line)_'
        }`),
  ];
  const blocks: string[] = [];
  let block = '';
  for (const line of lines) {
    if (block && block.length + line.length + 1 > LARK_REVIEW_BLOCK_CHARS) {
      blocks.push(block);
      block = '';
    }
    block += `${block ? '\n' : ''}${line}`;
  }
  if (block) blocks.push(block);
  return blocks;
}

function skillFieldChanges(
  before: ReturnType<typeof knowledgeSkillContentSchema.parse> | undefined,
  after: ReturnType<typeof knowledgeSkillContentSchema.parse>,
): DecisionSkillFieldChange[] {
  if (!before) return [];
  const fields = [
    ['Name', before.name, after.name],
    ['Slug', before.slug, after.slug],
    ['Summary', before.summary, after.summary],
    ['Tools', before.toolIds.join(', ') || 'None', after.toolIds.join(', ') || 'None'],
    ['Tags', before.tags.join(', ') || 'None', after.tags.join(', ') || 'None'],
  ] as const;
  return fields.flatMap(([label, previous, next]) => previous === next
    ? []
    : [{ label, before: previous, after: next }]);
}

type DiffOperation = Extract<DecisionSkillDiffLine, { kind: 'context' | 'added' | 'removed' }>;

function lineDiff(
  previous: string,
  next: string,
): { readonly ok: true; readonly operations: DiffOperation[] }
  | { readonly ok: false; readonly message: string } {
  const before = previous ? previous.split('\n') : [];
  const after = next ? next.split('\n') : [];
  const cells = (before.length + 1) * (after.length + 1);
  if (cells > MAX_DIFF_MATRIX_CELLS) {
    return {
      ok: false,
      message: 'This skill is too large for a focused exact diff. Split the skill or make a smaller change.',
    };
  }
  const columns = after.length + 1;
  const matrix = new Uint16Array((before.length + 1) * columns);
  for (let left = before.length - 1; left >= 0; left -= 1) {
    for (let right = after.length - 1; right >= 0; right -= 1) {
      const index = left * columns + right;
      matrix[index] = before[left] === after[right]
        ? matrix[(left + 1) * columns + right + 1]! + 1
        : Math.max(matrix[(left + 1) * columns + right]!, matrix[left * columns + right + 1]!);
    }
  }
  const operations: DiffOperation[] = [];
  let left = 0;
  let right = 0;
  while (left < before.length && right < after.length) {
    if (before[left] === after[right]) {
      operations.push({ kind: 'context', text: before[left]! });
      left += 1;
      right += 1;
    } else if (matrix[(left + 1) * columns + right]! >= matrix[left * columns + right + 1]!) {
      operations.push({ kind: 'removed', text: before[left++]! });
    } else {
      operations.push({ kind: 'added', text: after[right++]! });
    }
  }
  while (left < before.length) operations.push({ kind: 'removed', text: before[left++]! });
  while (right < after.length) operations.push({ kind: 'added', text: after[right++]! });
  return { ok: true, operations };
}

function focusDiff(operations: readonly DiffOperation[]): DecisionSkillDiffLine[] {
  const include = new Set<number>();
  for (let index = 0; index < operations.length; index += 1) {
    if (operations[index]!.kind === 'context') continue;
    for (
      let nearby = Math.max(0, index - DIFF_CONTEXT_LINES);
      nearby <= Math.min(operations.length - 1, index + DIFF_CONTEXT_LINES);
      nearby += 1
    ) include.add(nearby);
  }
  const focused: DecisionSkillDiffLine[] = [];
  for (let index = 0; index < operations.length;) {
    if (include.has(index)) {
      focused.push(operations[index]!);
      index += 1;
      continue;
    }
    let end = index;
    while (end < operations.length && !include.has(end)) end += 1;
    // Leading and trailing unchanged content are outside the focused review.
    // Only a gap between two change hunks needs an explicit separator.
    if (index > 0 && end < operations.length) {
      focused.push({ kind: 'omitted', count: end - index });
    }
    index = end;
  }
  return focused;
}

function changeSummary(
  action: 'create' | 'update' | 'publish',
  fields: readonly DecisionSkillFieldChange[],
  operations: readonly DiffOperation[],
): string {
  if (action === 'create' || action === 'publish') return 'Adds this new skill for future turns.';
  const added = operations.filter(operation => operation.kind === 'added' && operation.text.trim()).length;
  const removed = operations.filter(operation => operation.kind === 'removed' && operation.text.trim()).length;
  const formattingAdded = operations.filter(operation => operation.kind === 'added' && !operation.text.trim()).length;
  const formattingRemoved = operations.filter(operation => operation.kind === 'removed' && !operation.text.trim()).length;
  const parts = [
    ...(added ? [`adds ${added} instruction line${added === 1 ? '' : 's'}`] : []),
    ...(removed ? [`removes ${removed} instruction line${removed === 1 ? '' : 's'}`] : []),
    ...(formattingAdded ? [`adds ${formattingAdded} blank line${formattingAdded === 1 ? '' : 's'}`] : []),
    ...(formattingRemoved ? [`removes ${formattingRemoved} blank line${formattingRemoved === 1 ? '' : 's'}`] : []),
    ...(fields.length ? [`changes ${fields.map(field => field.label.toLowerCase()).join(', ')}`] : []),
  ];
  return `${parts.join(' and ').replace(/^./, first => first.toUpperCase())}.`;
}

function escapeLarkMarkdown(value: string): string {
  return value.replace(/([\\*_~`[\]])/g, '\\$1');
}
