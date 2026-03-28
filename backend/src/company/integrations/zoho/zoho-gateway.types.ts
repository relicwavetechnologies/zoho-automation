import type { ZohoBooksModule } from './zoho-books.client';
import type { ZohoSourceType } from './zoho-data.client';

export type ZohoDomain = 'crm' | 'books';
export type ZohoGatewayScopeMode = 'self_scoped' | 'company_scoped';

export type ZohoGatewayCrmModule = 'Leads' | 'Contacts' | 'Accounts' | 'Deals' | 'Cases';

export type ZohoGatewayPrincipalContext = {
  companyId: string;
  requesterEmail?: string;
  requesterAiRole?: string;
  departmentZohoReadScope?: 'personalized' | 'show_all';
  domain: ZohoDomain;
  scopeMode: ZohoGatewayScopeMode;
  normalizedRequesterEmail?: string;
  crm?: {
    sourceTypes: ZohoSourceType[];
  };
  books?: {
    contactIds: string[];
  };
};

export type ZohoGatewayFilterSpec = {
  nativeFilters: Record<string, unknown>;
  query?: string;
  limit?: number;
};

export type ZohoRecordOwnershipVerdict = {
  allowed: boolean;
  reason?: string;
  matchedBy?: string[];
};

export type ZohoAuthorizationResult<TPayload = Record<string, unknown>> = {
  allowed: boolean;
  scopeMode: ZohoGatewayScopeMode;
  principal: ZohoGatewayPrincipalContext;
  compiledFilters: Record<string, unknown>;
  denialReason?: string;
  organizationId?: string;
  module?: string;
  payload?: TPayload;
  candidateCount?: number;
  returnedCount?: number;
  droppedCount?: number;
};

export type ZohoGatewayRequester = {
  companyId: string;
  userId?: string;
  departmentId?: string;
  departmentRoleSlug?: string;
  requesterEmail?: string;
  requesterAiRole?: string;
  departmentZohoReadScope?: 'personalized' | 'show_all';
};

export type ZohoGatewayChildResourceType =
  | 'notes'
  | 'attachments'
  | 'attachment_content'
  | 'email_content'
  | 'payment_reminder_content'
  | 'record_document'
  | 'comments'
  | 'statement_email_content'
  | 'report'
  | 'bank_statement'
  | 'bank_match_candidates';

export type ZohoGatewayMutationInput = {
  domain: ZohoDomain;
  module?: ZohoGatewayCrmModule | ZohoBooksModule | string;
  operation: string;
  recordId?: string;
  organizationId?: string;
  requester: ZohoGatewayRequester;
};
