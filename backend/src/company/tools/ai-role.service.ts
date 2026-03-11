import { aiRoleRepository, type AiRoleRow } from './ai-role.repository';

export type AiRoleDTO = {
  id: string;
  slug: string;
  displayName: string;
  isBuiltIn: boolean;
};

export type EnsureAiRoleResult = {
  role: AiRoleDTO;
  created: boolean;
};

const toDTO = (row: AiRoleRow): AiRoleDTO => ({
  id: row.id,
  slug: row.slug,
  displayName: row.displayName,
  isBuiltIn: row.isBuiltIn,
});

const SLUG_RE = /^[A-Z][A-Z0-9_]{1,29}$/;

class AiRoleService {
  /** Returns built-ins + custom roles for a company, seeding built-ins if needed. */
  async listRoles(companyId: string): Promise<AiRoleDTO[]> {
    await aiRoleRepository.ensureBuiltIns(companyId);
    const rows = await aiRoleRepository.listByCompany(companyId);
    return rows.map(toDTO);
  }

  async createRole(companyId: string, slug: string, displayName: string): Promise<AiRoleDTO> {
    const normalizedSlug = slug.trim().toUpperCase().replace(/\s+/g, '_');
    if (!SLUG_RE.test(normalizedSlug)) {
      throw new Error('Role slug must be 2-30 uppercase letters/digits/underscores, starting with a letter.');
    }
    const existing = await aiRoleRepository.findBySlug(companyId, normalizedSlug);
    if (existing) {
      throw new Error(`Role "${normalizedSlug}" already exists.`);
    }
    const row = await aiRoleRepository.create(companyId, normalizedSlug, displayName.trim());
    return toDTO(row);
  }

  async ensureRole(companyId: string, slug: string, displayName: string): Promise<EnsureAiRoleResult> {
    const normalizedSlug = slug.trim().toUpperCase().replace(/\s+/g, '_');
    if (!SLUG_RE.test(normalizedSlug)) {
      throw new Error('Role slug must be 2-30 uppercase letters/digits/underscores, starting with a letter.');
    }
    await aiRoleRepository.ensureBuiltIns(companyId);
    const existing = await aiRoleRepository.findBySlug(companyId, normalizedSlug);
    if (existing) {
      if (!existing.isBuiltIn && existing.displayName !== displayName.trim()) {
        const updated = await aiRoleRepository.update(existing.id, companyId, displayName.trim());
        return { role: toDTO(updated), created: false };
      }
      return { role: toDTO(existing), created: false };
    }
    const row = await aiRoleRepository.create(companyId, normalizedSlug, displayName.trim());
    return { role: toDTO(row), created: true };
  }

  async updateRole(companyId: string, roleId: string, displayName: string): Promise<AiRoleDTO> {
    const row = await aiRoleRepository.update(roleId, companyId, displayName.trim());
    return toDTO(row);
  }

  async deleteRole(companyId: string, roleId: string): Promise<void> {
    // Deletes only non-built-in roles (repository enforces isBuiltIn: false)
    await aiRoleRepository.delete(roleId, companyId);
  }

  /** Returns all valid role slugs for a company (built-ins + custom). */
  async getRoleSlugs(companyId: string): Promise<string[]> {
    const roles = await this.listRoles(companyId);
    return roles.map((r) => r.slug);
  }
}

export const aiRoleService = new AiRoleService();
