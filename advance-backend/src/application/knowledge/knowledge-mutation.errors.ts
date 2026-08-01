export type KnowledgeMutationErrorCode =
  | 'invalid_request'
  | 'policy_missing'
  | 'policy_disabled'
  | 'policy_invalid'
  | 'policy_changed'
  | 'not_found'
  | 'conflict'
  | 'permission_denied'
  | 'review_required'
  | 'approval_required'
  | 'approval_mismatch'
  | 'stale_version'
  | 'invalid_state'
  | 'storage_failure';

export class KnowledgeMutationError extends Error {
  constructor(
    readonly code: KnowledgeMutationErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'KnowledgeMutationError';
  }
}
