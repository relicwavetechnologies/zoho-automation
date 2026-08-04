import { createHash } from 'node:crypto';

export const LARK_REVIEW_MAX_SKILL_MARKDOWN_CHARS = 24_000;
const LARK_REVIEW_BLOCK_CHARS = 2_800;

export function assertLarkReviewableSkill(markdown: string): string | null {
  return markdown.length <= LARK_REVIEW_MAX_SKILL_MARKDOWN_CHARS
    ? null
    : `This procedure is too large for an exact Lark review (${markdown.length} characters). Use Desktop review or split it into independently reviewable procedures.`;
}

/** Every returned string fits one Lark markdown element; no content is omitted. */
export function exactSkillReviewBlocks(input: {
  readonly name: string;
  readonly summary: string;
  readonly markdown: string;
}): string[] {
  const error = assertLarkReviewableSkill(input.markdown);
  if (error) throw new Error(error);
  const digest = createHash('sha256').update(input.markdown, 'utf8').digest('hex');
  const prefix = [
    `**Procedure:** ${escapeLarkMarkdown(input.name)}`,
    ...(input.summary ? [`**Summary:** ${escapeLarkMarkdown(input.summary)}`] : []),
    `**Exact content fingerprint (SHA-256):** \`${digest}\``,
    `**Complete procedure (${input.markdown.length} characters):**`,
  ].join('\n');
  const chunks: string[] = [];
  for (let offset = 0; offset < input.markdown.length; offset += LARK_REVIEW_BLOCK_CHARS) {
    chunks.push(input.markdown.slice(offset, offset + LARK_REVIEW_BLOCK_CHARS));
  }
  return [prefix, ...(chunks.length > 0 ? chunks : ['_(empty)_'])];
}

function escapeLarkMarkdown(value: string): string {
  return value.replace(/([\\*_~`[\]])/g, '\\$1');
}
