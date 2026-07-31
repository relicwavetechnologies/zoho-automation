export interface LarkSkillLanguageCandidate {
  readonly slug: string;
  readonly name: string;
  readonly summary: string;
  readonly markdown: string;
  readonly toolIds: readonly string[];
  readonly tags: readonly string[];
}

export type LarkSkillContentField = 'slug' | 'name' | 'summary' | 'markdown' | 'tags';

// Lark skills are injected into the agent context. CJK instructions can make
// the model switch response language, so governed Lark skills are English-only.
const CJK_SCRIPT = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}|\p{Script=Bopomofo}/u;

export function isLarkSkill(candidate: LarkSkillLanguageCandidate): boolean {
  return candidate.slug.toLowerCase().startsWith('lark-')
    || /(^|[\s_-])lark($|[\s_-])/i.test(candidate.name)
    || candidate.tags.some((tag) => tag.toLowerCase() === 'lark')
    || candidate.toolIds.some((toolId) => toolId.toLowerCase().startsWith('lark'));
}

export function larkSkillCjkFields(
  candidate: LarkSkillLanguageCandidate,
): readonly LarkSkillContentField[] {
  if (!isLarkSkill(candidate)) return [];

  const fields: LarkSkillContentField[] = [];
  if (CJK_SCRIPT.test(candidate.slug)) fields.push('slug');
  if (CJK_SCRIPT.test(candidate.name)) fields.push('name');
  if (CJK_SCRIPT.test(candidate.summary)) fields.push('summary');
  if (CJK_SCRIPT.test(candidate.markdown)) fields.push('markdown');
  if (candidate.tags.some((tag) => CJK_SCRIPT.test(tag))) fields.push('tags');
  return fields;
}

export function larkSkillEnglishOnlyError(
  candidate: LarkSkillLanguageCandidate,
): string | null {
  const fields = larkSkillCjkFields(candidate);
  if (fields.length === 0) return null;
  return `Lark skills must be stored in English. Translate these fields to English and publish again: ${fields.join(', ')}.`;
}
