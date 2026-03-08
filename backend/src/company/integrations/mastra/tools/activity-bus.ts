/**
 * Per-request activity event bus.
 *
 * The desktop chat controller registers a callback with a request-scoped key
 * before calling agent.stream(). Any Mastra tool can call `emitActivityEvent()`
 * passing its requestContext to fire that callback.
 *
 * This avoids any monkey-patching or dependency on Mastra internals.
 */

export type ActivityEventType = 'activity' | 'activity_done';

export interface ActivityPayload {
    id: string;
    name: string;
    label: string;
    icon: string;
    resultSummary?: string;
}

type ActivityCallback = (type: ActivityEventType, payload: ActivityPayload) => void;

/** In-memory map: requestId → callback */
const registry = new Map<string, ActivityCallback>();

/** Called by the desktop chat controller before starting agent.stream() */
export function registerActivityBus(requestId: string, cb: ActivityCallback): void {
    registry.set(requestId, cb);
}

/** Called by the desktop chat controller after the stream ends */
export function unregisterActivityBus(requestId: string): void {
    registry.delete(requestId);
}

/**
 * Called by individual tools (via requestContext) to emit live activity events.
 * Tools should call this at the start and end of their execute() function.
 */
export function emitActivityEvent(
    requestId: string,
    type: ActivityEventType,
    payload: ActivityPayload,
): void {
    const cb = registry.get(requestId);
    cb?.(type, payload);
}
