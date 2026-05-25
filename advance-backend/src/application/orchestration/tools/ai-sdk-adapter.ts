/**
 * ai-sdk-adapter — bridges our Result<T,E> Tool contract to the Vercel AI SDK
 * tool() format. This is the ONLY place where our typed Result layer is
 * flattened into strings that the LLM can interpret.
 *
 * Failures become string envelopes:
 *   - permission_denied: <reason>
 *   - approval_pending: <reason>   (HITL gate fired, manager notified)
 *   - approval_misconfigured: <reason>
 *   - error: <reason>
 *
 * The supervisor LLM reads these and decides how to respond.
 */

import { dynamicTool } from 'ai';
import type { ToolSet } from 'ai';
import type { Tool as AppTool, ToolExecutionContext } from './tool.contract';
import type { Logger } from '../../../shared/logger';
import type { Clock } from '../../../shared/clock';
import type { PermissionResult } from '../../permissions/permission.types';
import type { RunContext } from '../../../domain/orchestration/run-context';
import type { ApprovalGateService } from '../../approval/approval-gate.service';
import { formatAmount, formatDate } from '../../zoho/zoho-format.utils';

export interface AdapterContext {
  runContext:    RunContext;
  perm:          PermissionResult;
  logger:        Logger;
  clock:         Clock;
  /** When provided, non-read actions are routed through the approval gate. */
  approvalGate?: ApprovalGateService;
  /** Lark chat_id — required for the approval gate idempotency key. */
  chatId?:       string;
  /** Live progress callback — tool updates flow to the user's status bubble. */
  onProgress?:   ((message: string) => void) | undefined;
}

export function toAISdkTool(
  t: AppTool<unknown, unknown>,
  adapterCtx: AdapterContext,
) {
  const ctx: ToolExecutionContext = {
    runContext:    adapterCtx.runContext,
    perm:          adapterCtx.perm,
    correlationId: t.id,
    logger:        adapterCtx.logger.child({ toolId: t.id }),
    clock:         adapterCtx.clock,
    ...(adapterCtx.onProgress ? { onProgress: adapterCtx.onProgress } : {}),
  };

  const description = t.parameterDocs
    ? `${t.description}\n${t.parameterDocs}`
    : t.description;

  return dynamicTool({
    description,
    inputSchema: t.argsSchema as never,
    execute: async (args: unknown): Promise<string> => {
      // ── Permission check ───────────────────────────────────────────────
      const permCheck = t.permissionCheck(args, adapterCtx.perm);
      if (!permCheck.ok) {
        adapterCtx.logger.warn('ai_sdk_adapter.permission_denied', {
          toolId: t.id,
          reason: permCheck.error.message,
        });
        return `permission_denied: ${permCheck.error.message}`;
      }

      const action = permCheck.value;

      // ── Approval gate ──────────────────────────────────────────────────
      if (adapterCtx.approvalGate && adapterCtx.chatId) {
        const argsSummary = buildArgsSummary(t.id, action, args);
        const decision = await adapterCtx.approvalGate.check({
          toolId:      t.id,
          action,
          args,
          perm:        adapterCtx.perm,
          runContext:  adapterCtx.runContext,
          chatId:      adapterCtx.chatId,
          argsSummary,
        });

        if (decision.kind === 'pending') {
          adapterCtx.logger.info('ai_sdk_adapter.approval_pending', {
            toolId:     t.id,
            action,
            approvalId: decision.approvalId,
          });
          return `approval_pending: ${decision.message}`;
        }

        if (decision.kind === 'misconfigured') {
          adapterCtx.logger.warn('ai_sdk_adapter.approval_misconfigured', {
            toolId: t.id,
            action,
            reason: decision.message,
          });
          return `approval_misconfigured: ${decision.message}`;
        }

        // decision.kind === 'allowed' → fall through to execute
      }

      // ── Execute ────────────────────────────────────────────────────────
      const result = await t.execute(args, ctx);
      if (!result.ok) {
        adapterCtx.logger.warn('ai_sdk_adapter.tool_error', {
          toolId: t.id,
          reason: result.error.message,
        });
        return `error: ${result.error.message}`;
      }

      const val = result.value;
      return typeof val === 'string' ? val : JSON.stringify(val);
    },
  });
}

/**
 * Convert an array of AppTool into the AI SDK ToolSet,
 * keyed by tool ID, filtered to the provided set of IDs.
 */
export function toAISdkTools(
  tools: ReadonlyArray<AppTool<unknown, unknown>>,
  ctx: AdapterContext,
  filterIds?: ReadonlySet<string>,
): ToolSet {
  const filtered = filterIds
    ? tools.filter(t => filterIds.has(t.id))
    : tools;

  return Object.fromEntries(
    filtered.map(t => [t.id, toAISdkTool(t, ctx)]),
  ) as unknown as ToolSet;
}

export function buildArgsSummary(toolId: string, action: string, args: unknown): string {
  try {
    const a = args as Record<string, unknown>;
    if (toolId === 'googleGmail') return buildGmailArgsSummary(action, a);
    const parts: string[] = [`${toolId}.${action}`];
    // Append the most human-readable fields if present
    for (const key of ['to', 'subject', 'title', 'name', 'query', 'module', 'chatId', 'calendarId']) {
      if (a[key] !== undefined) {
        const val = String(a[key]).slice(0, 80);
        parts.push(`${key}=${val}`);
      }
    }
    if (toolId === 'zohoBooks') {
      const fields = a['fields'] && typeof a['fields'] === 'object' && !Array.isArray(a['fields'])
        ? a['fields'] as Record<string, unknown>
        : {};
      const merged = { ...fields, ...a };
      const currency = typeof merged['currency_code'] === 'string' ? merged['currency_code'] : 'USD';
      for (const key of ['customer_name', 'vendor_name', 'invoice_id', 'bill_id', 'expense_id']) {
        if (merged[key] !== undefined) parts.push(`${key}=${String(merged[key]).slice(0, 80)}`);
      }
      for (const key of ['amount', 'total', 'balance']) {
        const raw = merged[key];
        const amount = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
        if (Number.isFinite(amount)) parts.push(`${key}=${formatAmount(amount, currency)}`);
      }
      for (const key of ['date', 'due_date', 'payment_date']) {
        if (typeof merged[key] === 'string') parts.push(`${key}=${formatDate(merged[key])}`);
      }
    }
    return parts.join(' | ');
  } catch {
    return `${toolId}.${action}`;
  }
}

function buildGmailArgsSummary(action: string, a: Record<string, unknown>): string {
  const op = typeof a['op'] === 'string' ? a['op'] : action;
  const parts: string[] = [`googleGmail.${op}`];
  const to = stringArray(a['to']);
  const cc = stringArray(a['cc']);
  const bcc = stringArray(a['bcc']);
  const subject = typeof a['subject'] === 'string' ? a['subject'] : undefined;
  const body = typeof a['bodyText'] === 'string'
    ? a['bodyText']
    : typeof a['body'] === 'string'
      ? a['body']
      : '';
  const messageCount = stringArray(a['messageIds']).length + (typeof a['messageId'] === 'string' ? 1 : 0);

  if (to.length) parts.push(`to=${to.join(', ').slice(0, 120)}`);
  if (cc.length) parts.push(`cc=${cc.length}`);
  if (bcc.length) parts.push(`bcc=${bcc.length}`);
  if (subject) parts.push(`subject=${subject.slice(0, 120)}`);
  if (body) parts.push(`preview=${body.replace(/\s+/g, ' ').slice(0, 180)}`);
  if (typeof a['bodyHtml'] === 'string') parts.push('html=yes');
  if (typeof a['templateId'] === 'string') parts.push(`template=${a['templateId']}`);
  if (typeof a['draftId'] === 'string') parts.push('draft=yes');
  if (messageCount > 0) parts.push(`messages=${messageCount}`);
  const attachments = Array.isArray(a['attachments']) ? a['attachments'] : [];
  if (attachments.length) {
    parts.push(`attachments=${attachments.length}`);
    const sources = Array.from(new Set(
      attachments
        .map(attachment => attachment && typeof attachment === 'object' && !Array.isArray(attachment)
          ? (attachment as Record<string, unknown>)['source']
          : undefined)
        .filter((source): source is string => typeof source === 'string' && source.length > 0),
    ));
    if (sources.length) parts.push(`sources=${sources.join(',')}`);
  }

  const labels = [...stringArray(a['labelNames']), ...stringArray(a['labelIds'])];
  if (labels.length) parts.push(`labels=${labels.join(', ').slice(0, 120)}`);

  return parts.join(' | ');
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
