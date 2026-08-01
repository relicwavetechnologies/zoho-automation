export const KNOWLEDGE_DOCUMENT_PARSER_VERSION = 'layout-v1';

export interface ParsedKnowledgeUnit {
  readonly text: string;
  readonly pageNumber?: number;
  readonly sectionPath?: readonly string[];
}

export interface ParsedKnowledgeDocument {
  readonly units: readonly ParsedKnowledgeUnit[];
  readonly pageCount?: number;
  readonly warnings: readonly string[];
  readonly parserVersion: string;
}

export interface KnowledgeDocumentParser {
  parse(input: {
    readonly buffer: Buffer;
    readonly fileName: string;
    readonly mimeType: string;
    readonly signal: AbortSignal;
  }): Promise<ParsedKnowledgeDocument>;
}

export interface KnowledgeDocumentChunkInput {
  readonly ordinal: number;
  readonly text: string;
  readonly textHash: string;
  readonly charCount: number;
  readonly tokenEstimate: number;
  readonly pageStart?: number;
  readonly pageEnd?: number;
  readonly sectionPath: readonly string[];
}

export interface KnowledgeDocumentSemanticCandidate {
  readonly resourceId: string;
  readonly resourceVersion: number;
  readonly chunkOrdinal: number;
  readonly score: number;
  readonly scope: 'personal' | 'department' | 'company';
  readonly departmentName?: string;
}

export interface KnowledgeDocumentSemanticIndex {
  projectDocument(input: {
    readonly resourceId: string;
    readonly resourceVersion: number;
    readonly fileName: string;
    readonly scope: 'personal' | 'department' | 'company';
    readonly companyId: string;
    readonly ownerUserId?: string;
    readonly departmentId?: string;
    readonly chunks: readonly KnowledgeDocumentChunkInput[];
  }): Promise<void>;

  removeDocument(input: {
    readonly resourceId: string;
    readonly resourceVersion: number;
    readonly chunkCount: number;
    readonly scope: 'personal' | 'department' | 'company';
    readonly companyId: string;
    readonly ownerUserId?: string;
    readonly departmentId?: string;
  }): Promise<void>;

  searchDocuments(input: {
    readonly query: string;
    readonly userId: string;
    readonly companyId: string;
    readonly departments: readonly { readonly id: string; readonly name: string }[];
    readonly limit: number;
  }): Promise<{
    readonly candidates: readonly KnowledgeDocumentSemanticCandidate[];
    readonly status: 'available' | 'partial' | 'unavailable';
  }>;
}
