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
   * Approval grants issued by a manager.
   * The gate in ai-sdk-adapter checks this list before sending a new approval request.
   * A grant is valid only when argsHash matches the tool call args.
   */
  readonly approvalGrants?: ReadonlyArray<ApprovalGrant>;
  /**
   * The Lark chat_id for this run's conversation.
   * Used by the approval gate for idempotency keying and card delivery.
   */
  readonly chatId?: string;
  /**
   * When set, outbound delivery must stay locked to the current conversation.
   * Used by scheduled workflows so "deliver to current chat" cannot be rerouted
   * by an LLM to another chat or group.
   */
  readonly deliveryMode?: 'current_chat_only';
}
