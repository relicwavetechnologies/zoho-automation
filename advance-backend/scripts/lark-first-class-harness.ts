#!/usr/bin/env tsx
/**
 * End-to-end Lark first-class capability harness.
 *
 * Usage:
 *   pnpm tsx scripts/lark-first-class-harness.ts --company-id <uuid> --chat-id <oc_...> --recipient "Name or email" --execute
 *
 * Without --execute it prints the resolved context and planned operations.
 * With --execute it performs real Lark API calls, cleans up task/calendar test
 * objects, creates a doc, and sends a summary to --chat-id when provided.
 */

import 'dotenv/config';
import { LarkContactsClient } from '../src/infrastructure/channels/lark/clients/lark-contacts.client';
import { LarkTaskClient } from '../src/infrastructure/channels/lark/clients/lark-task.client';
import { LarkCalendarClient } from '../src/infrastructure/channels/lark/clients/lark-calendar.client';
import { LarkDocClient } from '../src/infrastructure/channels/lark/clients/lark-doc.client';
import { LarkToolMessagingClient } from '../src/infrastructure/channels/lark/clients/lark-messaging.client';
import { getPrismaClient, disconnectPrisma } from '../src/infrastructure/persistence/prisma.client';
import { decryptToken } from '../src/infrastructure/shared/token.crypto';
import { LarkOAuthService } from '../src/infrastructure/lark/lark-oauth.service';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const execute = process.argv.includes('--execute');
const companyId = arg('--company-id');
const chatId = arg('--chat-id');
const recipient = arg('--recipient');
const cleanup = !process.argv.includes('--keep-created');

const appId = process.env['LARK_APP_ID'];
const appSecret = process.env['LARK_APP_SECRET'];
const encryptionKey = process.env['ZOHO_TOKEN_ENCRYPTION_KEY'];

if (!appId || !appSecret) throw new Error('LARK_APP_ID and LARK_APP_SECRET are required');
if (!encryptionKey) throw new Error('ZOHO_TOKEN_ENCRYPTION_KEY is required');

async function resolveCompanyId(): Promise<string> {
  if (companyId) return companyId;
  const prisma = getPrismaClient();
  const link = await (prisma as any).larkUserAuthLink.findFirst({
    where: { revokedAt: null },
    orderBy: [{ lastUsedAt: 'desc' }, { updatedAt: 'desc' }],
    select: { companyId: true },
  });
  if (!link?.companyId) throw new Error('No Lark user auth link found; pass --company-id');
  return link.companyId as string;
}

async function resolveUserToken(inputCompanyId: string): Promise<{ token: string; email?: string; openId?: string }> {
  const prisma = getPrismaClient();
  const link = await (prisma as any).larkUserAuthLink.findFirst({
    where: { companyId: inputCompanyId, revokedAt: null },
    orderBy: [{ lastUsedAt: 'desc' }, { updatedAt: 'desc' }],
    select: {
      accessTokenEncrypted: true,
      refreshTokenEncrypted: true,
      accessTokenExpiresAt: true,
      larkEmail: true,
      larkOpenId: true,
    },
  });
  if (!link?.accessTokenEncrypted) throw new Error(`No active Lark user token for company ${inputCompanyId}`);
  const expiresAt = link.accessTokenExpiresAt ? new Date(link.accessTokenExpiresAt) : null;
  if (expiresAt && expiresAt.getTime() < Date.now() + 60_000) {
    if (!link.refreshTokenEncrypted) {
      throw new Error(`Lark user token is expired at ${expiresAt.toISOString()} and no refresh token is stored; reconnect Lark first`);
    }
    const refreshToken = decryptToken(link.refreshTokenEncrypted, encryptionKey!);
    const oauth = new LarkOAuthService(
      appId!,
      appSecret!,
      process.env['LARK_OAUTH_REDIRECT_URI'] ?? `${process.env['BACKEND_PUBLIC_URL'] ?? 'http://localhost:3000'}/api/lark/auth/callback`,
      process.env['LARK_API_BASE_URL'] ?? 'https://open.larksuite.com',
    );
    const refreshed = await oauth.refreshUserToken(refreshToken);
    return {
      token: refreshed.accessToken,
      ...(refreshed.larkEmail ?? link.larkEmail ? { email: refreshed.larkEmail ?? link.larkEmail as string } : {}),
      ...(refreshed.larkOpenId ?? link.larkOpenId ? { openId: refreshed.larkOpenId ?? link.larkOpenId as string } : {}),
    };
  }
  return {
    token: decryptToken(link.accessTokenEncrypted, encryptionKey!),
    ...(link.larkEmail ? { email: link.larkEmail as string } : {}),
    ...(link.larkOpenId ? { openId: link.larkOpenId as string } : {}),
  };
}

function tomorrowWindow(): { start: string; end: string } {
  const start = new Date(Date.now() + 24 * 60 * 60 * 1000);
  start.setUTCHours(5, 0, 0, 0);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

async function main(): Promise<void> {
  const resolvedCompanyId = await resolveCompanyId();
  const user = await resolveUserToken(resolvedCompanyId);
  const tenantDeps = { appId: appId!, appSecret: appSecret! };
  const userDeps = { ...tenantDeps, userToken: user.token };

  console.log('=== Lark first-class harness ===');
  console.log(`companyId: ${resolvedCompanyId}`);
  console.log(`user:      ${user.email ?? user.openId ?? 'resolved token'}`);
  console.log(`recipient: ${recipient ?? '(none)'}`);
  console.log(`chatId:    ${chatId ?? '(summary send skipped)'}`);
  console.log(`execute:   ${execute}`);

  const contacts = new LarkContactsClient(userDeps);
  const task = new LarkTaskClient(userDeps);
  const calendar = new LarkCalendarClient(userDeps);
  const docs = new LarkDocClient(tenantDeps);
  const messaging = new LarkToolMessagingClient(tenantDeps);

  const recipientMatches = recipient
    ? await contacts.searchUsers({ query: recipient, limit: 10, excludeExternalUsers: true })
    : [];
  const selectedRecipient = recipientMatches.length === 1 ? recipientMatches[0] : undefined;

  console.log(`contacts:  ${recipient ? `${recipientMatches.length} match(es)` : 'skipped'}`);
  for (const match of recipientMatches) {
    console.log(`  - ${match.displayName} ${match.enterpriseEmail ?? match.email ?? ''} ${match.department ?? ''} ${match.openId}`);
  }

  if (!execute) {
    console.log('\nPlanned with --execute: create/update/get/delete task, create/update/get/delete calendar event, create markdown doc with URL, send summary to chat.');
    return;
  }

  const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const summary: string[] = [];

  const assigneeIds = selectedRecipient ? [selectedRecipient.openId] : user.openId ? [user.openId] : [];
  const createdTask = await task.createTask({
    title: `[Divo Harness] Lark tools smoke ${stamp}`,
    notes: 'Created by scripts/lark-first-class-harness.ts',
    dueDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    ...(assigneeIds.length ? { assigneeIds } : {}),
  });
  await task.updateTask(createdTask.taskId, { title: `[Divo Harness] Lark tools smoke ${stamp} updated` });
  const fetchedTask = await task.getTask(createdTask.taskId);
  await task.completeTask(createdTask.taskId);
  if (cleanup) await task.deleteTask(createdTask.taskId);
  summary.push(`Task CRUD: ${fetchedTask.title} (${createdTask.taskId})${cleanup ? ' cleaned up' : ''}`);

  const window = tomorrowWindow();
  const event = await calendar.createEvent('primary', {
    title: `[Divo Harness] Lark calendar smoke ${stamp}`,
    startTime: window.start,
    endTime: window.end,
    description: 'Created by scripts/lark-first-class-harness.ts',
    ...(assigneeIds.length ? { attendeeIds: assigneeIds } : {}),
  });
  await calendar.updateEvent('primary', event.eventId, { summary: `[Divo Harness] Lark calendar smoke ${stamp} updated` });
  const fetchedEvent = await calendar.getEvent('primary', event.eventId) as Record<string, unknown>;
  if (cleanup) await calendar.deleteEvent('primary', event.eventId);
  summary.push(`Calendar CRUD: ${String(fetchedEvent['summary'] ?? event.eventId)} (${event.eventId})${cleanup ? ' cleaned up' : ''}`);

  const doc = await docs.createMarkdownDoc(`[Divo Harness] Lark docs smoke ${stamp}`, [
    '# Lark Tools Harness',
    '',
    `- Company: ${resolvedCompanyId}`,
    `- User: ${user.email ?? user.openId ?? 'unknown'}`,
    `- Recipient matches: ${recipientMatches.length}`,
    '',
    '## Checks',
    '',
    '- Contact resolution',
    '- Task CRUD',
    '- Calendar CRUD',
    '- Markdown doc creation',
    '- Message delivery',
  ].join('\n'));
  summary.push(`Doc create_markdown: ${doc.url ?? doc.docUrl ?? doc.docToken}`);

  if (chatId) {
    const msg = await messaging.sendMessage(chatId, `Divo Lark harness passed:\n${summary.map(item => `- ${item}`).join('\n')}`);
    summary.push(`Message delivery: ${msg.messageId}`);
  }

  console.log('\nResults:');
  for (const item of summary) console.log(`- ${item}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectPrisma().catch(() => {});
  });
