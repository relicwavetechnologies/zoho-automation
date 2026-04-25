/**
 * Port interfaces for external dependencies used by ContextSearchBroker.
 *
 * Each port is a minimal interface that can be implemented by the real infra
 * adapter or a test double. Composition.ts wires concrete implementations.
 */

// ─── Lark contacts ────────────────────────────────────────────────────────────

export interface LarkContactRecord {
  readonly larkOpenId?: string;
  readonly larkUserId?: string;
  readonly externalUserId?: string;
  readonly displayName?: string;
  readonly email?: string;
  readonly updatedAt?: Date;
  readonly createdAt?: Date;
}

export interface LarkContactPort {
  /** Full-text search over Lark contacts for a company. */
  searchContacts(input: {
    companyId: string;
    query: string;
    limit: number;
  }): Promise<LarkContactRecord[]>;
}

// ─── Zoho Books ───────────────────────────────────────────────────────────────

export interface ZohoBooksOrg {
  readonly organizationId: string;
  readonly name?: string;
}

export interface ZohoBooksListResult {
  readonly allowed: boolean;
  readonly organizationId?: string;
  readonly records: Array<Record<string, unknown>>;
}

export interface ZohoBooksPort {
  /** List available Zoho Books organizations for a company. */
  listOrganizations(companyId: string): Promise<ZohoBooksOrg[]>;

  /** Query contacts from Zoho Books (with permission check). */
  listContacts(input: {
    companyId: string;
    userId: string;
    requesterEmail?: string;
    requesterAiRole?: string;
    departmentId?: string;
    departmentZohoReadScope?: string;
    organizationId?: string;
    query?: string;
    page: number;
    perPage: number;
  }): Promise<ZohoBooksListResult>;

  /** Query invoices from Zoho Books (with permission check). */
  listInvoices(input: {
    companyId: string;
    userId: string;
    requesterEmail?: string;
    requesterAiRole?: string;
    departmentId?: string;
    departmentZohoReadScope?: string;
    organizationId?: string;
    query?: string;
    page: number;
    perPage: number;
  }): Promise<ZohoBooksListResult>;

  /** Fetch a single record by ID from Zoho Books (with permission check). */
  getRecord(input: {
    companyId: string;
    userId: string;
    requesterEmail?: string;
    requesterAiRole?: string;
    departmentId?: string;
    departmentZohoReadScope?: string;
    organizationId?: string;
    module: 'contacts' | 'invoices';
    recordId: string;
  }): Promise<{ allowed: boolean; organizationId?: string; record?: Record<string, unknown> }>;
}

// ─── Skills ───────────────────────────────────────────────────────────────────

export interface SkillRecord {
  readonly id: string;
  readonly slug: string;
  readonly name?: string;
  readonly summary?: string;
  readonly markdown: string;
}

export interface SkillPort {
  /** Search skills visible to a company / department. */
  search(input: {
    companyId: string;
    departmentId?: string;
    query: string;
    limit: number;
  }): Promise<SkillRecord[]>;

  /** Read a single skill by ID or slug. */
  readById(input: {
    companyId: string;
    departmentId?: string;
    skillId: string;
  }): Promise<SkillRecord | null>;
}

// ─── Vector store ─────────────────────────────────────────────────────────────

export type { VectorStoreAdapter, VectorSearchResult } from '../../infrastructure/ai/vector/types';

// ─── Embedding ────────────────────────────────────────────────────────────────

/** Minimal embedding port used by the broker for query embedding. */
export interface EmbeddingPort {
  embedQuery(text: string): Promise<number[]>;
}

// ─── Web search ───────────────────────────────────────────────────────────────

export type { WebSearchService } from '../../infrastructure/ai/search/web-search.service';
