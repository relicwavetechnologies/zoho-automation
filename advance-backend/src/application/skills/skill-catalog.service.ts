import type { SkillRepoPort, SkillRow } from '../../infrastructure/persistence/skill.repository';
import type { PermissionResult } from '../permissions/permission.types';
import type { Logger } from '../../shared/logger';
import { asToolId } from '../../shared/ids';
import {
  TOOL_FAMILY_DEFINITIONS,
  TOOL_FAMILY_IDS,
  TOOL_FAMILY_MAP,
  isCanonicalToolId,
  type ToolFamily,
} from '../../domain/tools/tool-id';
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
    abortSignal?: AbortSignal;
  }): Promise<CatalogSkillSearchResult[]> {
    input.abortSignal?.throwIfAborted();
    const result = await this.deps.repo.search({
      companyId: input.companyId,
      ...(input.departmentId ? { departmentId: input.departmentId } : {}),
      query: input.query,
      // Fetch a bounded candidate window before application-layer ranking so
      // generic terms cannot hide a stronger match that sorts later in a folder.
      limit: Math.max(input.limit * 20, 100),
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    });
    input.abortSignal?.throwIfAborted();
    if (!result.ok) {
      this.log.warn('skills.catalog.search.failed', { companyId: input.companyId, error: result.error.message });
      return [];
    }
    const query = analyzeQuery(input.query);
    return result.value
      .filter((row) => this.isVisible(row, input.permission, input.grantedSkillIds))
      .map((row) => {
        const skill = toCatalogSkill(row);
        return { skill, score: scoreSkill(skill, query) };
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
    abortSignal?: AbortSignal;
  }): Promise<CatalogSkill | null> {
    input.abortSignal?.throwIfAborted();
    const result = await this.deps.repo.findById({
      companyId: input.companyId,
      ...(input.departmentId ? { departmentId: input.departmentId } : {}),
      skillId: input.skillId,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    });
    input.abortSignal?.throwIfAborted();
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

  async registryRevision(companyId: string, abortSignal?: AbortSignal): Promise<number> {
    abortSignal?.throwIfAborted();
    const result = await this.deps.repo.registryRevision(companyId, abortSignal);
    abortSignal?.throwIfAborted();
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
   * granted and all declared tools must be executable in the current policy
   * context. A skill with no tools is an instruction-only recipe and is valid;
   * loading it does not grant any execution authority.
   */
  private isVisible(
    row: SkillRow,
    permission: PermissionResult,
    grantedSkillIds?: ReadonlySet<string>,
  ): boolean {
    if (!this.isLanguageSafe(row)) return false;
    const granted = grantedSkillIds ? grantedSkillIds.has(row.id) : true;
    const executable = row.toolIds.every((toolId) =>
      permission.allowedToolIds.has(asToolId(toolId))
    );
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

const SCORE_STOP_WORDS = new Set([
  'a', 'an', 'and', 'for', 'from', 'in', 'into', 'my', 'of', 'on', 'please',
  'return', 'the', 'then', 'to', 'using', 'with',
]);

const CONTACT_ENTITY_TOKENS = new Set([
  'address', 'colleague', 'colleagues', 'contact', 'contacts', 'coworker',
  'coworkers', 'directory', 'employee', 'employees', 'people', 'person',
  'staff', 'teammate', 'teammates',
]);
const COMPANY_PERSON_TOKENS = new Set([
  'colleague', 'colleagues', 'company', 'coworker', 'coworkers', 'directory',
  'employee', 'employees', 'internal', 'organization', 'staff', 'teammate',
  'teammates', 'work', 'workplace',
]);
const EXTERNAL_PERSON_TOKENS = new Set([
  'external', 'personal', 'private',
]);

interface AnalyzedQuery {
  readonly normalized: string;
  readonly tokens: ReadonlySet<string>;
  readonly explicitFamilies: ReadonlySet<ToolFamily>;
  readonly contactIntent: boolean;
  readonly contactSource: 'company' | 'external' | 'unspecified';
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 1 && !SCORE_STOP_WORDS.has(word));
}

function analyzeQuery(value: string): AnalyzedQuery {
  const normalized = tokenize(value).join(' ');
  const tokens = new Set(tokenize(value));
  const explicitFamilies = new Set<ToolFamily>();
  for (const familyId of TOOL_FAMILY_IDS) {
    if (TOOL_FAMILY_DEFINITIONS[familyId].routingAliases.some((alias) =>
      includesExactPhrase(normalized, tokenize(alias).join(' ')))) {
      explicitFamilies.add(familyId);
    }
  }
  const contactIntent = [...tokens].some((token) => CONTACT_ENTITY_TOKENS.has(token))
    || includesExactPhrase(normalized, 'address book');
  const external = [...tokens].some((token) => EXTERNAL_PERSON_TOKENS.has(token))
    || includesExactPhrase(normalized, 'address book');
  const company = [...tokens].some((token) => COMPANY_PERSON_TOKENS.has(token));

  return {
    normalized,
    tokens,
    explicitFamilies,
    contactIntent,
    contactSource: external ? 'external' : company ? 'company' : 'unspecified',
  };
}

function includesExactPhrase(normalizedText: string, normalizedPhrase: string): boolean {
  return ` ${normalizedText} `.includes(` ${normalizedPhrase} `);
}

function scoreSkill(skill: CatalogSkill, query: AnalyzedQuery): number {
  const identityTokens = new Set(tokenize([
    skill.id,
    skill.slug,
    skill.name,
    ...skill.toolIds,
    ...skill.tags,
  ].join(' ')));
  const aliasTokens = new Set(tokenize(skill.aliases.join(' ')));
  const descriptionTokens = new Set(tokenize(skill.description));
  const instructionTokens = new Set(tokenize(skill.instructions));

  let score = 0;
  for (const word of query.tokens) {
    if (identityTokens.has(word)) score += 5;
    else if (aliasTokens.has(word)) score += 4;
    else if (descriptionTokens.has(word)) score += 2;
    else if (instructionTokens.has(word)) score += 1;
  }

  for (const alias of skill.aliases) {
    const normalizedAlias = tokenize(alias).join(' ');
    if (normalizedAlias && includesExactPhrase(query.normalized, normalizedAlias)) score += 10;
  }

  const providerFamilies = skillProviderFamilies(skill);
  const contactSkill = skill.toolIds.some((toolId) => toolId === 'larkContacts' || toolId === 'googleContacts');
  if (query.explicitFamilies.size > 0) {
    const familyMatch = [...query.explicitFamilies].some(family => providerFamilies.has(family));
    if (familyMatch) score += 30;
    else if (providerFamilies.size > 0) score -= 15;
  }

  if (query.contactIntent && contactSkill) {
    score += 25;
    if (query.explicitFamilies.has('lark')) score += providerFamilies.has('lark') ? 20 : -20;
    else if (query.explicitFamilies.has('google')) score += providerFamilies.has('google') ? 20 : -20;
    else if (query.contactSource === 'external') score += providerFamilies.has('google') ? 20 : -10;
    else score += providerFamilies.has('lark') ? 15 : 0;
  }
  return score;
}

function skillProviderFamilies(skill: CatalogSkill): ReadonlySet<ToolFamily> {
  const families = new Set<ToolFamily>();
  for (const toolId of skill.toolIds) {
    if (!isCanonicalToolId(toolId)) continue;
    const family = TOOL_FAMILY_MAP[toolId];
    if (TOOL_FAMILY_DEFINITIONS[family].routingAliases.length > 0) families.add(family);
  }
  return families;
}
