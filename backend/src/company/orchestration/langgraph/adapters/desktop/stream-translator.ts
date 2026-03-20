import type { Response } from 'express';

export type DesktopPersistedContentBlock =
  | { type: 'thinking'; text?: string }
  | { type: 'tool'; id: string; name: string; label: string; icon: string; status: 'running' | 'done' | 'failed'; resultSummary?: string }
  | { type: 'text'; content: string };

export type DesktopUiEventType =
  | 'thinking'
  | 'thinking_token'
  | 'activity'
  | 'activity_done'
  | 'action'
  | 'text'
  | 'done'
  | 'error';

export const sendDesktopSseEvent = (res: Response, type: DesktopUiEventType, data: unknown) => {
  res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
};

export const appendDesktopTextBlock = (
  blocks: DesktopPersistedContentBlock[],
  chunk: string,
): DesktopPersistedContentBlock[] => {
  const next = [...blocks];
  const last = next[next.length - 1];
  if (last?.type === 'text') {
    last.content += chunk;
    return next;
  }
  next.push({ type: 'text', content: chunk });
  return next;
};

export const ensureDesktopThinkingBlock = (
  blocks: DesktopPersistedContentBlock[],
): DesktopPersistedContentBlock[] => {
  const last = blocks[blocks.length - 1];
  if (last?.type === 'thinking') {
    return blocks;
  }
  return [...blocks, { type: 'thinking', text: '' }];
};

export const appendDesktopThinkingBlock = (
  blocks: DesktopPersistedContentBlock[],
  chunk: string,
): DesktopPersistedContentBlock[] => {
  const next = ensureDesktopThinkingBlock(blocks).slice();
  const last = next[next.length - 1];
  if (last?.type === 'thinking') {
    last.text = `${last.text ?? ''}${chunk}`;
  }
  return next;
};
