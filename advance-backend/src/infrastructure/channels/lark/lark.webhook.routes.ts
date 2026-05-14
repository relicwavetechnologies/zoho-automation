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
import { parseLarkAttachments } from './lark-attachment.parser';
import type { LarkChatContextService } from '../../../application/chat-context/lark-chat-context.service';

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

    // In group chats, only respond when @Divo is mentioned.
    // P2P (DMs) always proceed — there's no way to @mention in a 1-on-1.
    if (incoming.chatType === 'group' && !incoming.mentionsSelf) {
      log.debug('webhook.group_message.not_mentioned', {
        chatId:    incoming.chatId,
        messageId: incoming.messageId,
      });
      res.status(200).json({ ok: true });
      if (deps.chatContextService) {
        void storeGroupChatMessage(incoming, deps, log).catch(e =>
          log.warn('webhook.group_context.store_failed', { error: String(e) }),
        );
      }
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

  // ── File/image attachment handling ────────────────────────────────────────
  // Flow:
  //   1. Download buffer + extract inline context (fast, sync with timeout).
  //   2. Enqueue for full background indexing (always).
  //   3. If text could be extracted → inject into message and run the engine
  //      so the AI can immediately reason about the file contents.
  //      If nothing was extractable → send a plain ack and return.
  const attachments = parseLarkAttachments(rawEvent);

  if (attachments.length > 0) {
    const { LarkFileClient } = await import('./clients/lark-file.client');
    const { extractAttachmentInlineContext } = await import('./lark-inline-context');
    const fileClient = new LarkFileClient(deps.env, deps.logger);

    try {
      await deps.adapter.reactToIncoming(incoming.messageId, '📥');
    } catch { /* non-fatal */ }

    const contextParts: string[] = [];

    for (const att of attachments) {
      let buf: Buffer | undefined;
      try {
        buf = att.type === 'image'
          ? await fileClient.downloadImage(att.messageId, att.key)
          : await fileClient.downloadFile(att.messageId, att.key);
      } catch (e) {
        log.warn('webhook.attachment.download.failed', { fileName: att.fileName, error: String(e) });
      }

      // Extract inline context (with timeout fallback)
      if (buf) {
        const { context } = await extractAttachmentInlineContext(att, buf, deps.env, deps.logger);
        if (context) contextParts.push(context);
      } else {
        contextParts.push(`[File: "${att.fileName}" — could not download]`);
      }

      // Enqueue for full background indexing
      if (deps.ingestionQueue) {
        try {
          await deps.ingestionQueue.enqueue(buf ? {
            jobType:          'buffer',
            companyId:        identity.companyId,
            uploaderUserId:   identity.userId,
            uploaderChannel:  'lark',
            fileName:         att.fileName,
            mimeType:         att.mimeType,
            bufferBase64:     buf.toString('base64'),
            chatId:           String(incoming.chatId),
            replyToMessageId: String(incoming.messageId),
            visibility:       'personal',
          } : {
            jobType:          att.type === 'image' ? 'lark_image' : 'lark_file',
            companyId:        identity.companyId,
            uploaderUserId:   identity.userId,
            uploaderChannel:  'lark',
            fileName:         att.fileName,
            mimeType:         att.mimeType,
            larkFileKey:      att.key,
            larkMessageId:    att.messageId,
            chatId:           String(incoming.chatId),
            replyToMessageId: String(incoming.messageId),
            visibility:       'personal',
          });
          log.info('webhook.attachment.enqueued', { fileName: att.fileName, type: att.type, companyId: identity.companyId });
        } catch (e) {
          log.error('webhook.attachment.enqueue.failed', { fileName: att.fileName, error: String(e) });
        }
      }
    }

    // Build a synthetic message that includes the file content so the engine
    // can immediately reason about it.  Append any text the user typed alongside.
    const userText        = incoming.text?.trim() ?? '';
    const contextBlock    = contextParts.join('\n\n');
    const hasContext      = contextBlock.length > 0 && !contextBlock.startsWith('[File:') && !contextBlock.includes('could not download');

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
      text: syntheticText,
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

  if (!text) return;

  // ── Store in group context (if applicable) ────────────────────────────────
  if (incoming.chatType === 'group' && deps.chatContextService) {
    void deps.chatContextService.appendMessage({
      companyId: identity.companyId,
      chatId: String(incoming.chatId),
      chatType: 'group',
      senderOpenId: incoming.userExternalId,
      senderName: identity.displayName || identity.email || identity.userId,
      role: 'user',
      content: text,
      botMentioned: incoming.mentionsSelf,
    }).catch(e => log.warn('webhook.group_context.store_mentioned_failed', { error: String(e) }));
  }

  // ── Normal message → orchestration engine ─────────────────────────────────
  const result = await deps.engine.run({
    incoming,
    runContext,
    conversation,
    channelAdapter: deps.adapter,
    ...(approvalGate ? { approvalGate } : {}),
  });

  if (!result.ok) {
    log.error('webhook.engine.failed', { error: result.error.message, correlationId });
  }

  // Store Divo's reply in group context
  if (incoming.chatType === 'group' && deps.chatContextService && result.ok) {
    void deps.chatContextService.appendMessage({
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

  if (cmd === '/help' || cmd === '/commands') {
    await reply(
      'Available commands:\n' +
      '• `/login` — connect your Lark account (actions run as you, not the bot)\n' +
      '• `/logout` — disconnect your Lark account\n' +
      '• `/status` — check your Lark account connection\n' +
      '• `/clear` — clear my conversation memory for this chat\n' +
      '• `/remember <fact>` — store a durable fact for future conversations\n' +
      '• `/share` — share your most recently indexed file with your team\n' +
      '• `/help` — show this message',
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

async function storeGroupChatMessage(
  incoming: IncomingMessage,
  deps: {
    channelIdentityRepo: ChannelIdentityRepoPort;
    chatContextService?: LarkChatContextService;
  },
  log: Logger,
): Promise<void> {
  if (!deps.chatContextService) return;

  let senderName = 'User';
  try {
    const ci = await deps.channelIdentityRepo.resolveByLarkOpenId(incoming.userExternalId);
    if (ci.ok && ci.value) {
      senderName = ci.value.displayName || ci.value.email || ci.value.userId;
    }
  } catch { /* use default */ }

  const content = incoming.text?.trim()
    || (incoming.attachments.length > 0
      ? incoming.attachments.map(a => `[file: ${a.name ?? a.type}]`).join(', ')
      : '');
  if (!content) return;

  const companyId = await resolveCompanyIdForGroupMessage(incoming, deps);
  if (!companyId) return;

  await deps.chatContextService.appendMessage({
    companyId,
    chatId: String(incoming.chatId),
    chatType: 'group',
    senderOpenId: incoming.userExternalId,
    senderName,
    role: 'user',
    content,
    botMentioned: incoming.mentionsSelf,
    ...(incoming.attachments.length > 0
      ? { attachedFiles: incoming.attachments.map(a => a.name ?? a.type) }
      : {}),
  });
}

async function resolveCompanyIdForGroupMessage(
  incoming: IncomingMessage,
  deps: { channelIdentityRepo: ChannelIdentityRepoPort },
): Promise<string | null> {
  const id = await deps.channelIdentityRepo.resolveByLarkOpenId(incoming.userExternalId);
  return id.ok && id.value ? id.value.companyId : null;
}
