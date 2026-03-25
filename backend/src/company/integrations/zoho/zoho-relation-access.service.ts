import { prisma } from '../../../utils/prisma';
import { zohoUserAccessExceptionService } from '../../tools/zoho-user-access-exception.service';
import { normalizeEmail } from './zoho-email-scope';
import { zohoDataClient, type ZohoSourceType } from './zoho-data.client';
import { zohoBooksClient, type ZohoBooksModule } from './zoho-books.client';
import {
  extractBooksRelationEmails,
  extractCrmRelationEmails,
  getBooksDirectRelationRule,
  getCrmRelationRule,
  isBulkBooksModule,
} from './zoho-relation-rules';

export type ZohoDeniedReason =
  | 'missing_requester_email'
  | 'bulk_request'
  | 'cross_user_target'
  | 'relation_not_proven'
  | 'module_not_relation_mapped'
  | 'exception_required';

export type ZohoActorScope = {
  companyId: string;
  userId?: string;
  requesterEmail?: string;
  normalizedRequesterEmail?: string;
  bypassRelationScope: boolean;
  scopeMode: 'email_scoped' | 'company_scoped';
};

export type ZohoAccessDecision = {
  allowed: boolean;
  reasonCode?: ZohoDeniedReason;
  reasonMessage?: string;
};

const readString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

const readRecordId = (value: unknown): string | undefined => {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (value && typeof value === 'object') {
    return readString((value as Record<string, unknown>).id);
  }
  return undefined;
};

const firstExisting = (payload: Record<string, unknown>, keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = readRecordId(payload[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
};

export class ZohoRelationAccessService {
  async resolveActorScope(input: {
    companyId: string;
    userId?: string;
    requesterEmail?: string;
  }): Promise<ZohoActorScope> {
    const activeException = await zohoUserAccessExceptionService.resolveActiveException(
      input.companyId,
      input.userId,
    );
    const normalizedRequesterEmail = normalizeEmail(input.requesterEmail);
    const bypassRelationScope = Boolean(activeException?.bypassRelationScope);
    return {
      companyId: input.companyId,
      userId: input.userId,
      requesterEmail: input.requesterEmail,
      normalizedRequesterEmail,
      bypassRelationScope,
      scopeMode: bypassRelationScope ? 'company_scoped' : 'email_scoped',
    };
  }

  classifyDeniedAttempt(input: {
    reasonCode: ZohoDeniedReason;
    operation: string;
    targetId?: string;
  }): 'cross_user_target' | 'bulk_request' | undefined {
    if (input.reasonCode === 'bulk_request') {
      return 'bulk_request';
    }
    if (input.targetId) {
      return 'cross_user_target';
    }
    if (input.operation.startsWith('list') || input.operation.startsWith('summarize') || input.operation.startsWith('build') || input.operation.startsWith('reconcile')) {
      return 'bulk_request';
    }
    return input.reasonCode === 'cross_user_target' ? 'cross_user_target' : undefined;
  }

  async assertReadableCrmRecord(input: {
    actor: ZohoActorScope;
    sourceType: ZohoSourceType;
    recordId?: string;
    record?: Record<string, unknown> | null;
    environment?: string;
  }): Promise<ZohoAccessDecision> {
    if (input.actor.bypassRelationScope) {
      return { allowed: true };
    }
    if (!input.actor.normalizedRequesterEmail) {
      return { allowed: false, reasonCode: 'missing_requester_email', reasonMessage: 'A verified requester email is required.' };
    }
    const rule = getCrmRelationRule(input.sourceType);
    if (!rule) {
      return { allowed: false, reasonCode: 'module_not_relation_mapped', reasonMessage: `No relation rule is defined for ${input.sourceType}.` };
    }
    const record = input.record ?? (input.recordId
      ? await zohoDataClient.fetchRecordBySource({
        companyId: input.actor.companyId,
        environment: input.environment,
        sourceType: input.sourceType,
        sourceId: input.recordId,
      })
      : null);
    if (!record) {
      return { allowed: false, reasonCode: 'relation_not_proven', reasonMessage: 'The target record could not be resolved.' };
    }
    const directEmails = extractCrmRelationEmails(input.sourceType, record);
    if (directEmails.includes(input.actor.normalizedRequesterEmail)) {
      return { allowed: true };
    }
    if (input.sourceType === 'zoho_account') {
      return this.assertAccountRelation(input.actor, record, input.environment);
    }
    if (input.sourceType === 'zoho_deal') {
      return this.assertDealRelation(input.actor, record, input.environment);
    }
    if (input.sourceType === 'zoho_ticket') {
      return this.assertCaseRelation(input.actor, record, input.environment);
    }
    return {
      allowed: false,
      reasonCode: 'cross_user_target',
      reasonMessage: 'The record is not related to the requester.',
    };
  }

  async filterReadableCrmRecords(input: {
    actor: ZohoActorScope;
    sourceType: ZohoSourceType;
    records: Array<Record<string, unknown>>;
    environment?: string;
  }): Promise<Array<Record<string, unknown>>> {
    if (input.actor.bypassRelationScope) {
      return input.records;
    }
    const filtered: Array<Record<string, unknown>> = [];
    for (const record of input.records) {
      const decision = await this.assertReadableCrmRecord({
        actor: input.actor,
        sourceType: input.sourceType,
        record,
        recordId: readString(record.id),
        environment: input.environment,
      });
      if (decision.allowed) {
        filtered.push(record);
      }
    }
    return filtered;
  }

  async assertReadableBooksRecord(input: {
    actor: ZohoActorScope;
    moduleName: ZohoBooksModule;
    recordId?: string;
    record?: Record<string, unknown>;
    organizationId?: string;
    environment?: string;
  }): Promise<ZohoAccessDecision> {
    if (input.actor.bypassRelationScope) {
      return { allowed: true };
    }
    if (!input.actor.normalizedRequesterEmail) {
      return { allowed: false, reasonCode: 'missing_requester_email', reasonMessage: 'A verified requester email is required.' };
    }
    if (isBulkBooksModule(input.moduleName) || input.moduleName === 'bankaccounts' || input.moduleName === 'banktransactions') {
      return { allowed: false, reasonCode: 'bulk_request', reasonMessage: `${input.moduleName} is not available without an explicit exception.` };
    }
    const record = input.record ?? (input.recordId
      ? (await zohoBooksClient.getRecord({
        companyId: input.actor.companyId,
        environment: input.environment,
        moduleName: input.moduleName,
        recordId: input.recordId,
        organizationId: input.organizationId,
      })).record
      : undefined);
    if (!record) {
      return { allowed: false, reasonCode: 'relation_not_proven', reasonMessage: 'The target Zoho Books record could not be resolved.' };
    }

    const directRule = getBooksDirectRelationRule(input.moduleName);
    const directEmails = directRule ? extractBooksRelationEmails(input.moduleName, record) : [];
    if (directEmails.includes(input.actor.normalizedRequesterEmail)) {
      return { allowed: true };
    }

    if (input.moduleName === 'contacts') {
      return {
        allowed: false,
        reasonCode: 'cross_user_target',
        reasonMessage: 'The contact is not related to the requester.',
      };
    }

    const relatedContactId =
      firstExisting(record, ['customer_id', 'contact_id', 'customerId'])
      ?? (['bills', 'vendorpayments', 'purchaseorders'].includes(input.moduleName)
        ? firstExisting(record, ['vendor_id', 'contact_id', 'vendorId'])
        : undefined);
    if (!relatedContactId) {
      return { allowed: false, reasonCode: 'relation_not_proven', reasonMessage: 'No related contact could be verified for this record.' };
    }

    const relatedContact = (await zohoBooksClient.getRecord({
      companyId: input.actor.companyId,
      environment: input.environment,
      moduleName: 'contacts',
      recordId: relatedContactId,
      organizationId: input.organizationId,
    })).record;
    const relatedEmails = extractBooksRelationEmails('contacts', relatedContact);
    return relatedEmails.includes(input.actor.normalizedRequesterEmail)
      ? { allowed: true }
      : { allowed: false, reasonCode: 'cross_user_target', reasonMessage: 'The related contact does not match the requester.' };
  }

  async filterReadableBooksRecords(input: {
    actor: ZohoActorScope;
    moduleName: ZohoBooksModule;
    records: Array<Record<string, unknown>>;
    organizationId?: string;
    environment?: string;
  }): Promise<Array<Record<string, unknown>>> {
    if (input.actor.bypassRelationScope) {
      return input.records;
    }
    const filtered: Array<Record<string, unknown>> = [];
    for (const record of input.records) {
      const decision = await this.assertReadableBooksRecord({
        actor: input.actor,
        moduleName: input.moduleName,
        record,
        recordId: readString(record.id),
        organizationId: input.organizationId,
        environment: input.environment,
      });
      if (decision.allowed) {
        filtered.push(record);
      }
    }
    return filtered;
  }

  async assertWritableTarget(input: {
    actor: ZohoActorScope;
    domain: 'crm' | 'books';
    operation: string;
    sourceType?: ZohoSourceType;
    moduleName?: ZohoBooksModule;
    recordId?: string;
    record?: Record<string, unknown>;
    environment?: string;
    organizationId?: string;
    fields?: Record<string, unknown>;
  }): Promise<ZohoAccessDecision> {
    if (input.actor.bypassRelationScope) {
      return { allowed: true };
    }
    if (input.domain === 'crm' && input.sourceType && (input.recordId || input.record)) {
      return this.assertReadableCrmRecord({
        actor: input.actor,
        sourceType: input.sourceType,
        recordId: input.recordId,
        record: input.record,
        environment: input.environment,
      });
    }
    if (input.domain === 'books' && input.moduleName && (input.recordId || input.record)) {
      return this.assertReadableBooksRecord({
        actor: input.actor,
        moduleName: input.moduleName,
        recordId: input.recordId,
        record: input.record,
        environment: input.environment,
        organizationId: input.organizationId,
      });
    }
    if (!input.actor.normalizedRequesterEmail) {
      return { allowed: false, reasonCode: 'missing_requester_email', reasonMessage: 'A verified requester email is required.' };
    }
    if (!input.fields) {
      return { allowed: false, reasonCode: 'relation_not_proven', reasonMessage: 'The write target could not be verified.' };
    }
    if (input.domain === 'crm' && input.sourceType) {
      const directEmails = extractCrmRelationEmails(input.sourceType, input.fields);
      return directEmails.includes(input.actor.normalizedRequesterEmail)
        ? { allowed: true }
        : { allowed: false, reasonCode: 'relation_not_proven', reasonMessage: 'The create payload does not establish a relation to the requester.' };
    }
    if (input.domain === 'books' && input.moduleName) {
      if (isBulkBooksModule(input.moduleName)) {
        return { allowed: false, reasonCode: 'bulk_request', reasonMessage: `${input.moduleName} is not writable without an explicit exception.` };
      }
      const directEmails = extractBooksRelationEmails(input.moduleName, input.fields);
      if (directEmails.includes(input.actor.normalizedRequesterEmail)) {
        return { allowed: true };
      }
      const relatedContactId =
        firstExisting(input.fields, ['customer_id', 'contact_id', 'customerId'])
        ?? firstExisting(input.fields, ['vendor_id', 'contact_id', 'vendorId']);
      if (!relatedContactId || !input.organizationId) {
        return { allowed: false, reasonCode: 'relation_not_proven', reasonMessage: 'The create payload does not establish a verified related contact.' };
      }
      return this.assertReadableBooksRecord({
        actor: input.actor,
        moduleName: 'contacts',
        recordId: relatedContactId,
        organizationId: input.organizationId,
        environment: input.environment,
      });
    }
    return { allowed: false, reasonCode: 'relation_not_proven', reasonMessage: 'The write target could not be verified.' };
  }

  private async assertAccountRelation(actor: ZohoActorScope, record: Record<string, unknown>, environment?: string): Promise<ZohoAccessDecision> {
    const accountId = readString(record.id);
    if (!accountId || !actor.normalizedRequesterEmail) {
      return { allowed: false, reasonCode: 'relation_not_proven', reasonMessage: 'The account relation could not be verified.' };
    }
    const selectQuery = `select id from Contacts where Account_Name.id = '${accountId.replace(/'/g, "\\'")}' and Email = '${actor.normalizedRequesterEmail.replace(/'/g, "\\'")}' limit 0, 1`;
    const rows = await zohoDataClient.queryCoqlRows({
      companyId: actor.companyId,
      environment,
      selectQuery,
    });
    return rows.length > 0
      ? { allowed: true }
      : { allowed: false, reasonCode: 'cross_user_target', reasonMessage: 'No related contact matches the requester.' };
  }

  private async assertDealRelation(actor: ZohoActorScope, record: Record<string, unknown>, environment?: string): Promise<ZohoAccessDecision> {
    const contactId = firstExisting(record, ['Contact_Name']);
    if (contactId) {
      return this.assertReadableCrmRecord({
        actor,
        sourceType: 'zoho_contact',
        recordId: contactId,
        environment,
      });
    }
    const accountId = firstExisting(record, ['Account_Name']);
    if (accountId) {
      return this.assertReadableCrmRecord({
        actor,
        sourceType: 'zoho_account',
        recordId: accountId,
        environment,
      });
    }
    return { allowed: false, reasonCode: 'cross_user_target', reasonMessage: 'No related deal contact or account matches the requester.' };
  }

  private async assertCaseRelation(actor: ZohoActorScope, record: Record<string, unknown>, environment?: string): Promise<ZohoAccessDecision> {
    const contactId = firstExisting(record, ['Contact_Name']);
    if (contactId) {
      return this.assertReadableCrmRecord({
        actor,
        sourceType: 'zoho_contact',
        recordId: contactId,
        environment,
      });
    }
    const accountId = firstExisting(record, ['Account_Name']);
    if (accountId) {
      return this.assertReadableCrmRecord({
        actor,
        sourceType: 'zoho_account',
        recordId: accountId,
        environment,
      });
    }
    return { allowed: false, reasonCode: 'cross_user_target', reasonMessage: 'No related case contact or account matches the requester.' };
  }
}

export const zohoRelationAccessService = new ZohoRelationAccessService();
