import type { Skill } from './skill.types';

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

  discover(query: string): Skill | null {
    const words = query
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 1);

    if (words.length === 0) return null;

    let bestSkill: Skill | null = null;
    let bestScore = 0;

    for (const skill of this.skills.values()) {
      const haystack = [
        skill.id,
        skill.name,
        skill.description,
        skill.instructions,
        ...skill.toolIds,
      ]
        .join(' ')
        .toLowerCase();

      let score = 0;
      for (const word of words) {
        if (haystack.includes(word)) score++;
      }

      if (score > bestScore) {
        bestScore = score;
        bestSkill = skill;
      }
    }

    return bestScore > 0 ? bestSkill : null;
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
