import { createHash } from 'crypto';

import { prisma } from '../../utils/prisma';
import { companyPromptProfileCache, type CompanyPromptProfileRuntime } from './company-prompt-profile.cache';

type UpsertCompanyPromptProfileInput = {
  companyId: string;
  actorUserId: string;
  companyContext: string;
  systemsOfRecord: string;
  businessRules: string;
  communicationStyle: string;
  formattingDefaults: string;
  restrictedClaims: string;
  isActive?: boolean;
};

const normalizeText = (value: string | null | undefined): string =>
  (value ?? '').replace(/\r\n?/g, '\n').trim();

const buildRevisionHash = (input: Omit<CompanyPromptProfileRuntime, 'revisionHash' | 'hasContent'>): string =>
  createHash('sha1')
    .update(JSON.stringify(input))
    .digest('hex')
    .slice(0, 12);

const toRuntimeProfile = (input: {
  companyId: string;
  companyContext?: string | null;
  systemsOfRecord?: string | null;
  businessRules?: string | null;
  communicationStyle?: string | null;
  formattingDefaults?: string | null;
  restrictedClaims?: string | null;
  isActive?: boolean | null;
}): CompanyPromptProfileRuntime => {
  const profile = {
    companyId: input.companyId,
    companyContext: normalizeText(input.companyContext),
    systemsOfRecord: normalizeText(input.systemsOfRecord),
    businessRules: normalizeText(input.businessRules),
    communicationStyle: normalizeText(input.communicationStyle),
    formattingDefaults: normalizeText(input.formattingDefaults),
    restrictedClaims: normalizeText(input.restrictedClaims),
    isActive: input.isActive ?? true,
  };
  const hasContent = Boolean(
    profile.isActive
    && [
      profile.companyContext,
      profile.systemsOfRecord,
      profile.businessRules,
      profile.communicationStyle,
      profile.formattingDefaults,
      profile.restrictedClaims,
    ].some((value) => value.length > 0),
  );
  return {
    ...profile,
    revisionHash: buildRevisionHash(profile),
    hasContent,
  };
};

class CompanyPromptProfileService {
  async resolveRuntimeProfile(companyId: string): Promise<CompanyPromptProfileRuntime> {
    const cached = await companyPromptProfileCache.get(companyId);
    if (cached) {
      return cached;
    }

    const stored = await prisma.companyPromptProfile.findUnique({
      where: { companyId },
    });
    const profile = toRuntimeProfile({
      companyId,
      companyContext: stored?.companyContext,
      systemsOfRecord: stored?.systemsOfRecord,
      businessRules: stored?.businessRules,
      communicationStyle: stored?.communicationStyle,
      formattingDefaults: stored?.formattingDefaults,
      restrictedClaims: stored?.restrictedClaims,
      isActive: stored?.isActive ?? true,
    });
    await companyPromptProfileCache.set(profile);
    return profile;
  }

  async getAdminProfile(companyId: string): Promise<CompanyPromptProfileRuntime> {
    return this.resolveRuntimeProfile(companyId);
  }

  async upsertProfile(input: UpsertCompanyPromptProfileInput): Promise<CompanyPromptProfileRuntime> {
    const normalized = toRuntimeProfile({
      companyId: input.companyId,
      companyContext: input.companyContext,
      systemsOfRecord: input.systemsOfRecord,
      businessRules: input.businessRules,
      communicationStyle: input.communicationStyle,
      formattingDefaults: input.formattingDefaults,
      restrictedClaims: input.restrictedClaims,
      isActive: input.isActive ?? true,
    });

    await prisma.companyPromptProfile.upsert({
      where: { companyId: input.companyId },
      update: {
        companyContext: normalized.companyContext,
        systemsOfRecord: normalized.systemsOfRecord,
        businessRules: normalized.businessRules,
        communicationStyle: normalized.communicationStyle,
        formattingDefaults: normalized.formattingDefaults,
        restrictedClaims: normalized.restrictedClaims,
        isActive: normalized.isActive,
        updatedBy: input.actorUserId,
      },
      create: {
        companyId: input.companyId,
        companyContext: normalized.companyContext,
        systemsOfRecord: normalized.systemsOfRecord,
        businessRules: normalized.businessRules,
        communicationStyle: normalized.communicationStyle,
        formattingDefaults: normalized.formattingDefaults,
        restrictedClaims: normalized.restrictedClaims,
        isActive: normalized.isActive,
        createdBy: input.actorUserId,
        updatedBy: input.actorUserId,
      },
    });

    await companyPromptProfileCache.invalidate(input.companyId);
    await companyPromptProfileCache.set(normalized);
    return normalized;
  }

  async invalidate(companyId: string): Promise<void> {
    await companyPromptProfileCache.invalidate(companyId);
  }
}

export const companyPromptProfileService = new CompanyPromptProfileService();

export { toRuntimeProfile as normalizeCompanyPromptProfileRuntime };
