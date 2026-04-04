import { PrismaClient } from '../src/generated/prisma';
import config from '../src/config';
import { LarkTenantTokenService } from '../src/company/channels/lark/lark-tenant-token.service';

type StoredChatMessage = {
  id?: unknown;
  role?: unknown;
  content?: unknown;
  createdAt?: unknown;
};

type ProbeContext = {
  chatId: string;
  replyToMessageId: string | null;
  source: 'args' | 'env' | 'db';
};

type LarkApiResult = {
  ok: boolean;
  status: number;
  statusText: string;
  payload: unknown;
};

type UpdateVariant = {
  name: string;
  method: 'PATCH' | 'PUT';
  buildBody: (text: string) => Record<string, unknown>;
};

const prisma = new PrismaClient();
const tokenService = new LarkTenantTokenService();

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

const parseRecentMessageIds = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    const record = entry as StoredChatMessage;
    const id = asString(record.id);
    return id ? [id] : [];
  });
};

const sleep = (ms: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, ms);
});

const parseArgs = () => {
  const args = process.argv.slice(2);
  const parsed: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith('--')) continue;
    const [key, inlineValue] = arg.slice(2).split('=');
    if (inlineValue !== undefined) {
      parsed[key] = inlineValue;
      continue;
    }
    const next = args[index + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
};

const resolveProbeContext = async (): Promise<ProbeContext> => {
  const args = parseArgs();
  const argChatId = asString(args['chat-id']);
  const argReplyTo = asString(args['reply-to']);
  const envChatId = asString(process.env['LARK_PROBE_CHAT_ID']);
  const envReplyTo = asString(process.env['LARK_PROBE_REPLY_TO_MESSAGE_ID']);

  if (argChatId) {
    return {
      chatId: argChatId,
      replyToMessageId: argReplyTo,
      source: 'args',
    };
  }

  if (envChatId) {
    return {
      chatId: envChatId,
      replyToMessageId: envReplyTo,
      source: 'env',
    };
  }

  const latest = await prisma.larkChatContext.findFirst({
    where: {
      channel: 'lark',
      lastMessageAt: { not: null },
    },
    orderBy: {
      lastMessageAt: 'desc',
    },
    select: {
      chatId: true,
      recentMessagesJson: true,
    },
  });

  if (!latest?.chatId) {
    throw new Error('No recent Lark chat context found. Pass --chat-id explicitly.');
  }

  const messageIds = parseRecentMessageIds(latest.recentMessagesJson);
  return {
    chatId: latest.chatId,
    replyToMessageId: messageIds.length > 0 ? messageIds[messageIds.length - 1]! : null,
    source: 'db',
  };
};

const callLarkApi = async (
  token: string,
  input: {
    method: 'POST' | 'PATCH' | 'PUT';
    requestPath: string;
    body: Record<string, unknown>;
  },
): Promise<LarkApiResult> => {
  const response = await fetch(`${config.LARK_API_BASE_URL}${input.requestPath}`, {
    method: input.method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input.body),
  });

  const rawText = await response.text();
  let payload: unknown = rawText;
  try {
    payload = rawText ? JSON.parse(rawText) : null;
  } catch {
    payload = rawText;
  }

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    payload,
  };
};

const sendTextMessage = async (
  token: string,
  input: {
    chatId: string;
    replyToMessageId?: string | null;
    text: string;
  },
): Promise<LarkApiResult & { messageId: string | null }> => {
  const isReply = Boolean(input.replyToMessageId);
  const receiveIdType = input.chatId.startsWith('ou_') ? 'open_id' : 'chat_id';
  const requestPath = isReply
    ? `/open-apis/im/v1/messages/${input.replyToMessageId!.trim()}/reply`
    : `/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`;
  const body = {
    ...(isReply ? {} : { receive_id: input.chatId }),
    msg_type: 'text',
    ...(isReply ? { reply_in_thread: false } : {}),
    content: JSON.stringify({ text: input.text }),
  };

  const result = await callLarkApi(token, {
    method: 'POST',
    requestPath,
    body,
  });

  const payload = asRecord(result.payload);
  const data = asRecord(payload?.data);
  return {
    ...result,
    messageId: asString(data?.message_id),
  };
};

const updateVariants: UpdateVariant[] = [
  {
    name: 'patch_msg_type_and_content',
    method: 'PATCH',
    buildBody: (text) => ({
      msg_type: 'text',
      content: JSON.stringify({ text }),
    }),
  },
  {
    name: 'patch_content_only',
    method: 'PATCH',
    buildBody: (text) => ({
      content: JSON.stringify({ text }),
    }),
  },
  {
    name: 'put_msg_type_and_content',
    method: 'PUT',
    buildBody: (text) => ({
      msg_type: 'text',
      content: JSON.stringify({ text }),
    }),
  },
  {
    name: 'put_content_only',
    method: 'PUT',
    buildBody: (text) => ({
      content: JSON.stringify({ text }),
    }),
  },
];

const testVariant = async (
  token: string,
  input: {
    chatId: string;
    replyToMessageId?: string | null;
    scenarioName: string;
    variant: UpdateVariant;
  },
) => {
  const seedText = `[probe:${input.scenarioName}:${input.variant.name}] initial ${new Date().toISOString()}`;
  const sendResult = await sendTextMessage(token, {
    chatId: input.chatId,
    replyToMessageId: input.replyToMessageId,
    text: seedText,
  });

  const logPrefix = `${input.scenarioName}/${input.variant.name}`;
  // eslint-disable-next-line no-console
  console.log(`\n=== ${logPrefix} ===`);
  // eslint-disable-next-line no-console
  console.log('send:', JSON.stringify({
    ok: sendResult.ok,
    status: sendResult.status,
    statusText: sendResult.statusText,
    messageId: sendResult.messageId,
    payload: sendResult.payload,
  }, null, 2));

  if (!sendResult.ok || !sendResult.messageId) {
    return;
  }

  await sleep(1200);

  const updateText = `[probe:${input.scenarioName}:${input.variant.name}] updated ${new Date().toISOString()}`;
  const requestPath = `/open-apis/im/v1/messages/${sendResult.messageId}`;
  const body = input.variant.buildBody(updateText);
  const updateResult = await callLarkApi(token, {
    method: input.variant.method,
    requestPath,
    body,
  });

  // eslint-disable-next-line no-console
  console.log('update request:', JSON.stringify({
    method: input.variant.method,
    requestPath,
    body,
  }, null, 2));
  // eslint-disable-next-line no-console
  console.log('update response:', JSON.stringify(updateResult, null, 2));
};

const main = async () => {
  const args = parseArgs();
  if (args['help']) {
    // eslint-disable-next-line no-console
    console.log([
      'Usage: tsx scripts/probe-lark-message-updates.ts [--chat-id oc_xxx] [--reply-to om_xxx]',
      '',
      'If omitted, the script uses the latest Lark chat from DB and the latest stored message as the reply target.',
      'It sends fresh plain-text probe messages and tries multiple update variants on each one.',
    ].join('\n'));
    return;
  }

  const token = await tokenService.getAccessToken();
  const context = await resolveProbeContext();
  const scenarios = [
    { name: 'direct_text_send', replyToMessageId: null as string | null },
    ...(context.replyToMessageId
      ? [{ name: 'reply_text_send', replyToMessageId: context.replyToMessageId }]
      : []),
  ];

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    apiBaseUrl: config.LARK_API_BASE_URL,
    context,
    scenarios: scenarios.map((scenario) => scenario.name),
    variants: updateVariants.map((variant) => variant.name),
  }, null, 2));

  for (const scenario of scenarios) {
    for (const variant of updateVariants) {
      await testVariant(token, {
        chatId: context.chatId,
        replyToMessageId: scenario.replyToMessageId,
        scenarioName: scenario.name,
        variant,
      });
      await sleep(500);
    }
  }
};

main()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error('probe failed:', error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
