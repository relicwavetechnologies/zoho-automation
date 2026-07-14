import type { SkillRepoPort, SkillRow } from '../../infrastructure/persistence/skill.repository';
import type { PermissionResult } from '../permissions/permission.types';
import type { Logger } from '../../shared/logger';
import { asToolId } from '../../shared/ids';

export interface CatalogSkill {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly toolIds: readonly string[];
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
      limit: Math.max(input.limit * 3, input.limit),
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
    return result.value ? toCatalogSkill(result.value) : null;
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
   * Skill visibility gate. When `grantedSkillIds` is provided (skill-RBAC
   * enforcement is on), visibility is deny-by-default: the skill must be
   * explicitly granted to the member. Otherwise the legacy rule applies —
   * visible iff the member can use every required tool.
   */
  private isVisible(
    row: SkillRow,
    permission: PermissionResult,
    grantedSkillIds?: ReadonlySet<string>,
  ): boolean {
    if (grantedSkillIds) return grantedSkillIds.has(row.id);
    return row.toolIds.length > 0
      && row.toolIds.every((toolId) => permission.allowedToolIds.has(asToolId(toolId)));
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
  ].join(' ').toLowerCase();
  const full = `${strong} ${skill.instructions}`.toLowerCase();

  let score = 0;
  for (const word of words) {
    if (strong.includes(word)) score += 3;
    else if (full.includes(word)) score += 1;
  }
  return score;
}
