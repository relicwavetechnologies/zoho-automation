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

const installationParts = (input: RoutingInput): readonly string[] => [
  input.companyId,
  input.incoming.tenantKey ?? '',
  input.incoming.appId ?? '',
  String(input.incoming.chatId),
];

export const buildLarkRoomKey = (input: RoutingInput): string =>
  key('lark', 'room', ...installationParts(input));

export const buildLarkExecutionLaneKey = (input: RoutingInput): string => {
  const base = installationParts(input);
  if (input.incoming.chatType === 'p2p') {
    return key('lark', 'lane', ...base, 'dm');
  }

  const threadIdentity = input.incoming.threadId ?? input.incoming.rootMessageId;
  return threadIdentity
    ? key('lark', 'lane', ...base, 'thread', String(threadIdentity))
    : key('lark', 'lane', ...base, 'requester', input.incoming.userExternalId);
};

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
