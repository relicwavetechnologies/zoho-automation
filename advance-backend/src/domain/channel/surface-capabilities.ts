import type { ChannelKey } from './incoming-message';

/**
 * Lark's card limits, stated once.
 *
 * They live here rather than in the card builder because they are two things at
 * once: what the renderer must enforce, and what the model must be told. Held in
 * the renderer they were only ever the first, and the model was told nothing —
 * which is how "keep it short" ended up hard-coded into a prompt instead.
 */
export const LARK_CARD_LIMITS = {
  maxBlockChars: 1_200,
  maxCardBytes: 18_000,
  maxTableRows: 15,
  maxTablesPerCard: 3,
} as const;

/**
 * What a surface can carry.
 *
 * This is the whole of the difference between Lark and the web. Not a branch, a
 * record — so "what exactly differs between the two?" is answered by diffing two
 * values, and adding a third surface is adding a third value.
 *
 * The numbers come from `LARK_CARD_LIMITS` above, which the card builder also
 * reads. Stated once, so what the renderer enforces and what the model is told
 * cannot drift apart.
 */
export interface SurfaceCapabilities {
  readonly key: ChannelKey;
  /** Can a generated file be handed back, and how? */
  readonly artifacts: 'none' | 'link' | 'inline';
  /** Can a chart render, or must it become a table? */
  readonly charts: boolean;
  readonly tables: { readonly maxRows: number; readonly maxPerMessage: number };
  readonly maxBlockChars: number;
  readonly maxMessageBytes: number;
  /** How the work log reaches the reader. */
  readonly worklog: 'patched-card' | 'streamed';
  readonly approvals: 'card-buttons' | 'inline';
  /** May Divo offer "this is better on the web"? */
  readonly handoff: boolean;
}

const LARK: SurfaceCapabilities = {
  key: 'lark',
  artifacts: 'none',
  charts: false,
  tables: {
    maxRows: LARK_CARD_LIMITS.maxTableRows,
    maxPerMessage: LARK_CARD_LIMITS.maxTablesPerCard,
  },
  maxBlockChars: LARK_CARD_LIMITS.maxBlockChars,
  maxMessageBytes: LARK_CARD_LIMITS.maxCardBytes,
  worklog: 'patched-card',
  approvals: 'card-buttons',
  handoff: false,
};

/**
 * The web's capabilities during level 1 — deliberately identical to Lark's
 * except for how the work log arrives.
 *
 * The web can obviously do more than this. Granting it now would mean the two
 * surfaces were never observed to behave the same, and "one soul" would be a
 * claim rather than something that had been true and was then relaxed on
 * purpose. Level 2 changes these values; if that turns out to need code, the
 * architecture was wrong and this is where we find out.
 *
 * `worklog: 'streamed'` is the one honest difference: a browser draws the log
 * natively instead of re-editing a card. It changes nothing the model decides.
 */
const WEB: SurfaceCapabilities = {
  ...LARK,
  key: 'web',
  worklog: 'streamed',
};

/** A desktop run answers into a terminal that owns its own rendering. */
const DESKTOP: SurfaceCapabilities = {
  ...LARK,
  key: 'desktop',
  worklog: 'streamed',
};

export function surfaceCapabilities(channel: ChannelKey): SurfaceCapabilities {
  if (channel === 'lark') return LARK;
  if (channel === 'web') return WEB;
  return { ...DESKTOP, key: channel };
}
