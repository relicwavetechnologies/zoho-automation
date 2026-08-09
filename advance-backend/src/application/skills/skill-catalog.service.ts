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
  readonly departmentId?: string;
  readonly revision: number;
}

export interface CatalogSkillSearchResult {
  readonly skill: CatalogSkill;
  readonly score: number;
}

export interface RouterSkillCandidate {
  readonly skillId: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly departmentId?: string;
  readonly providerFamilies: readonly ToolFamily[];
  readonly score: number;
  readonly matchedTerms: readonly string[];
}

export interface SkillCatalogServiceDeps {
  readonly repo: SkillRepoPort;
  readonly logger: Logger;
}

export const GOVERNED_ROUTER_CANDIDATE_LIMIT = 12;

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
    includeGrantedDepartments?: boolean;
    limit?: number;
  }): Promise<CatalogSkill[]> {
    const result = await this.deps.repo.list({
      companyId: input.companyId,
      ...(input.departmentId ? { departmentId: input.departmentId } : {}),
      ...(input.includeGrantedDepartments && input.grantedSkillIds
        ? { additionalDepartmentSkillIds: [...input.grantedSkillIds] }
        : {}),
      limit: input.limit ?? 50,
    });
    if (!result.ok) {
      this.log.warn('skills.catalog.list.failed', { companyId: input.companyId, error: result.error.message });
      return [];
    }
    const visibleRows = await this.filterVisibleRows({
      companyId: input.companyId,
      ...(input.departmentId ? { departmentId: input.departmentId } : {}),
      permission: input.permission,
      ...(input.grantedSkillIds ? { grantedSkillIds: input.grantedSkillIds } : {}),
      ...(input.includeGrantedDepartments ? { includeGrantedDepartments: input.includeGrantedDepartments } : {}),
      rows: result.value,
    });
    return visibleRows.map(toCatalogSkill);
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
      ...(input.grantedSkillIds
        ? { additionalGrantedSkillIds: [...input.grantedSkillIds] }
        : {}),
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
    const visibleRows = await this.filterVisibleRows({
      companyId: input.companyId,
      ...(input.departmentId ? { departmentId: input.departmentId } : {}),
      permission: input.permission,
      ...(input.grantedSkillIds ? { grantedSkillIds: input.grantedSkillIds } : {}),
      rows: result.value,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    });
    input.abortSignal?.throwIfAborted();
    return visibleRows
      .map((row) => {
        const skill = toCatalogSkill(row);
        return { skill, score: scoreSkill(skill, query) };
      })
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
      .slice(0, input.limit);
  }

  async searchVisibleRouters(input: {
    companyId: string;
    departmentId?: string;
    permission: PermissionResult;
    grantedSkillIds?: ReadonlySet<string>;
    includeGrantedDepartments?: boolean;
    query: string;
    variants?: readonly string[];
    limit: number;
  }): Promise<RouterSkillCandidate[]> {
    const originalQuery = analyzeQuery(input.query);
    const queries = [
      originalQuery,
      ...(input.variants ?? [])
        .slice(0, 2)
        .map((query) => analyzeQuery(query))
        .filter((query) => introducesNoProvider(query, originalQuery)),
    ].filter((query) => query.tokens.size > 0);
    if (queries.length === 0) return [];

    const result = await this.deps.repo.list({
      companyId: input.companyId,
      ...(input.departmentId ? { departmentId: input.departmentId } : {}),
      ...(input.includeGrantedDepartments && input.grantedSkillIds
        ? { additionalDepartmentSkillIds: [...input.grantedSkillIds] }
        : {}),
      tag: 'router',
      limit: 200,
    });
    if (!result.ok) {
      this.log.warn('skills.catalog.list.failed', { companyId: input.companyId, error: result.error.message });
      return [];
    }

    const visibleRows = await this.filterVisibleRows({
      companyId: input.companyId,
      ...(input.departmentId ? { departmentId: input.departmentId } : {}),
      permission: input.permission,
      ...(input.grantedSkillIds ? { grantedSkillIds: input.grantedSkillIds } : {}),
      ...(input.includeGrantedDepartments ? { includeGrantedDepartments: input.includeGrantedDepartments } : {}),
      rows: result.value,
    });
    const routers = visibleRows
      .map((row) => ({ row, skill: toCatalogSkill(row) }))
      .filter(({ skill }) => skill.tags.includes('router'))
      .filter(({ skill }) =>
        originalQuery.explicitFamilies.size === 0
        || [...originalQuery.explicitFamilies].some(family =>
          routerProviderFamilies(skill).has(family)));
    const scored = routers
      .map(({ row, skill }) => ({ row, candidate: scoreRouterCandidate(skill, queries) }))
      .sort((a, b) => b.candidate.score - a.candidate.score
        || a.candidate.name.localeCompare(b.candidate.name));
    const ranked = scored.filter(({ candidate }) => candidate.score > 0);

    // Provider-neutral business nouns rarely identify where the member stores
    // the data. Return compact approved router cards instead of making the
    // model invent a provider when there is genuinely no lexical match.
    // A stronger inaccessible match still fails closed instead of silently
    // substituting a weaker router. Explicit provider requests remain strict.
    if (originalQuery.explicitFamilies.size === 0) {
      if (ranked[0] && !this.isVisible(ranked[0].row, input.permission, input.grantedSkillIds)) {
        return [];
      }
      const fallback = scored.filter(({ candidate }) => candidate.score === 0);
      return [...ranked, ...fallback]
        .filter(({ row }) => this.isVisible(row, input.permission, input.grantedSkillIds))
        .map(({ candidate }) => candidate)
        .slice(0, input.limit);
    }
    if (!ranked[0] || !this.isVisible(ranked[0].row, input.permission, input.grantedSkillIds)) {
      return [];
    }
    return ranked
      .filter(({ row }) => this.isVisible(row, input.permission, input.grantedSkillIds))
      .map(({ candidate }) => candidate)
      .slice(0, input.limit);
  }

  async getVisible(input: {
    companyId: string;
    departmentId?: string;
    permission: PermissionResult;
    grantedSkillIds?: ReadonlySet<string>;
    includeGrantedDepartments?: boolean;
    skillId: string;
    abortSignal?: AbortSignal;
  }): Promise<CatalogSkill | null> {
    input.abortSignal?.throwIfAborted();
    const result = await this.deps.repo.findById({
      companyId: input.companyId,
      ...(input.departmentId ? { departmentId: input.departmentId } : {}),
      ...(input.includeGrantedDepartments && input.grantedSkillIds
        ? { additionalDepartmentSkillIds: [...input.grantedSkillIds] }
        : {}),
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
    const hasVisibleTargets = await this.hasVisibleRouteTarget({
      companyId: input.companyId,
      ...(input.departmentId ? { departmentId: input.departmentId } : {}),
      permission: input.permission,
      ...(input.grantedSkillIds ? { grantedSkillIds: input.grantedSkillIds } : {}),
      ...(input.includeGrantedDepartments ? { includeGrantedDepartments: input.includeGrantedDepartments } : {}),
      row: result.value,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    });
    if (!hasVisibleTargets) {
      return null;
    }
    return toCatalogSkill(result.value);
  }

  async listVisibleRouteTargets(input: {
    companyId: string;
    departmentId?: string;
    permission: PermissionResult;
    grantedSkillIds?: ReadonlySet<string>;
    includeGrantedDepartments?: boolean;
    routerSkillId: string;
    abortSignal?: AbortSignal;
  }): Promise<CatalogSkill[]> {
    input.abortSignal?.throwIfAborted();
    const result = await this.deps.repo.listRouteTargets({
      companyId: input.companyId,
      ...(input.departmentId ? { departmentId: input.departmentId } : {}),
      ...(input.includeGrantedDepartments && input.grantedSkillIds
        ? { additionalDepartmentSkillIds: [...input.grantedSkillIds] }
        : {}),
      routerSkillId: input.routerSkillId,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    });
    input.abortSignal?.throwIfAborted();
    if (!result.ok) {
      this.log.warn('skills.catalog.route_targets.failed', {
        companyId: input.companyId,
        routerSkillId: input.routerSkillId,
        error: result.error.message,
      });
      return [];
    }
    return result.value
      .filter(row => this.isVisible(row, input.permission, input.grantedSkillIds))
      .map(toCatalogSkill);
  }

  async authorizesTool(input: {
    companyId: string;
    departmentId?: string;
    permission: PermissionResult;
    grantedSkillIds?: ReadonlySet<string>;
    skillId: string;
    toolId: string;
  }): Promise<boolean> {
    const skill = await this.getVisible(input);
    return skill?.toolIds.includes(input.toolId) ?? false;
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
    // `every` matches the gateway's view gate. Listing a skill the dispatcher
    // will refuse to open advertises a dead end to the agent. An empty tool
    // list passes, which is what makes an instruction-only recipe visible.
    const executable = row.toolIds.every((toolId) =>
      permission.allowedToolIds.has(asToolId(toolId))
    );
    return granted && executable;
  }

  private async filterVisibleRows(input: {
    companyId: string;
    departmentId?: string;
    permission: PermissionResult;
    grantedSkillIds?: ReadonlySet<string>;
    includeGrantedDepartments?: boolean;
    rows: readonly SkillRow[];
    abortSignal?: AbortSignal;
  }): Promise<SkillRow[]> {
    const visibleRows = input.rows.filter((row) =>
      this.isVisible(row, input.permission, input.grantedSkillIds));
    const checked = await Promise.all(visibleRows.map(async (row) => ({
      row,
      visible: await this.hasVisibleRouteTarget({ ...input, row }),
    })));
    input.abortSignal?.throwIfAborted();
    return checked.filter(({ visible }) => visible).map(({ row }) => row);
  }

  private async hasVisibleRouteTarget(input: {
    companyId: string;
    departmentId?: string;
    permission: PermissionResult;
    grantedSkillIds?: ReadonlySet<string>;
    includeGrantedDepartments?: boolean;
    row: SkillRow;
    abortSignal?: AbortSignal;
  }): Promise<boolean> {
    if (!input.row.tags.includes('router')) return true;

    const result = await this.deps.repo.listRouteTargets({
      companyId: input.companyId,
      ...(input.departmentId ? { departmentId: input.departmentId } : {}),
      ...(input.includeGrantedDepartments && input.grantedSkillIds
        ? { additionalDepartmentSkillIds: [...input.grantedSkillIds] }
        : {}),
      routerSkillId: input.row.id,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    });
    input.abortSignal?.throwIfAborted();
    if (!result.ok) {
      this.log.warn('skills.catalog.route_targets.failed', {
        companyId: input.companyId,
        routerSkillId: input.row.id,
        error: result.error.message,
      });
      return false;
    }
    return result.value.some((row) =>
      this.isVisible(row, input.permission, input.grantedSkillIds));
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
    ...(row.departmentId ? { departmentId: row.departmentId } : {}),
    revision: row.revision,
  };
}

const SCORE_STOP_WORDS = new Set([
  'a', 'an', 'and', 'for', 'from', 'in', 'into', 'my', 'of', 'on', 'please',
  'return', 'the', 'then', 'to', 'using', 'with',
]);
const ROUTER_GENERIC_TOKENS = new Set([
  'count', 'counts', 'exact', 'give', 'many', 'overall', 'status', 'statuses', 'total',
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

/**
 * Fold a plural onto its singular, and nothing more ambitious than that.
 *
 * Routing scored tokens by exact set membership, so `email` found the Google
 * Workspace router and `emails` found nothing at all — every router came back
 * with a score of zero and the model had to guess. "Forward my emails
 * automatically" is close to the most ordinary way anybody would ask, and it
 * was the one phrasing that could not be routed.
 *
 * Deliberately not a real stemmer. This runs over every skill in the catalogue
 * and over every query, so a rule that is wrong is wrong for Airtable and
 * Shopify too — the risk here is a bad fold quietly merging two unrelated
 * words. So the exclusions are conservative:
 *
 *  · `ss`, `us`, `is` endings are left alone — `business`, `status`, `analysis`
 *  · anything four characters or shorter is left alone, which covers `docs`
 *    and `apps` staying as the tokens the catalogue already indexes
 *
 * Applied to the index and the query both, so a fold can only ever make a match
 * that already nearly existed. It never introduces a token neither side had.
 */
export function singularize(word: string): string {
  if (word.length <= 4 || !word.endsWith('s')) return word;
  if (/(ss|us|is)$/.test(word)) return word;
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  /*
   * `ch|sh|x|z` only — deliberately not `s`.
   *
   * `-ses` is ambiguous: `buses` drops `es`, but `expenses` and `responses`
   * drop only the `s`, and treating them alike produced `expens` and `respon`
   * — two catalogue words folded onto stems nothing indexes. The corpus test
   * caught it. Words like `buses` fold to `buse` instead, which is harmless
   * because both sides fold identically and nothing else lands there.
   */
  if (/(ch|sh|x|z)es$/.test(word)) return word.slice(0, -2);
  return word.slice(0, -1);
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 1 && !SCORE_STOP_WORDS.has(word))
    .map(singularize);
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

function introducesNoProvider(candidate: AnalyzedQuery, original: AnalyzedQuery): boolean {
  return [...candidate.explicitFamilies].every((family) => original.explicitFamilies.has(family));
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

function routerProviderFamilies(skill: CatalogSkill): ReadonlySet<ToolFamily> {
  const families = new Set(skillProviderFamilies(skill));
  const identity = analyzeQuery([
    skill.slug,
    skill.name,
    ...skill.tags,
    ...skill.aliases,
  ].join(' '));
  for (const family of identity.explicitFamilies) families.add(family);
  return families;
}

function scoreRouterCandidate(
  skill: CatalogSkill,
  queries: readonly AnalyzedQuery[],
): RouterSkillCandidate {
  const identityTokens = new Set(tokenize([
    skill.slug,
    skill.name,
    ...skill.tags,
  ].join(' ')));
  const aliasTokens = new Set(tokenize(skill.aliases.join(' ')));
  const descriptionTokens = new Set(tokenize(skill.description));
  const matchedTerms = new Set<string>();
  let score = 0;

  queries.forEach((query, queryIndex) => {
    const weight = queryIndex === 0 ? 2 : 1;
    for (const word of query.tokens) {
      if (ROUTER_GENERIC_TOKENS.has(word)) continue;
      const termScore = identityTokens.has(word)
        ? 5
        : aliasTokens.has(word)
          ? 4
          : descriptionTokens.has(word)
            ? 2
            : 0;
      if (termScore > 0) {
        score += termScore * weight;
        matchedTerms.add(word);
      }
    }
    for (const alias of skill.aliases) {
      const normalizedAlias = tokenize(alias).join(' ');
      if (normalizedAlias && includesExactPhrase(query.normalized, normalizedAlias)) {
        score += 10 * weight;
        matchedTerms.add(alias);
      }
    }
  });

  return {
    skillId: skill.id,
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    ...(skill.departmentId ? { departmentId: skill.departmentId } : {}),
    providerFamilies: [...routerProviderFamilies(skill)].sort(),
    score,
    matchedTerms: [...matchedTerms].sort(),
  };
}
