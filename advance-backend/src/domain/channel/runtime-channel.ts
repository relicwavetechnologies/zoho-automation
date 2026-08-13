import type { ChannelKey } from './incoming-message';

/**
 * The surfaces the backend can drive a Pi run on.
 *
 * `desktop` is deliberately not one of them. A desktop run is started by the
 * user's own machine: the backend issues no lease, owns no run id, and renders
 * no status of its own. Everything in this list is the opposite — the backend
 * launched the run and is responsible for showing it.
 *
 * Which of these a run is on decides how it is *presented*, never what it is
 * allowed to do. `PermissionQuery` carries a channel and no permission rule
 * reads it; keep it that way. See `plans/divo-one-soul-two-surfaces.md`.
 */
export const RUNTIME_CHANNELS = ['lark', 'web'] as const satisfies readonly ChannelKey[];

export type RuntimeChannel = typeof RUNTIME_CHANNELS[number];

export function isRuntimeChannel(value: unknown): value is RuntimeChannel {
  return typeof value === 'string' && (RUNTIME_CHANNELS as readonly string[]).includes(value);
}

/**
 * Narrow a trusted channel claim to a channel, falling back to `desktop`.
 *
 * The fallback errs in the safe direction: `desktop` is the channel with the
 * fewest backend-side assumptions, so an unrecognised value degrades to "the
 * backend drove nothing" rather than to a surface it cannot render.
 */
export function asChannelKey(value: unknown): ChannelKey {
  return isRuntimeChannel(value) ? value : 'desktop';
}
