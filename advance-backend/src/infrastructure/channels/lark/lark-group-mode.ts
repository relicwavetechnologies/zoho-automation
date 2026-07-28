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
  value === 'inline' ? 'inline' : DEFAULT_LARK_GROUP_MODE;

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

export const buildLarkGroupSettingsCard = (mode: GroupReplyMode): string => {
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
          content: mode === 'threaded'
            ? '**Current mode: Threaded**\nDivo starts a separate thread for each new request.'
            : '**Current mode: Inline**\nDivo replies in the main group conversation.',
        },
        {
          tag: 'column_set',
          horizontal_spacing: '8px',
          columns: [
            {
              tag: 'column',
              width: 'weighted',
              weight: 1,
              elements: [{
                tag: 'button',
                text: { tag: 'plain_text', content: 'Threaded' },
                type: mode === 'threaded' ? 'primary' : 'default',
                width: 'fill',
                behaviors: [{
                  type: 'callback',
                  value: { action: 'set_group_mode', mode: 'threaded' },
                }],
              }],
            },
            {
              tag: 'column',
              width: 'weighted',
              weight: 1,
              elements: [{
                tag: 'button',
                text: { tag: 'plain_text', content: 'Inline' },
                type: mode === 'inline' ? 'primary' : 'default',
                width: 'fill',
                behaviors: [{
                  type: 'callback',
                  value: { action: 'set_group_mode', mode: 'inline' },
                }],
              }],
            },
          ],
        },
        {
          tag: 'markdown',
          content: '<font color="grey">Only company admins can change this setting.</font>',
        },
      ],
    },
  };

  return JSON.stringify({ msg_type: 'interactive', card: JSON.stringify(card) });
};
