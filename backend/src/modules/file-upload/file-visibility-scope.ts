import { aiRoleService } from '../../company/tools/ai-role.service';
import { memberAuthRepository } from '../member-auth/member-auth.repository';

export type FileVisibilityScope = 'personal' | 'same_role' | 'company' | 'custom';

const FILE_VISIBILITY_SCOPES = new Set<FileVisibilityScope>(['personal', 'same_role', 'company', 'custom']);

const uniq = (values: string[]): string[] => Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));

export const normalizeFileVisibilityScope = (value: unknown): FileVisibilityScope | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return FILE_VISIBILITY_SCOPES.has(normalized as FileVisibilityScope)
    ? normalized as FileVisibilityScope
    : null;
};

export const resolveAllowedRolesForVisibilityScope = async (input: {
  companyId: string;
  visibilityScope: FileVisibilityScope;
  uploaderRole: string;
  explicitRoles?: string[];
}): Promise<string[]> => {
  const allRoles = await aiRoleService.getRoleSlugs(input.companyId);
  const normalizedUploaderRole = input.uploaderRole.trim() || 'MEMBER';

  if (input.visibilityScope === 'personal') {
    return [];
  }

  if (input.visibilityScope === 'same_role') {
    return [normalizedUploaderRole];
  }

  if (input.visibilityScope === 'company') {
    return uniq(allRoles);
  }

  const requested = uniq(input.explicitRoles ?? []);
  const validRoleSet = new Set(allRoles);
  return requested.filter((role) => validRoleSet.has(role));
};

export const inferFileVisibilityScope = (input: {
  uploaderRole: string;
  allowedRoles: string[];
  allRoles: string[];
}): FileVisibilityScope => {
  const allowed = uniq(input.allowedRoles);
  if (allowed.length === 0) {
    return 'personal';
  }

  const uploaderRole = input.uploaderRole.trim();
  if (uploaderRole && allowed.length === 1 && allowed[0] === uploaderRole) {
    return 'same_role';
  }

  const allRoles = uniq(input.allRoles);
  if (allRoles.length > 0 && allowed.length === allRoles.length && allRoles.every((role) => allowed.includes(role))) {
    return 'company';
  }

  return 'custom';
};

export const resolveUploaderRoleForCompany = async (input: {
  companyId: string;
  uploaderUserId: string;
}): Promise<string> => {
  const membership = await memberAuthRepository.findActiveMembership(input.uploaderUserId, input.companyId);
  return membership?.role?.trim() || 'MEMBER';
};
