import type { SkillPort, SkillRecord } from './context-search.ports';
import type { SkillRepoPort } from '../../infrastructure/persistence/skill.repository';
import type { Logger } from '../../shared/logger';

export interface SkillsServiceDeps {
  repo:   SkillRepoPort;
  logger: Logger;
}

export class SkillsService implements SkillPort {
  private readonly log: Logger;

  constructor(private readonly deps: SkillsServiceDeps) {
    this.log = deps.logger.child({ service: 'skills' });
  }

  async search(input: {
    companyId: string;
    departmentId?: string;
    query: string;
    limit: number;
  }): Promise<SkillRecord[]> {
    const result = await this.deps.repo.search(input);
    if (!result.ok) {
      this.log.warn('skills.search.failed', { error: result.error.message, companyId: input.companyId });
      return [];
    }
    return result.value.map(row => ({
      id:      row.id,
      slug:    row.slug,
      name:    row.name,
      summary: row.summary,
      markdown: row.markdown,
    }));
  }

  async readById(input: {
    companyId: string;
    departmentId?: string;
    skillId: string;
  }): Promise<SkillRecord | null> {
    const result = await this.deps.repo.findById(input);
    if (!result.ok) {
      this.log.warn('skills.readById.failed', { error: result.error.message, skillId: input.skillId });
      return null;
    }
    if (!result.value) return null;
    const row = result.value;
    return {
      id:      row.id,
      slug:    row.slug,
      name:    row.name,
      summary: row.summary,
      markdown: row.markdown,
    };
  }
}
