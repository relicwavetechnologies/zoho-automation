import type { ZohoSourceType } from './zoho-data.client';
import type { ZohoBooksModule } from './zoho-books.client';
import { normalizeEmail } from './zoho-email-scope';

export type ZohoRelationRule = {
  key: string;
  moduleName: string;
  directEmailPaths: string[];
};

const CRM_RULES: Record<ZohoSourceType, ZohoRelationRule> = {
  zoho_lead: {
    key: 'zoho_lead',
    moduleName: 'Leads',
    directEmailPaths: ['Email', 'Secondary_Email'],
  },
  zoho_contact: {
    key: 'zoho_contact',
    moduleName: 'Contacts',
    directEmailPaths: ['Email', 'Secondary_Email'],
  },
  zoho_account: {
    key: 'zoho_account',
    moduleName: 'Accounts',
    directEmailPaths: ['Email', 'Secondary_Email'],
  },
  zoho_deal: {
    key: 'zoho_deal',
    moduleName: 'Deals',
    directEmailPaths: ['Email', 'Secondary_Email'],
  },
  zoho_ticket: {
    key: 'zoho_ticket',
    moduleName: 'Cases',
    directEmailPaths: ['Email', 'Secondary_Email', 'Contact_Email'],
  },
};

const BOOKS_DIRECT_RULES: Partial<Record<ZohoBooksModule, ZohoRelationRule>> = {
  contacts: {
    key: 'books_contacts',
    moduleName: 'contacts',
    directEmailPaths: [
      'email',
      'contact_persons[].email',
      'contact_persons[].zcrm_contact_email',
    ],
  },
  invoices: {
    key: 'books_invoices',
    moduleName: 'invoices',
    directEmailPaths: ['customer_email', 'contact_persons[].email'],
  },
  estimates: {
    key: 'books_estimates',
    moduleName: 'estimates',
    directEmailPaths: ['customer_email', 'contact_persons[].email'],
  },
  creditnotes: {
    key: 'books_creditnotes',
    moduleName: 'creditnotes',
    directEmailPaths: ['customer_email', 'contact_persons[].email'],
  },
  salesorders: {
    key: 'books_salesorders',
    moduleName: 'salesorders',
    directEmailPaths: ['customer_email', 'contact_persons[].email'],
  },
  bills: {
    key: 'books_bills',
    moduleName: 'bills',
    directEmailPaths: ['vendor_email', 'contact_persons[].email'],
  },
  vendorpayments: {
    key: 'books_vendorpayments',
    moduleName: 'vendorpayments',
    directEmailPaths: ['vendor_email', 'contact_persons[].email'],
  },
  purchaseorders: {
    key: 'books_purchaseorders',
    moduleName: 'purchaseorders',
    directEmailPaths: ['vendor_email', 'contact_persons[].email'],
  },
};

const BULK_BOOKS_MODULES = new Set<ZohoBooksModule>(['bankaccounts', 'banktransactions']);

const readPathValues = (value: unknown, segments: string[]): unknown[] => {
  if (segments.length === 0) {
    return [value];
  }
  const [head, ...tail] = segments;
  if (head.endsWith('[]')) {
    const key = head.slice(0, -2);
    const next = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
    if (!Array.isArray(next)) {
      return [];
    }
    return next.flatMap((entry) => readPathValues(entry, tail));
  }
  const next = value && typeof value === 'object' ? (value as Record<string, unknown>)[head] : undefined;
  return readPathValues(next, tail);
};

const extractEmailsForRule = (payload: Record<string, unknown>, rule?: ZohoRelationRule): string[] => {
  if (!rule) {
    return [];
  }
  const emails = new Set<string>();
  for (const path of rule.directEmailPaths) {
    for (const value of readPathValues(payload, path.split('.'))) {
      const normalized = normalizeEmail(value);
      if (normalized) {
        emails.add(normalized);
      }
    }
  }
  return [...emails];
};

export const getCrmRelationRule = (sourceType: ZohoSourceType): ZohoRelationRule | undefined => CRM_RULES[sourceType];

export const getBooksDirectRelationRule = (moduleName: ZohoBooksModule): ZohoRelationRule | undefined =>
  BOOKS_DIRECT_RULES[moduleName];

export const extractCrmRelationEmails = (sourceType: ZohoSourceType, payload: Record<string, unknown>): string[] =>
  extractEmailsForRule(payload, getCrmRelationRule(sourceType));

export const extractBooksRelationEmails = (moduleName: ZohoBooksModule, payload: Record<string, unknown>): string[] =>
  extractEmailsForRule(payload, getBooksDirectRelationRule(moduleName));

export const isBulkBooksModule = (moduleName: ZohoBooksModule): boolean => BULK_BOOKS_MODULES.has(moduleName);
