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
    taskId?: string | null;
    externalRef?: string;
    resultSummary?: string;
}

type ActivityCallback = (type: ActivityEventType, payload: ActivityPayload) => void;

/** In-memory map: requestId → callbacks */
const registry = new Map<string, Set<ActivityCallback>>();

/** Called by the desktop chat controller before starting agent.stream() */
export function registerActivityBus(requestId: string, cb: ActivityCallback): void {
    const listeners = registry.get(requestId) ?? new Set<ActivityCallback>();
    listeners.add(cb);
    registry.set(requestId, listeners);
}

/** Called by the desktop chat controller after the stream ends */
export function unregisterActivityBus(requestId: string, cb?: ActivityCallback): void {
    if (!cb) {
        registry.delete(requestId);
        return;
    }

    const listeners = registry.get(requestId);
    if (!listeners) {
        return;
    }
    listeners.delete(cb);
    if (listeners.size === 0) {
        registry.delete(requestId);
    }
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
    const listeners = registry.get(requestId);
    if (!listeners) {
        return;
    }
    for (const cb of listeners) {
        cb(type, payload);
    }
}
