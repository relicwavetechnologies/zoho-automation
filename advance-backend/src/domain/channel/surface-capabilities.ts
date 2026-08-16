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
 * The web's capabilities — Lark's, plus the two things a browser can do that a
 * chat card cannot.
 *
 * This started identical to Lark on purpose, so that "one soul" was something
 * observed rather than claimed. Two values have since been relaxed, and each is
 * backed by a renderer that exists:
 *
 * `worklog: 'streamed'` — a browser draws the log natively instead of re-editing
 * a card. It changes nothing the model decides.
 *
 * `artifacts: 'inline'` — the web has a panel beside the thread that renders a
 * document, and the runtime gives a web run the badge tool that fills it. A Lark
 * run is never given that tool, so its `'none'` is enforced by absence and not
 * by a rule the model is asked to remember.
 *
 * Charts and the table/size caps stay where they are. There is no chart renderer
 * yet, and raising a cap the browser has not been observed handling is exactly
 * the shortcut this record exists to prevent.
 */
const WEB: SurfaceCapabilities = {
  ...LARK,
  key: 'web',
  worklog: 'streamed',
  artifacts: 'inline',
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
