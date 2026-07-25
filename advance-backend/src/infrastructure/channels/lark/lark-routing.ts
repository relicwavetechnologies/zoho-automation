import type { IncomingMessage } from '../../../domain/channel/incoming-message';

export interface LarkDeliveryTarget {
  readonly chatId: string;
  readonly triggeringMessageId: string;
  readonly rootMessageId?: string;
  readonly threadId?: string;
  readonly replyInThread: boolean;
}

export interface LarkRoutingKeys {
  readonly roomKey: string;
  readonly executionLaneKey: string;
  readonly deliveryTargetKey: string;
  readonly deliveryTarget: LarkDeliveryTarget;
}

type RoutingInput = {
  companyId: string;
  incoming: IncomingMessage;
};

const key = (...parts: readonly string[]): string => JSON.stringify(parts);

const channelParts = (incoming: IncomingMessage): readonly string[] => [
  incoming.tenantKey ?? '',
  incoming.appId ?? '',
  String(incoming.chatId),
];

const installationParts = (input: RoutingInput): readonly string[] => [
  input.companyId,
  ...channelParts(input.incoming),
];

/**
 * Lane identity, which is NOT the same as conversation identity.
 *
 * `conversationKeyForMessage` (domain/conversation/conversation-key.ts) prefers
 * the root message and falls back to the message's own ID, so a thread's seed
 * turn and its replies share one context key. This prefers `thread_id` and
 * falls back to the requester, because a lane only has to answer "what must not
 * run concurrently" and lane selection must stay synchronous and authority-free.
 *
 * The divergence is deliberate but not free: a seed message (no `thread_id`,
 * lane = requester) and its first reply (lane = thread) occupy different lanes
 * while writing to one conversation key, so their history appends are not
 * serialised against each other. `appendTurn` claims sequence numbers with an
 * atomic increment, so this reorders rather than corrupts. Unifying the two is
 * tracked against Wave 3's distributed-lease work rather than patched here,
 * because changing lane identity changes ordering guarantees.
 */
const laneParts = (incoming: IncomingMessage): readonly string[] => {
  if (incoming.chatType === 'p2p') return ['dm'];
  const threadIdentity = incoming.threadId ?? incoming.rootMessageId;
  return threadIdentity
    ? ['thread', String(threadIdentity)]
    : ['requester', incoming.userExternalId];
};

export const buildLarkRoomKey = (input: RoutingInput): string =>
  key('lark', 'room', ...installationParts(input));

export const buildLarkIngressLaneKey = (incoming: IncomingMessage): string =>
  key('lark', 'ingress-lane', ...channelParts(incoming), ...laneParts(incoming));

export const buildLarkExecutionLaneKey = (input: RoutingInput): string =>
  key('lark', 'lane', ...installationParts(input), ...laneParts(input.incoming));

export const buildLarkDeliveryTarget = (input: RoutingInput): {
  key: string;
  target: LarkDeliveryTarget;
} => {
  const threadIdentity = input.incoming.threadId ?? input.incoming.rootMessageId;
  return {
    key: key(
      'lark',
      'delivery',
      ...installationParts(input),
      String(input.incoming.messageId),
      threadIdentity ? String(threadIdentity) : '',
    ),
    target: {
      chatId: String(input.incoming.chatId),
      triggeringMessageId: String(input.incoming.messageId),
      ...(input.incoming.rootMessageId
        ? { rootMessageId: String(input.incoming.rootMessageId) }
        : {}),
      ...(input.incoming.threadId ? { threadId: input.incoming.threadId } : {}),
      replyInThread: input.incoming.chatType === 'group',
    },
  };
};

export const buildLarkRoutingKeys = (input: RoutingInput): LarkRoutingKeys => {
  const delivery = buildLarkDeliveryTarget(input);
  return {
    roomKey: buildLarkRoomKey(input),
    executionLaneKey: buildLarkExecutionLaneKey(input),
    deliveryTargetKey: delivery.key,
    deliveryTarget: delivery.target,
  };
};
