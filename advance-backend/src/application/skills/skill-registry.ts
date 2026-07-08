import type { Skill } from './skill.types';

export interface SkillSearchResult {
  readonly skill: Skill;
  readonly score: number;
}

export class SkillRegistry {
  private readonly skills: ReadonlyMap<string, Skill>;

  constructor(skills: readonly Skill[]) {
    const map = new Map<string, Skill>();
    for (const skill of skills) {
      map.set(skill.id, skill);
    }
    this.skills = map;
  }

  catalog(): string {
    const lines = Array.from(this.skills.values()).map(
      (s) => `• ${s.id} — ${s.description}`,
    );
    return `Available skills:\n${lines.join('\n')}`;
  }

  search(query: string, opts: { limit?: number; skills?: readonly Skill[] } = {}): SkillSearchResult[] {
    const words = tokenize(query);
    if (words.length === 0) return [];

    const candidates = opts.skills ?? Array.from(this.skills.values());
    const results = candidates
      .map((skill) => ({ skill, score: scoreSkill(skill, words) }))
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));

    return results.slice(0, opts.limit ?? 5);
  }

  discover(query: string): Skill | null {
    return this.search(query, { limit: 1 })[0]?.skill ?? null;
  }

  getById(id: string): Skill | null {
    return this.skills.get(id) ?? null;
  }

  all(): readonly Skill[] {
    return Array.from(this.skills.values());
  }

  allToolIds(): readonly string[] {
    const ids: string[] = [];
    for (const skill of this.skills.values()) {
      ids.push(...skill.toolIds);
    }
    return ids;
  }
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9._-]+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 1);
}

function scoreSkill(skill: Skill, words: readonly string[]): number {
  const strong = [
    skill.id,
    skill.name,
    skill.description,
    ...skill.toolIds,
  ].join(' ').toLowerCase();
  const full = `${strong} ${skill.instructions}`.toLowerCase();

  let score = 0;
  for (const word of words) {
    if (strong.includes(word)) score += 3;
    else if (full.includes(word)) score += 1;
  }

  return score;
}
