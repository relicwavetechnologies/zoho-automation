import type { CompanyId, DepartmentId, UserId } from '../../shared/ids';
import type { CompanyRoleSlug } from '../permissions/company-role';
import type { ChannelKey } from '../channel/incoming-message';
import type { ToolActionGroup } from '../permissions/tool-action-group';

export interface ApprovalGrant {
  readonly approvalId: string;
  readonly toolId:     string;
  readonly action:     ToolActionGroup;
  readonly argsHash:   string;
}

export interface RunContext {
  readonly companyId: CompanyId;
  readonly userId: UserId;
  readonly companyRole: CompanyRoleSlug;
  readonly departmentId?: DepartmentId;
  readonly channel: ChannelKey;
  readonly tenantId?: string;
  /** The requester's email address (used for Zoho CRM scoping). */
  readonly requesterEmail?: string;
  /** The Zoho Books read scope for the requester's department. */
  readonly departmentZohoReadScope?: string;
  /** The company-level AI role slug (e.g. 'MEMBER', 'ADMIN'). */
  readonly requesterAiRole?: string;
  /** Absolute path to a mounted workspace directory (desktop channel). */
  readonly workspacePath?: string;
  /**
   * Unique trace identifier for this orchestration run.
   * Generated at the channel-adapter ingest boundary; propagated through
   * every sub-system so all log lines and DB events correlate to one request.
   */
  readonly traceId?: string;
  /**
   * Deduplication key supplied by the inbound message.
   * Used by ExecutionRun.requestId to prevent double-processing.
   */
  readonly requestId?: string;
  /**
   * The requester's external channel ID (e.g. Lark open_id).
   * Passed to tools so they can self-assign tasks/events to the requester
   * without needing a separate DB lookup.
   */
  readonly userExternalId?: string;
  /**
   * Exact Lark open_ids explicitly mentioned in the inbound message.
   * Backend adapters own this list; tools may use it to avoid fuzzy person
   * resolution but must not treat it as a permission or approval grant.
   */
  readonly mentionedLarkOpenIds?: ReadonlyArray<string>;
  /**
   * Approval grants issued by a manager.
   * The approval gate checks this list before sending a new approval request.
   * A grant is valid only when argsHash matches the tool call args.
   */
  readonly approvalGrants?: ReadonlyArray<ApprovalGrant>;
  /**
   * The Lark chat_id for this run's conversation.
   * Used for actual Lark delivery and chat-scoped provider operations.
   */
  readonly chatId?: string;
  /** Immutable Lark reply target retained across deferred approval execution. */
  readonly replyToMessageId?: string;
  /** Whether Lark should keep deferred delivery inside the originating thread. */
  readonly replyInThread?: boolean;
  /**
   * Marks headless scheduled execution so conversation history and background
   * memory work are skipped, and delegates the final response to a dedicated
   * runtime adapter — the creator's Lark DM, which is where every scheduled
   * result goes. A run carrying this must not deliver anywhere itself.
   */
  readonly deliveryMode?: 'scheduled_runtime_delivery';
  /**
   * The backend-issued runtime run this call belongs to.
   *
   * A deferred OAuth continuation needs the inbound Lark request that started
   * the run — who asked, in which chat, replying to which message — and none of
   * that survives the trip through the container. This ID is the key the
   * backend uses to look that origin back up; it is never accepted from model
   * arguments, and is absent for any run that did not come from a channel
   * ingress (a desktop session, for instance).
   */
  readonly runtimeRunId?: string;
  /**
   * Backend-issued tool IDs that triggered a deferred OAuth continuation.
   * The fresh run intersects these with current RBAC before treating them as
   * resolved; callers and model arguments cannot grant tool access here.
   */
  readonly continuationToolIds?: ReadonlyArray<string>;
}
