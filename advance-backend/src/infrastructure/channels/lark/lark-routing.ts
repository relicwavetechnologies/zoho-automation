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
 * Threaded groups use the same root-first identity as working history. A
 * top-level message is the future thread root, so its own message ID keeps the
 * seed turn and every reply on one serial lane. Inline groups have no thread
 * root and instead serialize each requester's private group context.
 */
const laneParts = (incoming: IncomingMessage): readonly string[] => {
  if (incoming.chatType === 'p2p') return ['dm'];
  if (incoming.groupReplyMode === 'inline') {
    return ['requester', incoming.userExternalId];
  }
  const threadIdentity = incoming.rootMessageId ?? incoming.threadId ?? incoming.messageId;
  return threadIdentity
    ? ['thread', String(threadIdentity)]
    : ['requester', incoming.userExternalId];
};

export const buildLarkRoomKey = (input: RoutingInput): string =>
  key('lark', 'room', ...installationParts(input));

export const buildLarkIngressLaneKey = (incoming: IncomingMessage): string =>
  key('lark', 'ingress-lane', ...channelParts(incoming), ...laneParts(incoming));

export const buildLarkDurableIngressLaneKey = (
  incoming: IncomingMessage,
  companyId?: string,
): string =>
  key(
    'lark',
    'ingress-receipt-lane',
    companyId ?? 'unbound',
    ...channelParts(incoming),
    ...laneParts(incoming),
  );

export const buildLarkExecutionLaneKey = (input: RoutingInput): string =>
  key('lark', 'lane', ...installationParts(input), ...laneParts(input.incoming));

export const buildLarkDeliveryTarget = (input: RoutingInput): {
  key: string;
  target: LarkDeliveryTarget;
} => {
  const threadIdentity = input.incoming.rootMessageId ?? input.incoming.threadId;
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
      replyInThread:
        input.incoming.chatType === 'group'
        && input.incoming.groupReplyMode !== 'inline',
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
