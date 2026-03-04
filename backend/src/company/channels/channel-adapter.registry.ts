import type { ChannelAdapter, ChannelKey } from './base';
import { LarkChannelAdapter } from './lark/lark.adapter';

const larkAdapter = new LarkChannelAdapter();

export const resolveChannelAdapter = (channel: ChannelKey): ChannelAdapter => {
  if (channel === 'lark') {
    return larkAdapter;
  }
  throw new Error(`Unsupported channel adapter: ${channel}`);
};
