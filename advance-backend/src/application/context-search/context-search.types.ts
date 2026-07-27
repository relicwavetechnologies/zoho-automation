/**
 * Context Search Broker — shared types.
 *
 * These types are the public contract of the broker. They are used by the
 * context-search tool, by composition.ts, and by tests.
 */

// ─── Source keys ──────────────────────────────────────────────────────────────

/**
 * `web` is deliberately absent. Context search answers from what the company
 * knows; the public internet is the `webSearch` tool's job, and every role
 * already has it. Folding both behind one tool made the model's source of
 * truth depend on a boolean flag it chose itself.
 */
export type ContextSourceKey =
  | 'personalHistory'
  | 'files'
  | 'larkContacts'
  | 'zohoCrmContext'
  | 'zohoBooksLive'
  | 'workspace'
  | 'skills';

// ─── Source filter ────────────────────────────────────────────────────────────

/** Explicit source overrides for a search call. Unspecified sources use smart defaults. */
export type ContextSourceFilter = Partial<Record<ContextSourceKey, boolean>>;

// ─── Authority level ──────────────────────────────────────────────────────────

export type AuthorityLevel = 'authoritative' | 'documentary' | 'contextual' | 'public';

// ─── Search result ────────────────────────────────────────────────────────────

export interface ContextSearchResult {
  /** e.g. 'personal_history', 'files', 'zoho_crm', 'zoho_books', 'lark_contacts', 'web', 'workspace', 'skills' */
  readonly scope: string;
  /** e.g. 'chat_turn', 'file_document', 'zoho_contact', 'books_contact', 'books_invoice', 'web_result', 'workspace_file', 'skill', 'lark_contact' */
  readonly sourceType: string;
  readonly sourceId: string;
  readonly chunkIndex: number;
  /** 0–1+ similarity score (or ranking-derived) */
  readonly score: number;
  /** Plain-text excerpt, ≤ 800 chars. */
  readonly excerpt: string;
  /** Full text (only present after a fetch(), not search()). */
  readonly content?: string;
  /** Opaque reference for follow-up fetch() calls. */
  readonly chunkRef: string;
  /** Human-readable label for citations. */
  readonly sourceLabel: string;
  readonly asOf?: string;
  readonly url?: string;
  readonly title?: string;
  readonly fileName?: string;
  readonly displayName?: string;
  readonly email?: string;
  readonly organizationId?: string;
  readonly customerId?: string;
  readonly invoiceId?: string;
  readonly invoiceNumber?: string;
  readonly skillId?: string;
  readonly skillSlug?: string;
  readonly authorityLevel?: AuthorityLevel;
}

// ─── Source coverage ──────────────────────────────────────────────────────────

export interface SourceCoverageEntry {
  readonly enabled: boolean;
  readonly status: 'queried' | 'disabled' | 'unavailable' | 'error' | 'timeout';
  readonly resultCount: number;
  readonly error?: string;
}

export type SourceCoverage = Record<ContextSourceKey, SourceCoverageEntry>;

// ─── Citation ─────────────────────────────────────────────────────────────────

export interface ContextCitation {
  readonly index: number;
  readonly chunkRef: string;
  readonly scope: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly sourceLabel: string;
  readonly asOf?: string;
  readonly excerpt: string;
  readonly score: number;
  readonly url?: string;
  readonly fileName?: string;
  readonly title?: string;
}

// ─── Search input / output ────────────────────────────────────────────────────

export interface ContextSearchInput {
  /** Performing company's ID. */
  readonly companyId: string;
  /** The user running the search. */
  readonly userId: string;
  readonly requesterEmail?: string;
  /** Department context (drives Zoho read scope, skill visibility). */
  readonly departmentId?: string;
  readonly departmentZohoReadScope?: string;
  /** Filters which AI-role can see which files. */
  readonly requesterAiRole?: string;

  readonly query: string;
  /** Requested result count; clamped to 1–10. Default 5. */
  readonly limit?: number;
  /** ISO-8601 date range filter applied to timestamped sources. */
  readonly dateFrom?: string;
  readonly dateTo?: string;
  /** Explicit source overrides. When absent, smart defaults are used. */
  readonly sources?: ContextSourceFilter;
  /**
   * Restrict the file search to one indexed document.
   *
   * Without it `runFiles` has to guess which file the question is about from
   * its name — trigram scoring plus an LLM tie-break. When the caller already
   * knows the id, as it does for a file attached to the conversation, that
   * whole guess is skipped and cannot pick the wrong document.
   */
  readonly fileAssetId?: string;
  /**
   * Lark chat the search is running in. Grants access to files uploaded into
   * that chat and to nothing else — see `buildScopeShould`.
   */
  readonly larkChatId?: string;
  /** Workspace filesystem path for workspace source. */
  readonly workspacePath?: string;
  /** Per-source timeout in ms. Default 8 000 ms. */
  readonly sourceTimeoutMs?: number;
}

export interface ContextSearchOutput {
  readonly results: ContextSearchResult[];
  /** Same as results (convenience alias for older callers). */
  readonly matches: ContextSearchResult[];
  readonly resolvedEntities: Record<string, string>;
  readonly sourceCoverage: SourceCoverage;
  readonly citations: ContextCitation[];
  readonly nextFetchRefs: string[];
  readonly searchSummary: string;
}

// ─── Fetch input / output ─────────────────────────────────────────────────────

export interface ContextFetchInput {
  readonly companyId: string;
  readonly userId: string;
  readonly requesterEmail?: string;
  readonly requesterAiRole?: string;
  readonly departmentId?: string;
  readonly departmentZohoReadScope?: string;
  readonly workspacePath?: string;
  readonly chunkRef: string;
}

export interface ContextFetchOutput {
  readonly chunkRef: string;
  readonly scope: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly chunkIndex: number;
  readonly text: string;
  readonly resolvedEntities: Record<string, string>;
}
