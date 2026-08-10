import type { ZodType } from 'zod';
import type { Result } from '../../shared/result';
import type { PermissionError, ToolError } from '../../shared/errors';
import type { Logger } from '../../shared/logger';
import type { Clock } from '../../shared/clock';
import type { ToolId } from '../../shared/ids';
import type { ToolFamily } from '../../domain/tools/tool-id';
import type { ToolActionGroup } from '../../domain/permissions/tool-action-group';
import type { PermissionResult } from '../permissions/permission.types';
import type { RunContext } from '../../domain/orchestration/run-context';

// ─── Tool execution context ────────────────────────────────────────────────

export interface ToolExecutionContext {
  readonly runContext: RunContext;
  readonly perm: PermissionResult;
  /**
   * Trusted backend transport audience. Only the signed Cloud-Pi local broker
   * may request `local_file`; model-facing calls leave this unset.
   */
  readonly resultAudience?: 'local_file';
  readonly correlationId: string;
  readonly logger: Logger;
  readonly clock: Clock;
  /**
   * Backend-issued, single-use proof that the exact invocation was approved
   * and atomically claimed. Tools with an approval invariant must fail closed
   * when this proof is absent or has the wrong authority.
   */
  readonly approvalGrant?: {
    readonly approvalId: string;
    readonly authority: 'connection_owner' | 'company_admin' | 'department_manager';
  };
  /** Parent run cancellation; tools that support abortable I/O should pass it downstream. */
  readonly abortSignal?: AbortSignal;
  /** Optional callback to push live progress updates to the user's status bubble. */
  readonly onProgress?: ((message: string) => void) | undefined;
}

// ─── The Tool contract ─────────────────────────────────────────────────────

export interface Tool<TArgs, TOut> {
  /** Canonical tool ID (e.g. 'larkTask'). Must match domain/tools/tool-id.ts. */
  readonly id: ToolId;
  readonly family: ToolFamily;
  /** All action groups this tool supports (superset of what any one call may do). */
  readonly actionGroups: ReadonlySet<ToolActionGroup>;
  /** Zod schema for argument validation. */
  readonly argsSchema: ZodType<TArgs>;
  /** Zod schema for return value validation. */
  readonly resultSchema: ZodType<TOut>;
  /** Short description for LLM tool-choice prompt. */
  readonly description: string;
  /** Detailed parameter documentation for the LLM. */
  readonly parameterDocs: string;

  /**
   * Pre-execution permission check.
   * Returns the action group being performed (for logging) or PermissionError.
   * Called by the executor before execute().
   */
  permissionCheck(
    args: TArgs,
    perm: PermissionResult,
  ): Result<ToolActionGroup, PermissionError>;

  /**
   * Optional side-effect-free readiness check. Implementations may validate an
   * upstream/native schema and connection eligibility, but must never execute
   * the requested mutation or create an approval intent.
   */
  preflight?(
    args: TArgs,
    ctx: ToolExecutionContext,
  ): Promise<Result<Record<string, unknown>, ToolError>>;

  /**
   * Execute the tool.
   * Must NEVER throw — always return Result<TOut, ToolError>.
   */
  execute(
    args: TArgs,
    ctx: ToolExecutionContext,
  ): Promise<Result<TOut, ToolError>>;
}
