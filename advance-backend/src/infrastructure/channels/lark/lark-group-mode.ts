import { createHash } from 'node:crypto';
import type { GroupReplyMode, IncomingMessage } from '../../../domain/channel/incoming-message';

export const DEFAULT_LARK_GROUP_MODE: GroupReplyMode = 'threaded';

export interface LarkGroupAddress {
  readonly companyId: string;
  readonly tenantKey?: string;
  readonly appId?: string;
  readonly chatId: string;
}

interface GroupModeStore {
  readonly adminControlState: {
    findUnique(input: {
      where: { controlKey_companyId: { controlKey: string; companyId: string } };
      select: { value: true };
    }): Promise<{ value: string } | null>;
    upsert(input: {
      where: { controlKey_companyId: { controlKey: string; companyId: string } };
      create: {
        controlKey: string;
        companyId: string;
        value: GroupReplyMode;
        updatedBy: string;
      };
      update: { value: GroupReplyMode; updatedBy: string };
    }): Promise<unknown>;
  };
}

const groupIdentity = (address: LarkGroupAddress): string =>
  JSON.stringify([
    address.tenantKey ?? '',
    address.appId ?? '',
    address.chatId,
  ]);

export const larkGroupModeControlKey = (address: LarkGroupAddress): string => {
  const digest = createHash('sha256')
    .update(groupIdentity(address))
    .digest('base64url');
  return `lark.group-mode.${digest}`;
};

export const parseLarkGroupMode = (value: unknown): GroupReplyMode =>
  value === 'threaded' ? value : DEFAULT_LARK_GROUP_MODE;

export async function loadLarkGroupMode(
  store: GroupModeStore,
  address: LarkGroupAddress,
): Promise<GroupReplyMode> {
  const controlKey = larkGroupModeControlKey(address);
  const row = await store.adminControlState.findUnique({
    where: { controlKey_companyId: { controlKey, companyId: address.companyId } },
    select: { value: true },
  });
  return parseLarkGroupMode(row?.value);
}

export async function saveLarkGroupMode(
  store: GroupModeStore,
  address: LarkGroupAddress,
  mode: GroupReplyMode,
  actorUserId: string,
): Promise<void> {
  const controlKey = larkGroupModeControlKey(address);
  await store.adminControlState.upsert({
    where: { controlKey_companyId: { controlKey, companyId: address.companyId } },
    create: {
      controlKey,
      companyId: address.companyId,
      value: mode,
      updatedBy: actorUserId,
    },
    update: { value: mode, updatedBy: actorUserId },
  });
}

export const withLarkGroupMode = (
  incoming: IncomingMessage,
  mode: GroupReplyMode,
): IncomingMessage => incoming.chatType === 'group'
  ? { ...incoming, groupReplyMode: mode }
  : incoming;

export const buildLarkGroupSettingsCard = (_mode: GroupReplyMode): string => {
  const card = {
    schema: '2.0',
    config: { width_mode: 'fill', update_multi: true, enable_forward: false },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: 'Divo group settings' },
    },
    body: {
      vertical_spacing: '8px',
      padding: '12px 12px 12px 12px',
      elements: [
        {
          tag: 'markdown',
          content: '**Threaded replies are always on**\nMention Divo once to start a thread. After that, everyone can continue inside it without mentioning Divo again.',
        },
      ],
    },
  };

  return JSON.stringify({ msg_type: 'interactive', card: JSON.stringify(card) });
};
