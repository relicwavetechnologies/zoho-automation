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
import { asCompanyId, asUserId, asCorrelationId, asDepartmentId } from '../../../shared/ids';
import { asCompanyRoleSlug } from '../../../domain/permissions/company-role';
import type { ConversationHandle } from '../../../application/channels/channel.adapter';
import type { IncomingMessage } from '../../../domain/channel/incoming-message';
import {
  verifyLarkWebhookRequest,
  maybeDecryptLarkBody,
} from './lark-security';
import { parseLarkAttachments } from './lark-attachment.parser';

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
      return;
    }

    // ── Step 5: Respond immediately to Lark (5s timeout requirement) ─────────
    res.status(200).json({ ok: true });

    // ── Step 6: Process asynchronously ───────────────────────────────────────
    void processInBackground(incoming, event, deps, log, deps.approvalGate, deps.knowledgeShareService);
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
  },
  log: Logger,
  approvalGate?: ApprovalGateService,
  knowledgeShareService?: KnowledgeShareService,
): Promise<void> {
  const correlationId = asCorrelationId(incoming.traceId);

  const identityResult = await deps.channelIdentityRepo.resolveByLarkOpenId(
    incoming.userExternalId,
  );

  if (!identityResult.ok || !identityResult.value) {
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
}

async function handleSlashCommand(args: {
  text: string;
  incoming: IncomingMessage;
  conversation: ConversationHandle;
  identity: { companyId: string; userId: string; aiRole: string };
  deps: {
    adapter: LarkChannelAdapter;
    conversationRepo: ConversationRepoPort;
    logger: Logger;
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
    log.info('webhook.command.clear.ok', { chatId: incoming.chatId, correlationId });
    await reply('Done. Conversation history cleared — I\'ll start fresh from here.');
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

  if (cmd === '/help' || cmd === '/commands') {
    await reply(
      'Available commands:\n' +
      '• `/clear` — clear my conversation memory for this chat\n' +
      '• `/share` — share your most recently indexed file with your team\n' +
      '• `/help` — show this message',
    );
    return;
  }

  // Unknown command — let the engine handle it as a regular message
  log.info('webhook.command.unknown_routed_to_engine', { cmd, correlationId });
}
