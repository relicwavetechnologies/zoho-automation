import { z } from 'zod';

/** Built-in company AI roles. Custom roles are additional string values. */
export const BUILT_IN_COMPANY_ROLES = ['MEMBER', 'COMPANY_ADMIN', 'SUPER_ADMIN'] as const;
export type BuiltInCompanyRole = typeof BUILT_IN_COMPANY_ROLES[number];

/** Branded slug — comes from ChannelIdentity.aiRole in the DB. */
export type CompanyRoleSlug = string & { readonly __companyRole: true };

export const asCompanyRoleSlug = (s: string): CompanyRoleSlug =>
  s.trim().toUpperCase() as CompanyRoleSlug;

export const CompanyRoleSlugSchema = z
  .string()
  .transform(s => asCompanyRoleSlug(s));

export const isBuiltIn = (slug: CompanyRoleSlug): boolean =>
  (BUILT_IN_COMPANY_ROLES as readonly string[]).includes(slug);
