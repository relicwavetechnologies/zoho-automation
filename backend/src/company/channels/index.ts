export const CHANNELS_BOUNDARY = {
  key: 'channels',
  responsibility: 'Channel adapters normalize provider events to core DTOs.',
};

export * from './base';
export * from './channel-adapter.registry';
export * from './lark';
