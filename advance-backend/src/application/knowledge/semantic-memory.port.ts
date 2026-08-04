import type { KnowledgeScopeKind } from '../../domain/knowledge/knowledge-scope';

export type MemoryScope = KnowledgeScopeKind;

export type MemoryRecallScopeStatus = 'searched' | 'failed';
export type MemoryRecallStatus = 'available' | 'partial' | 'unavailable';

export interface MemoryRecallDepartment {
  readonly id: string;
  readonly name: string;
}

export type MemoryRecallFact =
  | { readonly scope: 'personal'; readonly text: string; readonly resourceId?: string }
  | { readonly scope: 'department'; readonly text: string; readonly department: { readonly name: string }; readonly resourceId?: string }
  | { readonly scope: 'company'; readonly text: string; readonly resourceId?: string };

export interface MemoryRecallResult {
  readonly facts: MemoryRecallFact[];
  readonly coverage: {
    readonly personal: MemoryRecallScopeStatus;
    readonly departments: { readonly searched: number; readonly failed: number };
    readonly company: MemoryRecallScopeStatus;
  };
  readonly status: MemoryRecallStatus;
}

export interface MemoryService {
  searchForRecall(params: {
    query: string;
    userId: string;
    companyId: string;
    departments: readonly MemoryRecallDepartment[];
    departmentPreferences?: readonly string[];
    limit: number;
    maxFactChars: number;
    maxTotalChars: number;
    /** Shared audiences must set this false so personal storage is never queried. */
    includePersonal?: boolean;
  }): Promise<MemoryRecallResult>;

  getPersonalSnapshot(params: {
    userId: string;
    companyId: string;
    limit: number;
    maxFactChars: number;
    maxTotalChars: number;
  }): Promise<string[]>;

  /** Idempotent semantic projection of one authoritative knowledge resource. */
  projectExplicitResource(params: {
    resourceId: string;
    facts: readonly string[];
    previousFactCount: number;
    scope: MemoryScope;
    userId: string;
    companyId: string;
    departmentId?: string;
  }): Promise<void>;

  /** Remove only the semantic documents owned by one authoritative resource. */
  removeProjectedResource(params: {
    resourceId: string;
    factCount: number;
    scope: MemoryScope;
    userId: string;
    companyId: string;
    departmentId?: string;
  }): Promise<void>;

}
