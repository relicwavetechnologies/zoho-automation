import type { SkillRepoPort, SkillRow } from '../../infrastructure/persistence/skill.repository';
import type { PermissionResult } from '../permissions/permission.types';
import type { Logger } from '../../shared/logger';
import { asToolId } from '../../shared/ids';
import { larkSkillCjkFields } from './lark-skill-language-policy';

export interface CatalogSkill {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly toolIds: readonly string[];
  readonly aliases: readonly string[];
  readonly tags: readonly string[];
  readonly revision: number;
}

export interface CatalogSkillSearchResult {
  readonly skill: CatalogSkill;
  readonly score: number;
}

export interface SkillCatalogServiceDeps {
  readonly repo: SkillRepoPort;
  readonly logger: Logger;
}

export class SkillCatalogService {
  private readonly log: Logger;

  constructor(private readonly deps: SkillCatalogServiceDeps) {
    this.log = deps.logger.child({ service: 'skill-catalog' });
  }

  async listVisible(input: {
    companyId: string;
    departmentId?: string;
    permission: PermissionResult;
    grantedSkillIds?: ReadonlySet<string>;
    limit?: number;
  }): Promise<CatalogSkill[]> {
    const result = await this.deps.repo.list({
      companyId: input.companyId,
      ...(input.departmentId ? { departmentId: input.departmentId } : {}),
      limit: input.limit ?? 50,
    });
    if (!result.ok) {
      this.log.warn('skills.catalog.list.failed', { companyId: input.companyId, error: result.error.message });
      return [];
    }
    return result.value
      .filter((row) => this.isVisible(row, input.permission, input.grantedSkillIds))
      .map(toCatalogSkill);
  }

  async searchVisible(input: {
    companyId: string;
    departmentId?: string;
    permission: PermissionResult;
    grantedSkillIds?: ReadonlySet<string>;
    query: string;
    limit: number;
  }): Promise<CatalogSkillSearchResult[]> {
    const result = await this.deps.repo.search({
      companyId: input.companyId,
      ...(input.departmentId ? { departmentId: input.departmentId } : {}),
      query: input.query,
      // Fetch a bounded candidate window before application-layer ranking so
      // generic terms cannot hide a stronger match that sorts later in a folder.
      limit: Math.max(input.limit * 20, 100),
    });
    if (!result.ok) {
      this.log.warn('skills.catalog.search.failed', { companyId: input.companyId, error: result.error.message });
      return [];
    }
    return result.value
      .filter((row) => this.isVisible(row, input.permission, input.grantedSkillIds))
      .map((row) => {
        const skill = toCatalogSkill(row);
        return { skill, score: scoreSkill(skill, tokenize(input.query)) };
      })
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
      .slice(0, input.limit);
  }

  async getVisible(input: {
    companyId: string;
    departmentId?: string;
    permission: PermissionResult;
    grantedSkillIds?: ReadonlySet<string>;
    skillId: string;
  }): Promise<CatalogSkill | null> {
    const result = await this.deps.repo.findById({
      companyId: input.companyId,
      ...(input.departmentId ? { departmentId: input.departmentId } : {}),
      skillId: input.skillId,
    });
    if (!result.ok) {
      this.log.warn('skills.catalog.get.failed', {
        companyId: input.companyId,
        skillId: input.skillId,
        error: result.error.message,
      });
      return null;
    }
    if (!result.value || !this.isVisible(result.value, input.permission, input.grantedSkillIds)) {
      return null;
    }
    return toCatalogSkill(result.value);
  }

  async getInScope(input: {
    companyId: string;
    departmentId?: string;
    skillId: string;
  }): Promise<CatalogSkill | null> {
    const result = await this.deps.repo.findById({
      companyId: input.companyId,
      ...(input.departmentId ? { departmentId: input.departmentId } : {}),
      skillId: input.skillId,
    });
    if (!result.ok) {
      this.log.warn('skills.catalog.get.failed', {
        companyId: input.companyId,
        skillId: input.skillId,
        error: result.error.message,
      });
      return null;
    }
    if (!result.value || !this.isLanguageSafe(result.value)) return null;
    return toCatalogSkill(result.value);
  }

  async registryRevision(companyId: string): Promise<number> {
    const result = await this.deps.repo.registryRevision(companyId);
    if (!result.ok) {
      this.log.warn('skills.catalog.registry_revision.failed', {
        companyId,
        error: result.error.message,
      });
      return 1;
    }
    return result.value;
  }

  /**
   * Agent-facing discovery has two independent gates: the skill must be
   * granted and all required tools must be executable in the current policy
   * context. Grants remain independently manageable in the admin registry,
   * but a non-executable recipe must never be presented to the runtime as a
   * usable skill.
   */
  private isVisible(
    row: SkillRow,
    permission: PermissionResult,
    grantedSkillIds?: ReadonlySet<string>,
  ): boolean {
    if (!this.isLanguageSafe(row)) return false;
    const granted = grantedSkillIds ? grantedSkillIds.has(row.id) : true;
    const executable = row.toolIds.length > 0
      && row.toolIds.every((toolId) => permission.allowedToolIds.has(asToolId(toolId)));
    return granted && executable;
  }

  private isLanguageSafe(row: SkillRow): boolean {
    const fields = larkSkillCjkFields(row);
    if (fields.length === 0) return true;
    this.log.warn('skills.catalog.lark_non_english_blocked', {
      companyId: row.companyId,
      skillId: row.id,
      fields: [...fields],
    });
    return false;
  }
}

function toCatalogSkill(row: SkillRow): CatalogSkill {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.summary,
    instructions: row.markdown,
    toolIds: [...row.toolIds],
    aliases: [...(row.aliases ?? [])],
    tags: [...row.tags],
    revision: row.revision,
  };
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9._-]+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 1);
}

function scoreSkill(skill: CatalogSkill, words: readonly string[]): number {
  const strong = [
    skill.id,
    skill.slug,
    skill.name,
    skill.description,
    ...skill.toolIds,
    ...skill.aliases,
    ...skill.tags,
  ].join(' ').toLowerCase();
  const full = `${strong} ${skill.instructions}`.toLowerCase();

  let score = 0;
  for (const word of words) {
    if (strong.includes(word)) score += 3;
    else if (full.includes(word)) score += 1;
  }
  return score;
}
