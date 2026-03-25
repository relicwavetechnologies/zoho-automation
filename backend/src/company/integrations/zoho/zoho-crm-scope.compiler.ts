import { payloadReferencesEmail, normalizeEmail } from './zoho-email-scope';
import type { ZohoGatewayCrmModule, ZohoRecordOwnershipVerdict } from './zoho-gateway.types';
import type { ZohoSourceType } from './zoho-data.client';

const CRM_SOURCE_TYPE_BY_MODULE: Record<ZohoGatewayCrmModule, ZohoSourceType> = {
  Leads: 'zoho_lead',
  Contacts: 'zoho_contact',
  Accounts: 'zoho_account',
  Deals: 'zoho_deal',
  Cases: 'zoho_ticket',
};

export const normalizeCrmGatewayModule = (value?: string): ZohoGatewayCrmModule | undefined => {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (['leads', 'lead', 'zoho_lead'].includes(normalized)) return 'Leads';
  if (['contacts', 'contact', 'zoho_contact'].includes(normalized)) return 'Contacts';
  if (['accounts', 'account', 'companies', 'company', 'zoho_account'].includes(normalized)) return 'Accounts';
  if (['deals', 'deal', 'zoho_deal'].includes(normalized)) return 'Deals';
  if (['cases', 'case', 'tickets', 'ticket', 'zoho_ticket'].includes(normalized)) return 'Cases';
  return undefined;
};

export const crmModuleToSourceType = (moduleName: ZohoGatewayCrmModule): ZohoSourceType =>
  CRM_SOURCE_TYPE_BY_MODULE[moduleName];

export const compileCrmGatewayFilters = (filters?: Record<string, unknown>): Record<string, unknown> => {
  const compiled: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(filters ?? {})) {
    if (typeof key !== 'string' || key.trim().length === 0) continue;
    if (typeof value === 'string' && value.trim().length > 0) {
      compiled[key] = value.trim();
      continue;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      compiled[key] = value;
    }
  }
  return compiled;
};

export const verifyCrmRecordOwnership = (
  payload: Record<string, unknown>,
  requesterEmail?: string,
): ZohoRecordOwnershipVerdict => {
  const normalizedRequesterEmail = normalizeEmail(requesterEmail);
  if (!normalizedRequesterEmail) {
    return {
      allowed: false,
      reason: 'missing_requester_email',
    };
  }
  const matches = payloadReferencesEmail(payload, normalizedRequesterEmail);
  return {
    allowed: matches,
    reason: matches ? undefined : 'email_not_found_in_record',
    matchedBy: matches ? ['payload_email'] : [],
  };
};
