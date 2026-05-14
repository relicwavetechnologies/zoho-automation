import { Router, type Request, type Response } from 'express';
import type { LarkChannelAdapter } from './lark.adapter';
import type { OrchestrationEngine } from '../../../application/orchestration/engine/core';
import type { ChannelIdentityRepoPort } from '../../persistence/channel-identity.repository';
import type { ConversationRepoPort } from '../../persistence/conversation.repository';
import type { Logger } from '../../../shared/logger';
import type { TypedEnv } from '../../../config/env';
import type { ApprovalGateService } from '../../../application/approval/approval-gate.service';
import type { LarkApprovalCardHandler } from './lark-approval-card.handler';
import type { IngestionQueue } from '../../../application/ingestion/ingestion.queue';
import type { ShareResolverService } from '../../../application/knowledge-share/share-resolver.service';
import type { KnowledgeShareService } from '../../../application/knowledge-share/knowledge-share.service';
import type { ChatMessageSerializer } from '../../../application/orchestration/chat-message-serializer';
import type { Mem0Service } from '../../../application/memory/mem0.service';
import type { LarkOAuthService } from '../../lark/lark-oauth.service';
import type { LarkUserAuthLinkRepository } from '../../persistence/lark-user-auth-link.repository';
import type { CachePort } from '../../../shared/cache';
import { asCompanyId, asUserId, asCorrelationId, asDepartmentId } from '../../../shared/ids';
import { asCompanyRoleSlug } from '../../../domain/permissions/company-role';
import type { ConversationHandle } from '../../../application/channels/channel.adapter';
import type { IncomingMessage } from '../../../domain/channel/incoming-message';
import {
  verifyLarkWebhookRequest,
  maybeDecryptLarkBody,
} from './lark-security';
import { parseLarkAttachments, type LarkAttachment } from './lark-attachment.parser';
import type { InlineContextResult } from './lark-inline-context';
import type { LarkChatContextService } from '../../../application/chat-context/lark-chat-context.service';
import type { PrismaClient } from '../../../generated/prisma';
import type { GroupChatAttachmentContext } from '../../../domain/conversation/group-context';
import type { CloudinaryAdapter } from '../../cloudinary/cloudinary.adapter';

export const createLarkWebhookRoutes = (deps: {
  adapter: LarkChannelAdapter;
  engine: OrchestrationEngine;
  channelIdentityRepo: ChannelIdentityRepoPort;
  conversationRepo: ConversationRepoPort;
  logger: Logger;
  env: TypedEnv;
  approvalGate?: ApprovalGateService;
  approvalCardHandler?: LarkApprovalCardHandler;
  ingestionQueue?: IngestionQueue;
  knowledgeShareService?: KnowledgeShareService;
  shareResolverService?: ShareResolverService;
  mem0?: Mem0Service;
  larkOAuthService?:     LarkOAuthService;
  larkUserAuthLinkRepo?: LarkUserAuthLinkRepository;
  cache: CachePort;
  /** Per-chat message serializer — ensures only one engine.run() per chat at a time. */
  serializer: ChatMessageSerializer;
  chatContextService?: LarkChatContextService;
  prisma?: PrismaClient;
  cloudinaryAdapter?: CloudinaryAdapter;
}): Router => {
  const router = Router();
  const log = deps.logger.child({ route: 'lark-webhook' });

  // Build the security config once from env — avoids repeated property access per request.
  const securityConfig = {
    ...(deps.env.LARK_WEBHOOK_SIGNING_SECRET ? { signingSecret:     deps.env.LARK_WEBHOOK_SIGNING_SECRET } : {}),
    ...(deps.env.LARK_VERIFICATION_TOKEN     ? { verificationToken: deps.env.LARK_VERIFICATION_TOKEN }     : {}),
    ...(deps.env.LARK_WEBHOOK_MAX_SKEW_SECONDS !== undefined ? { maxSkewSeconds: deps.env.LARK_WEBHOOK_MAX_SKEW_SECONDS } : {}),
  };
  const encryptKey = deps.env.LARK_ENCRYPT_KEY;

  // ── Lark URL verification challenge + event handler ───────────────────────
  // Lark sends all events to /events — the base path (/) handles only the
  // initial URL verification challenge that Lark fires when you first save
  // the webhook URL in the developer console.
  // Shared handler for both /events and /card endpoints.
  const handlePost = (req: Request, res: Response): void => {
    // ── Step 1: Signature / token verification ──────────────────────────────
    const verifyResult = verifyLarkWebhookRequest(
      {
        headers:    req.headers as Record<string, string | string[] | undefined>,
        rawBody:    (req as Request & { rawBody?: string }).rawBody ?? '',
        parsedBody: req.body as unknown,
      },
      securityConfig,
    );

    if (!verifyResult.ok) {
      log.warn('webhook.security.rejected', {
        reason: verifyResult.reason,
        path:   req.path,
        bodyKeys: req.body && typeof req.body === 'object'
          ? Object.keys(req.body as Record<string, unknown>) : [],
      });
      res.status(401).json({ error: 'unauthorized', reason: verifyResult.reason });
      return;
    }

    // ── Step 2: AES-256-CBC decryption (when encryption is enabled on Lark app) ──
    let body: unknown = req.body;
    try {
      body = maybeDecryptLarkBody(body, encryptKey);
    } catch (e) {
      log.error('webhook.decrypt.failed', { error: String(e) });
      res.status(400).json({ error: 'decrypt_failed' });
      return;
    }

    const event = body as Record<string, unknown>;

    // ── Step 3: URL-verification challenge handshake ────────────────────────
    if (event['challenge']) {
      res.json({ challenge: event['challenge'] });
      return;
    }

    // Diagnostic — log shape so we can tell card-click vs message-event shapes apart
    const eventHeader   = event['header'] as Record<string, unknown> | undefined;
    const headerType    = eventHeader?.['event_type'] as string | undefined;
    const topLevelAction = (event['action'] as Record<string, unknown> | undefined);
    log.info('webhook.received', {
      path:       req.path,
      headerType: headerType ?? null,
      hasAction:  !!topLevelAction,
      topKeys:    Object.keys(event).slice(0, 12),
    });

    // ── Step 4a: Card action trigger (approval decisions) ────────────────────
    // Two shapes:
    //   • Card 2.0:  { header: { event_type: 'card.action.trigger' }, event: {...} }
    //   • Card 1.0:  { action: { value, tag }, open_id, user_id, ... }   (top-level)
    const isCard20Click = headerType === 'card.action.trigger';
    const isCard10Click = !headerType && !!topLevelAction && typeof topLevelAction === 'object';
    if (isCard20Click || isCard10Click) {
      const cardEvent = isCard20Click ? (event['event'] as unknown) : event;

      // Check share actions first
      if (deps.shareResolverService?.isShareAction(cardEvent)) {
        void (async () => {
          try {
            const result = await deps.shareResolverService!.handle(cardEvent);
            res.status(200).json(result.responseBody);
          } catch (e) {
            log.error('webhook.share_action.error', { error: String(e) });
            res.status(200).json({ ok: true });
          }
        })();
        return;
      }

      if (deps.approvalCardHandler) {
        const handler = deps.approvalCardHandler;
        void (async () => {
          try {
            const result = await handler.handle(cardEvent);
            res.status(200).json(result.responseBody ?? { ok: true });
          } catch (e) {
            log.error('webhook.card_action.error', { error: String(e) });
            res.status(200).json({ ok: true });
          }
        })();
        return;
      }
      return;
    }

    // ── Step 4b: Parse the incoming message event ────────────────────────────
    const parseResult = deps.adapter.parseIncoming(event);
    if (!parseResult.ok) {
      log.warn('webhook.parse.failed', { reason: parseResult.error.payload.reason });
      res.status(200).json({ ok: false }); // always 200 to Lark after challenge
      return;
    }

    const incoming = parseResult.value;

    // Skip bot messages
    const eventData = event['event'] as Record<string, unknown> | undefined;
    const sender     = eventData?.['sender'] as Record<string, unknown> | undefined;
    const senderType = sender?.['sender_type'] as string | undefined;
    if (senderType === 'bot') {
      res.status(200).json({ ok: true });
      return;
    }

    // ── Step 5: Respond immediately to Lark (5s timeout requirement) ─────────
    res.status(200).json({ ok: true });

    // ── Step 6: Enqueue for per-chat sequential processing ────────────────────
    // serializer.run() returns immediately. The task will start after any
    // currently-running task for this chatId completes — so two simultaneous
    // prompts in the same group are processed one at a time, in arrival order.
    // The AbortSignal fires when the serializer timeout expires (720s).
    deps.serializer.run(String(incoming.chatId), (signal) =>
      processInBackground(incoming, event, {
        ...deps,
        ...(deps.larkOAuthService     ? { larkOAuthService:     deps.larkOAuthService }     : {}),
        ...(deps.larkUserAuthLinkRepo ? { larkUserAuthLinkRepo: deps.larkUserAuthLinkRepo } : {}),
        ...(deps.chatContextService   ? { chatContextService:   deps.chatContextService }   : {}),
      }, log, deps.approvalGate, deps.knowledgeShareService, signal),
    );
  };

  // Both /events and /card route to the same handler. Some Lark configs send
  // card.action.trigger to a separate URL, others bundle it with /events.
  router.post('/events', handlePost);
  router.post('/card', handlePost);

  // Lark also fires the URL-verification challenge to the root path when you
  // first register the webhook URL — handle it so the console save succeeds.
  router.post('/', (req: Request, res: Response) => {
    let body: unknown = req.body;
    try { body = maybeDecryptLarkBody(body, encryptKey); } catch { /* ignore */ }
    const event = body as Record<string, unknown>;
    if (event['challenge']) {
      res.json({ challenge: event['challenge'] });
    } else {
      res.status(200).json({ ok: true });
    }
  });

  return router;
};

const LARK_OAUTH_NONCE_TTL_SECONDS = 600;

function larkOAuthNonceKey(nonce: string): string {
  return `lark:oauth:nonce:${nonce}`;
}

function encodeLarkOAuthState(input: {
  companyId: string;
  userId: string;
  larkOpenId: string;
  nonce: string;
}): string {
  return Buffer.from(JSON.stringify(input)).toString('base64url');
}

async function createLarkLoginUrl(input: {
  companyId: string;
  userId: string;
  larkOpenId: string;
  deps: {
    larkOAuthService?: LarkOAuthService;
    cache: CachePort;
  };
}): Promise<string | null> {
  const oauth = input.deps.larkOAuthService;
  if (!oauth?.isConfigured()) return null;

  const nonce = oauth.generateNonce();
  const cached = await input.deps.cache.set(
    larkOAuthNonceKey(nonce),
    {
      companyId:  input.companyId,
      userId:     input.userId,
      larkOpenId: input.larkOpenId,
    },
    LARK_OAUTH_NONCE_TTL_SECONDS,
  );
  if (!cached.ok) {
    throw new Error(cached.error.message);
  }

  return oauth.getAuthorizeUrl(encodeLarkOAuthState({
    companyId:  input.companyId,
    userId:     input.userId,
    larkOpenId: input.larkOpenId,
    nonce,
  }));
}

async function processInBackground(
  incoming: IncomingMessage,
  rawEvent: Record<string, unknown>,
  deps: {
    adapter: LarkChannelAdapter;
    engine: OrchestrationEngine;
    channelIdentityRepo: ChannelIdentityRepoPort;
    conversationRepo: ConversationRepoPort;
    logger: Logger;
    env: TypedEnv;
    ingestionQueue?: IngestionQueue;
    mem0?: Mem0Service;
    larkOAuthService?:     LarkOAuthService;
    larkUserAuthLinkRepo?: LarkUserAuthLinkRepository;
    cache: CachePort;
    chatContextService?: LarkChatContextService;
  },
  log: Logger,
  approvalGate?: ApprovalGateService,
  knowledgeShareService?: KnowledgeShareService,
  _signal?: AbortSignal,
): Promise<void> {
  // ── Idempotency — reject duplicate webhook deliveries ──────────────────
  // Lark retries on network hiccups. Redis SET NX with 1-hour TTL ensures
  // each messageId is processed exactly once. Fails open (availability > dedup).
  const idempotencyKey = `divo:ingress:msg:${String(incoming.messageId)}`;
  try {
    const claimed = await deps.cache.setNx(idempotencyKey, 1, 3600);
    if (claimed.ok && !claimed.value) {
      log.info('webhook.idempotency.duplicate', { messageId: incoming.messageId, chatId: incoming.chatId });
      return;
    }
  } catch {
    // Redis down — proceed anyway
  }

  const correlationId = asCorrelationId(incoming.traceId);

  const identityResult = await deps.channelIdentityRepo.resolveByLarkOpenId(
    incoming.userExternalId,
  );

  if (!identityResult.ok || !identityResult.value) {
    if (incoming.chatType === 'group' && !incoming.mentionsSelf) {
      log.debug('webhook.group_message.not_mentioned.identity_missing', {
        chatId: incoming.chatId,
        messageId: incoming.messageId,
        larkOpenId: incoming.userExternalId,
      });
      return;
    }

    const conversation: ConversationHandle = {
      channel:            'lark',
      chatId:             incoming.chatId,
      replyToMessageId:   incoming.messageId,
      replyInThread:      incoming.chatType === 'group',
      correlationId,
    };

    const pending = await deps.channelIdentityRepo.prepareLarkLogin(incoming.userExternalId);
    if (pending.ok && pending.value?.status === 'ready') {
      const loginUrl = await createLarkLoginUrl({
        companyId:  pending.value.companyId,
        userId:     pending.value.userId,
        larkOpenId: pending.value.larkOpenId,
        deps,
      });

      if (loginUrl) {
        const name = pending.value.displayName ?? pending.value.email;
        await deps.adapter.sendFinalReply(conversation, {
          kind: 'final',
          text:
            `Hi ${name}, I know you in this workspace, but I need a one-time account connection before I can run tools for you.\n\n` +
            `Open this link to connect Lark:\n\n${loginUrl}\n\n` +
            `After authorising, send your request again. The link expires in 10 minutes.`,
          format: 'text',
        }).catch(e => log.warn('webhook.login_prompt.reply_failed', { error: String(e), correlationId }));
        log.info('webhook.login_prompt.sent', {
          larkOpenId: incoming.userExternalId,
          companyId:  pending.value.companyId,
          userId:     pending.value.userId,
          createdUser: pending.value.createdUser,
          correlationId,
        });
        return;
      }
    }

    if (pending.ok && pending.value?.status === 'missing_email') {
      await deps.adapter.sendFinalReply(conversation, {
        kind: 'final',
        text: 'I found your Lark profile, but it has no email address synced into Divo. Ask an admin to sync or invite your account, then try again.',
        format: 'text',
      }).catch(e => log.warn('webhook.login_prompt.reply_failed', { error: String(e), correlationId }));
      log.warn('webhook.identity.missing_email', { larkOpenId: incoming.userExternalId, correlationId });
      return;
    }

    log.warn('webhook.identity.not_found', { larkOpenId: incoming.userExternalId });
    return;
  }

  const identity = identityResult.value;
  const runContext = {
    companyId:      asCompanyId(identity.companyId),
    userId:         asUserId(identity.userId),
    companyRole:    asCompanyRoleSlug(identity.aiRole),
    channel:        'lark' as const,
    traceId:        String(incoming.traceId),
    requestId:      String(incoming.messageId),
    userExternalId: incoming.userExternalId,   // Lark open_id — tools use this as default assignee
    chatId:         String(incoming.chatId),
    ...(identity.activeDepartmentId ? { departmentId: asDepartmentId(identity.activeDepartmentId) } : {}),
  };

  const conversation: ConversationHandle = {
    channel:            'lark',
    chatId:             incoming.chatId,
    replyToMessageId:   incoming.messageId,
    replyInThread:      incoming.chatType === 'group',
    correlationId,
  };

  const attachments = parseLarkAttachments(rawEvent);
  const shouldRespond = incoming.chatType !== 'group' || incoming.mentionsSelf;
  const preparedAttachments = attachments.length > 0
    ? await prepareLarkAttachmentContexts({
        incoming,
        attachments,
        identity,
        deps,
        log,
        shouldReact: shouldRespond,
      })
    : [];

  if (incoming.chatType === 'group' && !incoming.mentionsSelf) {
    log.debug('webhook.group_message.not_mentioned', {
      chatId: incoming.chatId,
      messageId: incoming.messageId,
      attachmentCount: preparedAttachments.length,
    });
    await storeGroupIncomingSnapshot({
      incoming,
      identity,
      deps,
      attachmentContexts: preparedAttachments.map(item => item.context),
      log,
    });

    // ── File upload acknowledgment in group chat ────────────────────────────
    // When someone shares a file/image in a group chat (without @Divo),
    // send a friendly ack so the user knows Divo noticed it.
    if (preparedAttachments.length > 0) {
      const fileNames = preparedAttachments.map(p => p.attachment.fileName);
      const hasUseful = preparedAttachments.some(hasUsefulInlineAttachmentContext);
      const ackText = preparedAttachments.length === 1
        ? `📎 Got it — I've received **${fileNames[0]}** and ${hasUseful ? "I'm reading through it now" : "it's being processed"}. Tag me when you'd like to discuss it!`
        : `📎 Got it — I've received ${preparedAttachments.length} files (${fileNames.join(', ')}) and ${hasUseful ? "I'm reading through them now" : "they're being processed"}. Tag me when you'd like to discuss them!`;

      await deps.adapter.sendFinalReply(conversation, {
        kind: 'final',
        text: ackText,
        format: 'markdown',
      }).catch(e => log.warn('webhook.group_upload_ack.failed', { error: String(e) }));
    }

    return;
  }

  if (attachments.length > 0) {
    await storeGroupIncomingSnapshot({
      incoming,
      identity,
      deps,
      attachmentContexts: preparedAttachments.map(item => item.context),
      log,
    });

    // Build a synthetic message that includes the file content so the engine
    // can immediately reason about it in DMs. Group chats read the same context
    // from the group snapshot so the upload stays in its original timeline slot.
    const userText        = incoming.text?.trim() ?? '';
    const contextBlock    = preparedAttachments
      .map(item => item.inlineContext?.context)
      .filter((part): part is string => !!part)
      .join('\n\n');
    const hasContext      = preparedAttachments.some(hasUsefulInlineAttachmentContext);

    if (!hasContext) {
      // Nothing useful extracted — plain ack, no engine run
      const n = attachments.length;
      await deps.adapter.sendFinalReply(conversation, {
        kind:   'final',
        text:   n === 1
          ? 'Got your file! Indexing it in the background — I\'ll let you know when it\'s ready.'
          : `Got your ${n} files! Indexing them in the background — I'll let you know when they're ready.`,
        format: 'text',
      }).catch(() => { /* non-fatal */ });
      return;
    }

    // Run the engine with the file contents injected into the message
    const syntheticText = userText
      ? `${contextBlock}\n\n${userText}`
      : contextBlock;

    const enrichedIncoming: typeof incoming = {
      ...incoming,
      text: incoming.chatType === 'group'
        ? (userText || `Please review the attached ${attachments.length === 1 ? 'file' : 'files'}.`)
        : syntheticText,
    };

    const result = await deps.engine.run({
      incoming:       enrichedIncoming,
      runContext,
      conversation,
      channelAdapter: deps.adapter,
      ...(approvalGate ? { approvalGate } : {}),
    });

    if (!result.ok) {
      log.error('webhook.engine.failed', { error: result.error.message, correlationId });
    }
    await storeGroupAssistantSnapshot({ incoming, identity, deps, result, log });
    return;
  }

  // ── Slash command interception ────────────────────────────────────────────
  const text = incoming.text?.trim() ?? '';
  if (text.startsWith('/')) {
    await handleSlashCommand({
      text,
      incoming,
      chatType: incoming.chatType,
      conversation,
      identity,
      deps,
      log,
      correlationId,
      ...(knowledgeShareService ? { knowledgeShareService } : {}),
    });
    return;
  }

  // Bare @Divo mention with no text — synthesize a contextual prompt so
  // the engine can respond to whatever was said above in the group chat.
  const effectiveIncoming = (!text && incoming.mentionsSelf && incoming.chatType === 'group')
    ? { ...incoming, text: 'Respond to the latest messages above in this group chat.' }
    : incoming;

  if (!effectiveIncoming.text?.trim()) return;

  await storeGroupIncomingSnapshot({
    incoming: effectiveIncoming,
    identity,
    deps,
    attachmentContexts: [],
    log,
  });

  // ── Normal message → orchestration engine ─────────────────────────────────
  const result = await deps.engine.run({
    incoming: effectiveIncoming,
    runContext,
    conversation,
    channelAdapter: deps.adapter,
    ...(approvalGate ? { approvalGate } : {}),
  });

  if (!result.ok) {
    log.error('webhook.engine.failed', { error: result.error.message, correlationId });
  }

  await storeGroupAssistantSnapshot({ incoming, identity, deps, result, log });
}

async function handleSlashCommand(args: {
  text: string;
  incoming: IncomingMessage;
  chatType?: string;
  conversation: ConversationHandle;
  identity: { companyId: string; userId: string; aiRole: string; activeDepartmentId?: string | null };
  deps: {
    adapter: LarkChannelAdapter;
    conversationRepo: ConversationRepoPort;
    logger: Logger;
    mem0?: Mem0Service;
    larkOAuthService?:     LarkOAuthService;
    larkUserAuthLinkRepo?: LarkUserAuthLinkRepository;
    cache: CachePort;
    chatContextService?: LarkChatContextService;
    prisma?: PrismaClient;
  };
  log: Logger;
  correlationId: ReturnType<typeof asCorrelationId>;
  knowledgeShareService?: KnowledgeShareService;
}): Promise<void> {
  const { text, incoming, conversation, identity, deps, log, correlationId, knowledgeShareService } = args;
  const cmd = text.split(/\s+/)[0]!.toLowerCase();

  const reply = async (replyText: string) => {
    const r = await deps.adapter.sendFinalReply(conversation, {
      kind:   'final',
      text:   replyText,
      format: 'text',
    });
    if (!r.ok) {
      log.warn('webhook.command.reply.failed', { error: r.error.message, correlationId });
    }
  };

  if (cmd === '/clear') {
    const clearResult = await deps.conversationRepo.clearHistory(incoming.chatId);
    if (!clearResult.ok) {
      log.warn('webhook.command.clear.failed', {
        chatId:        incoming.chatId,
        correlationId,
        error:         clearResult.error.message,
      });
      await reply('Could not clear history — please try again.');
      return;
    }
    if (deps.chatContextService) {
      await deps.chatContextService.clear(identity.companyId, String(incoming.chatId));
    }
    log.info('webhook.command.clear.ok', { chatId: incoming.chatId, correlationId });
    await reply('Done. Conversation history cleared — I\'ll start fresh from here.');
    return;
  }

  if (cmd === '/remember') {
    const fact = text.slice(cmd.length).trim();
    if (!fact) {
      await reply('Usage: /remember <fact to remember>\nExample: /remember Acme Corp uses net-30 payment terms');
      return;
    }

    if (!deps.mem0) {
      await reply('Memory system is not enabled.');
      return;
    }

    const role = identity.aiRole;
    const scope = role === 'COMPANY_ADMIN' || role === 'SUPER_ADMIN'
      ? 'company'
      : role === 'MANAGER' && identity.activeDepartmentId
        ? 'department'
        : 'user';

    try {
      await deps.mem0.rememberExplicit({
        fact,
        scope,
        userId:    identity.userId,
        companyId: identity.companyId,
        ...(identity.activeDepartmentId ? { departmentId: identity.activeDepartmentId } : {}),
      });

      const scopeLabel = scope === 'company'
        ? 'the company'
        : scope === 'department'
          ? 'your team'
          : 'you';
      log.info('webhook.command.remember.ok', { scope, factLength: fact.length, correlationId });
      await reply(`Got it. I'll remember that for ${scopeLabel}.`);
    } catch (error) {
      log.warn('webhook.command.remember.failed', { error: String(error), correlationId });
      await reply('Could not store that memory. Please try again.');
    }
    return;
  }

  if (cmd === '/share') {
    if (!knowledgeShareService) {
      await reply('File sharing is not configured on this server.');
      return;
    }
    // Optionally accept a file asset ID: /share <fileAssetId>
    const parts = text.split(/\s+/);
    const fileAssetId = parts[1] ? parts[1] : undefined;

    const senderOpenId = incoming.userExternalId;  // Lark open_id
    const senderName   = (incoming as unknown as Record<string, unknown>)['senderName'] as string | undefined ?? 'User';

    try {
      const result = await knowledgeShareService.requestShare({
        companyId:       identity.companyId,
        requesterUserId: identity.userId,
        requesterOpenId: senderOpenId,
        requesterName:   senderName,
        ...(fileAssetId ? { fileAssetId } : {}),
      });
      await reply(result.message);
    } catch (e) {
      log.error('webhook.command.share.failed', { error: String(e), correlationId });
      await reply('Something went wrong. Please try again.');
    }
    return;
  }

  // ── /login — start Lark user OAuth ─────────────────────────────────────────
  if (cmd === '/login') {
    if (!deps.larkOAuthService?.isConfigured()) {
      await reply('User OAuth is not configured on this server. Ask your admin to set LARK_OAUTH_REDIRECT_URI.');
      return;
    }

    // Check if already connected
    if (deps.larkUserAuthLinkRepo) {
      const existing = await deps.larkUserAuthLinkRepo.findByUserId(identity.userId, identity.companyId);
      if (existing.ok && existing.value && !isTokenExpired(existing.value.accessTokenExpiresAt)) {
        const name = existing.value.larkName ?? existing.value.larkEmail ?? 'your account';
        await reply(`✅ Already connected as **${name}**.\nType /logout to disconnect or /status to check details.`);
        return;
      }
    }

    const url = await createLarkLoginUrl({
      companyId:  identity.companyId,
      userId:     identity.userId,
      larkOpenId: incoming.userExternalId,
      deps,
    });

    if (!url) {
      await reply('User OAuth is not configured on this server. Ask your admin to set LARK_OAUTH_REDIRECT_URI.');
      return;
    }

    log.info('webhook.command.login.initiated', { userId: identity.userId, correlationId });
    await reply(
      `To connect your Lark account, open this link in your browser:\n\n${url}\n\n` +
      `After you authorise, I'll send you a confirmation here. The link expires in 10 minutes.`,
    );
    return;
  }

  // ── /logout — revoke stored user token ──────────────────────────────────────
  if (cmd === '/logout') {
    if (!deps.larkUserAuthLinkRepo) {
      await reply('User OAuth is not configured on this server.');
      return;
    }
    const result = await deps.larkUserAuthLinkRepo.revoke(identity.userId, identity.companyId);
    if (result.ok && result.value) {
      log.info('webhook.command.logout.ok', { userId: identity.userId, correlationId });
      await reply('Disconnected. Your personal Lark token has been removed — actions will now run as the Divo bot.');
    } else {
      await reply('No connected account found. Type /login to connect.');
    }
    return;
  }

  // ── /status — show connection status ────────────────────────────────────────
  if (cmd === '/status') {
    if (!deps.larkUserAuthLinkRepo) {
      await reply('User OAuth is not configured on this server.');
      return;
    }
    const link = await deps.larkUserAuthLinkRepo.findByUserId(identity.userId, identity.companyId);
    if (!link.ok || !link.value) {
      await reply('❌ Not connected. Type /login to connect your Lark account.');
      return;
    }
    const rec     = link.value;
    const expired = isTokenExpired(rec.accessTokenExpiresAt);
    const expiry  = rec.accessTokenExpiresAt
      ? rec.accessTokenExpiresAt.toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
      : 'unknown';
    await reply(
      `**Lark account status**\n` +
      `• Name: ${rec.larkName ?? '—'}\n` +
      `• Email: ${rec.larkEmail}\n` +
      `• Token: ${expired ? '⚠️ Expired — type /login to refresh' : '✅ Valid'}\n` +
      `• Expires: ${expiry}`,
    );
    return;
  }

  // ── /schedules — list active scheduled workflows ────────────────────────────
  if (cmd === '/schedules') {
    if (!deps.prisma) { await reply('Scheduling is not available.'); return; }
    const workflows = await deps.prisma.scheduledWorkflow.findMany({
      where: { companyId: identity.companyId, createdByUserId: identity.userId, status: { in: ['scheduled_active', 'paused'] } },
      orderBy: { nextRunAt: 'asc' },
      take: 10,
      select: { id: true, name: true, scheduleType: true, status: true, nextRunAt: true, lastRunAt: true },
    });
    if (workflows.length === 0) { await reply('No active schedules. Tell Divo to schedule something, e.g. "check my emails every morning at 9am".'); return; }
    const lines = workflows.map((w, i) => {
      const status = w.status === 'paused' ? '⏸' : '✅';
      const next = w.nextRunAt ? w.nextRunAt.toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '—';
      return `${i + 1}. ${status} **${w.name}** (${w.scheduleType})\n   Next: ${next} | ID: \`${w.id.slice(0, 8)}\``;
    });
    await reply(`**Your Scheduled Workflows**\n\n${lines.join('\n\n')}`);
    return;
  }

  // ── /pause <id> — pause a schedule ─────────────────────────────────────────
  if (cmd === '/pause') {
    if (!deps.prisma) { await reply('Scheduling is not available.'); return; }
    const idPrefix = text.slice(cmd.length).trim();
    if (!idPrefix) { await reply('Usage: `/pause <schedule-id>`\nGet IDs from `/schedules`.'); return; }
    const match = await deps.prisma.scheduledWorkflow.findFirst({
      where: { companyId: identity.companyId, createdByUserId: identity.userId, id: { startsWith: idPrefix }, status: 'scheduled_active' },
    });
    if (!match) { await reply(`No active schedule found starting with \`${idPrefix}\`.`); return; }
    await deps.prisma.scheduledWorkflow.update({
      where: { id: match.id },
      data: { status: 'paused', scheduleEnabled: false, pausedAt: new Date() },
    });
    log.info('webhook.command.pause.ok', { workflowId: match.id, correlationId });
    await reply(`Paused **${match.name}**. Use \`/resume ${idPrefix}\` to restart.`);
    return;
  }

  // ── /resume <id> — resume a paused schedule ────────────────────────────────
  if (cmd === '/resume') {
    if (!deps.prisma) { await reply('Scheduling is not available.'); return; }
    const idPrefix = text.slice(cmd.length).trim();
    if (!idPrefix) { await reply('Usage: `/resume <schedule-id>`\nGet IDs from `/schedules`.'); return; }
    const match = await deps.prisma.scheduledWorkflow.findFirst({
      where: { companyId: identity.companyId, createdByUserId: identity.userId, id: { startsWith: idPrefix }, status: 'paused' },
    });
    if (!match) { await reply(`No paused schedule found starting with \`${idPrefix}\`.`); return; }

    let nextRunAt: Date | null = null;
    try {
      const { scheduleConfigSchema } = await import('../../../application/scheduling/schedule-config');
      const { getNextScheduledRunAt } = await import('../../../application/scheduling/schedule-calculator');
      const parsed = scheduleConfigSchema.safeParse(match.scheduleConfigJson);
      if (parsed.success) nextRunAt = getNextScheduledRunAt(parsed.data, new Date());
    } catch { /* use null */ }

    await deps.prisma.scheduledWorkflow.update({
      where: { id: match.id },
      data: { status: 'scheduled_active', scheduleEnabled: true, pausedAt: null, nextRunAt },
    });
    const nextStr = nextRunAt ? nextRunAt.toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'pending';
    log.info('webhook.command.resume.ok', { workflowId: match.id, correlationId });
    await reply(`Resumed **${match.name}**. Next run: ${nextStr}.`);
    return;
  }

  // ── /cancel <id> — permanently archive a schedule ──────────────────────────
  if (cmd === '/cancel') {
    if (!deps.prisma) { await reply('Scheduling is not available.'); return; }
    const idPrefix = text.slice(cmd.length).trim();
    if (!idPrefix) { await reply('Usage: `/cancel <schedule-id>`\nGet IDs from `/schedules`.'); return; }
    const match = await deps.prisma.scheduledWorkflow.findFirst({
      where: { companyId: identity.companyId, createdByUserId: identity.userId, id: { startsWith: idPrefix }, status: { in: ['scheduled_active', 'paused'] } },
    });
    if (!match) { await reply(`No schedule found starting with \`${idPrefix}\`.`); return; }
    await deps.prisma.scheduledWorkflow.update({
      where: { id: match.id },
      data: { status: 'archived', scheduleEnabled: false, archivedAt: new Date(), nextRunAt: null },
    });
    log.info('webhook.command.cancel.ok', { workflowId: match.id, correlationId });
    await reply(`Cancelled **${match.name}**. This schedule has been permanently archived.`);
    return;
  }

  if (cmd === '/' || cmd === '/help' || cmd === '/commands') {
    await reply(
      '**Divo Commands**\n\n' +
      '**Conversation**\n' +
      '`/clear` — Wipe conversation memory for this chat. Divo starts fresh.\n' +
      '`/remember <fact>` — Save a fact Divo will recall in future chats.\n' +
      '  _Example:_ `/remember Acme Corp uses net-30 payment terms`\n\n' +
      '**Account**\n' +
      '`/login` — Connect your Lark account so actions run as you, not the bot.\n' +
      '`/logout` — Disconnect your Lark account.\n' +
      '`/status` — Check your Lark account connection and token status.\n\n' +
      '**Schedules**\n' +
      '`/schedules` — List your active and paused scheduled workflows.\n' +
      '`/pause <id>` — Pause a running schedule (use first 8 chars of ID).\n' +
      '`/resume <id>` — Resume a paused schedule.\n' +
      '`/cancel <id>` — Permanently archive a schedule.\n' +
      '  _Create schedules by telling Divo, e.g. "check my emails every morning at 9am"_\n\n' +
      '**Collaboration**\n' +
      '`/share` — Share your most recently indexed file with your team.\n\n' +
      '**Tips**\n' +
      '• In group chats, @mention Divo to talk to it.\n' +
      '• Upload a file and ask Divo to analyze it — PDFs, CSVs, and docs are all supported.',
    );
    return;
  }

  // Unknown command — let the engine handle it as a regular message
  log.info('webhook.command.unknown_routed_to_engine', { cmd, correlationId });
}

function isTokenExpired(expiresAt: Date | null | undefined): boolean {
  if (!expiresAt) return false;
  return expiresAt.getTime() < Date.now() + 5 * 60 * 1000; // 5 min buffer
}

type LarkResolvedIdentity = {
  companyId: string;
  userId: string;
  displayName?: string | null;
  email?: string | null;
};

type PreparedAttachmentContext = {
  attachment: LarkAttachment;
  context: GroupChatAttachmentContext;
  inlineContext?: InlineContextResult;
};

function groupAttachmentRetrievalHint(input: {
  fileName: string;
  fileAssetId?: string;
  isInlineComplete?: boolean;
  queued: boolean;
}): string | undefined {
  if (input.fileAssetId) {
    return `For more detail beyond the inline excerpt, use contextSearch or documentRag with fileAssetId="${input.fileAssetId}" or filename "${input.fileName}".`;
  }
  if (input.queued || input.isInlineComplete === false) {
    return `If the inline context is incomplete and more detail is needed after indexing, use contextSearch or documentRag with filename "${input.fileName}".`;
  }
  return undefined;
}

function hasUsefulInlineAttachmentContext(item: PreparedAttachmentContext): boolean {
  const rawText = item.inlineContext?.rawText.trim() ?? '';
  if (rawText) return true;

  const context = item.inlineContext?.context.trim() ?? '';
  if (!context) return false;
  if (context.includes('could not download')) return false;
  if (context.includes('no text content extracted')) return false;
  return !/^\[(?:File|Image):\s*"?[^"\]]+"?\]$/i.test(context);
}

async function prepareLarkAttachmentContexts(input: {
  incoming: IncomingMessage;
  attachments: readonly LarkAttachment[];
  identity: LarkResolvedIdentity;
  deps: {
    adapter: LarkChannelAdapter;
    env: TypedEnv;
    logger: Logger;
    ingestionQueue?: IngestionQueue;
    cloudinaryAdapter?: CloudinaryAdapter;
  };
  log: Logger;
  shouldReact: boolean;
}): Promise<PreparedAttachmentContext[]> {
  const { incoming, attachments, identity, deps, log } = input;
  if (attachments.length === 0) return [];

  if (input.shouldReact) {
    try {
      await deps.adapter.reactToIncoming(incoming.messageId, '📥');
    } catch { /* non-fatal */ }
  }

  const { LarkFileClient } = await import('./clients/lark-file.client');
  const { extractAttachmentInlineContext } = await import('./lark-inline-context');
  const fileClient = new LarkFileClient(deps.env, deps.logger);
  const prepared: PreparedAttachmentContext[] = [];

  for (const att of attachments) {
    let buffer: Buffer | undefined;
    let inlineContext: InlineContextResult | undefined;
    let error: string | undefined;

    try {
      const downloaded = att.type === 'image'
        ? await fileClient.downloadImage(att.messageId, att.key)
        : await fileClient.downloadFile(att.messageId, att.key);
      if (downloaded && downloaded.length > 0) {
        buffer = downloaded;
      } else {
        log.warn('webhook.attachment.download.empty', { fileName: att.fileName });
      }
    } catch (e) {
      error = e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200);
      log.warn('webhook.attachment.download.failed', { fileName: att.fileName, error });
    }

    if (buffer) {
      inlineContext = await extractAttachmentInlineContext(att, buffer, deps.env, deps.logger);
    }

    // Upload to Cloudinary for multimodal LLM access (non-blocking on failure)
    let cloudinaryUrl: string | undefined;
    if (buffer && deps.cloudinaryAdapter?.isAvailable) {
      try {
        const uploadResult = await deps.cloudinaryAdapter.uploadBuffer({
          buffer,
          mimeType:  att.mimeType,
          fileName:  att.fileName,
          folder:    'group_context',
          companyId: identity.companyId,
          assetId:   att.key,
          tags:      ['group_context', `chat:${String(incoming.chatId)}`],
        });
        cloudinaryUrl = uploadResult.secureUrl;
        log.info('webhook.attachment.cloudinary.uploaded', {
          fileName: att.fileName, publicId: uploadResult.publicId,
        });
      } catch (e) {
        log.warn('webhook.attachment.cloudinary.failed', {
          fileName: att.fileName,
          error: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
        });
      }
    }

    let queued = false;
    let enqueueError: string | undefined;

    if (deps.ingestionQueue) {
      try {
        const basePayload = {
          companyId:        identity.companyId,
          uploaderUserId:   identity.userId,
          uploaderChannel:  'lark',
          fileName:         att.fileName,
          mimeType:         att.mimeType,
          larkFileKey:      att.key,
          larkMessageId:    att.messageId,
          chatId:           String(incoming.chatId),
          replyToMessageId: String(incoming.messageId),
          ...(incoming.chatType === 'group' ? { groupContextMessageId: String(incoming.messageId) } : {}),
          visibility:       incoming.chatType === 'group' ? 'shared' as const : 'personal' as const,
        };

        await deps.ingestionQueue.enqueue(buffer && buffer.length > 0 ? {
          ...basePayload,
          jobType:      'buffer',
          bufferBase64: buffer.toString('base64'),
        } : {
          ...basePayload,
          jobType: att.type === 'image' ? 'lark_image' : 'lark_file',
        });
        queued = true;
        log.info('webhook.attachment.enqueued', {
          fileName: att.fileName,
          type: att.type,
          companyId: identity.companyId,
          visibility: incoming.chatType === 'group' ? 'shared' : 'personal',
        });
      } catch (e) {
        enqueueError = e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200);
        log.error('webhook.attachment.enqueue.failed', { fileName: att.fileName, error: enqueueError });
      }
    }

    const retrievalHint = groupAttachmentRetrievalHint({
      fileName: att.fileName,
      queued,
      ...(inlineContext ? { isInlineComplete: inlineContext.isComplete } : {}),
    });
    const contextError = enqueueError ?? error;
    const context: GroupChatAttachmentContext = {
      kind: att.type,
      fileName: att.fileName,
      mimeType: att.mimeType,
      larkFileKey: att.key,
      larkMessageId: att.messageId,
      ingestionStatus: queued ? 'processing' : enqueueError ? 'failed' : 'inline_only',
      ...(cloudinaryUrl ? { cloudinaryUrl } : {}),
      ...(inlineContext?.context ? { inlineContext: inlineContext.context } : {}),
      ...(inlineContext ? { isInlineComplete: inlineContext.isComplete } : {}),
      ...(inlineContext?.rawText ? { rawTextPreview: inlineContext.rawText.slice(0, 2000) } : {}),
      ...(retrievalHint ? { retrievalHint } : {}),
      ...(contextError ? { error: contextError } : {}),
    };

    prepared.push({
      attachment: att,
      context,
      ...(inlineContext ? { inlineContext } : {}),
    });
  }

  return prepared;
}

async function storeGroupIncomingSnapshot(input: {
  incoming: IncomingMessage;
  identity: LarkResolvedIdentity;
  deps: { chatContextService?: LarkChatContextService };
  attachmentContexts: readonly GroupChatAttachmentContext[];
  log: Logger;
}): Promise<void> {
  const { incoming, identity, deps, attachmentContexts, log } = input;
  if (incoming.chatType !== 'group' || !deps.chatContextService) return;

  const content = incoming.text?.trim()
    || attachmentContexts.map(att => `[${att.kind}: ${att.fileName}]`).join(' ');
  if (!content && attachmentContexts.length === 0) return;

  await deps.chatContextService.appendMessage({
    companyId: identity.companyId,
    chatId: String(incoming.chatId),
    chatType: 'group',
    messageId: String(incoming.messageId),
    senderOpenId: incoming.userExternalId,
    senderName: identity.displayName || identity.email || identity.userId,
    role: 'user',
    content,
    createdAt: incoming.timestamp,
    botMentioned: incoming.mentionsSelf,
    ...(attachmentContexts.length > 0
      ? {
          attachments: attachmentContexts,
          attachedFiles: attachmentContexts.map(att => att.fileName),
        }
      : {}),
  }).catch(e => log.warn('webhook.group_context.store_failed', { error: String(e) }));
}

async function storeGroupAssistantSnapshot(input: {
  incoming: IncomingMessage;
  identity: LarkResolvedIdentity;
  deps: { chatContextService?: LarkChatContextService };
  result: Awaited<ReturnType<OrchestrationEngine['run']>>;
  log: Logger;
}): Promise<void> {
  const { incoming, identity, deps, result, log } = input;
  if (incoming.chatType !== 'group' || !deps.chatContextService || !result.ok) return;

  await deps.chatContextService.appendMessage({
    companyId: identity.companyId,
    chatId: String(incoming.chatId),
    chatType: 'group',
    senderOpenId: 'divo-bot',
    senderName: 'Divo',
    role: 'assistant',
    content: result.value.finalReply.text,
    botMentioned: false,
  }).catch(e => log.warn('webhook.group_context.store_reply_failed', { error: String(e) }));
}
