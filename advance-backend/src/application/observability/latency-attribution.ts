export type LatencyAttributeValue = string | number | boolean | null;

export interface LatencySpanSample {
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly name: string;
  readonly category: string;
  readonly source: string;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly status: string;
  readonly attributes?: Record<string, LatencyAttributeValue>;
}

export interface LatencyModuleAttribution {
  readonly name: string;
  readonly category: string;
  readonly count: number;
  readonly errorCount: number;
  /** Wall time for which this module was the leaf determining completion. */
  readonly criticalPathMs: number;
  readonly inclusiveMs: number;
  readonly exclusiveMs: number;
  readonly maxMs: number;
}

export interface CriticalPathSegment {
  readonly spanId: string;
  readonly name: string;
  readonly category: string;
  readonly source: string;
  readonly startOffsetMs: number;
  readonly durationMs: number;
  readonly attributes?: Record<string, LatencyAttributeValue>;
}

export interface SlowLatencySpan {
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly name: string;
  readonly category: string;
  readonly source: string;
  readonly durationMs: number;
  readonly exclusiveMs: number;
  readonly status: string;
  readonly attributes?: Record<string, LatencyAttributeValue>;
}

export interface LatencyAttribution {
  readonly observedWallMs: number;
  readonly instrumentedMs: number;
  readonly unattributedMs: number;
  readonly spanCount: number;
  readonly modules: LatencyModuleAttribution[];
  readonly criticalPath: CriticalPathSegment[];
  readonly slowestSpans: SlowLatencySpan[];
}

interface NormalizedSpan extends LatencySpanSample {
  readonly durationMs: number;
}

/**
 * Turn causal spans into one non-double-counted latency explanation.
 *
 * Inclusive time answers “how long did this module surround work?” Exclusive
 * time subtracts the union of direct child intervals, so nested provider and
 * persistence spans are not counted twice. The critical path assigns each wall
 * segment to one active leaf; among parallel leaves, the one ending latest is
 * the work currently determining completion.
 */
export function attributeLatency(input: readonly LatencySpanSample[]): LatencyAttribution {
  const spans = input
    .filter(span => Number.isFinite(span.startedAtMs) && Number.isFinite(span.endedAtMs))
    .map(normalizeSpan)
    .filter(span => span.durationMs >= 0);
  if (spans.length === 0) {
    return {
      observedWallMs: 0,
      instrumentedMs: 0,
      unattributedMs: 0,
      spanCount: 0,
      modules: [],
      criticalPath: [],
      slowestSpans: [],
    };
  }

  const byId = new Map(spans.map(span => [span.spanId, span]));
  const children = new Map<string, NormalizedSpan[]>();
  for (const span of spans) {
    if (!span.parentSpanId || !byId.has(span.parentSpanId)) continue;
    const bucket = children.get(span.parentSpanId) ?? [];
    bucket.push(span);
    children.set(span.parentSpanId, bucket);
  }

  const exclusiveById = new Map<string, number>();
  for (const span of spans) {
    const covered = unionDuration(
      (children.get(span.spanId) ?? []).map(child => ({
        start: Math.max(span.startedAtMs, child.startedAtMs),
        end: Math.min(span.endedAtMs, child.endedAtMs),
      })),
    );
    exclusiveById.set(span.spanId, Math.max(0, span.durationMs - covered));
  }

  const firstAt = Math.min(...spans.map(span => span.startedAtMs));
  const lastAt = Math.max(...spans.map(span => span.endedAtMs));
  const observedWallMs = Math.max(0, lastAt - firstAt);
  const criticalPath = buildCriticalPath(spans, byId, firstAt);
  const instrumentedMs = criticalPath.reduce((total, segment) => total + segment.durationMs, 0);
  const modules = aggregateModules(spans, exclusiveById, criticalPath);

  return {
    observedWallMs,
    instrumentedMs,
    unattributedMs: Math.max(0, observedWallMs - instrumentedMs),
    spanCount: spans.length,
    modules,
    criticalPath,
    slowestSpans: [...spans]
      .sort((a, b) => b.durationMs - a.durationMs || a.startedAtMs - b.startedAtMs)
      .slice(0, 20)
      .map(span => ({
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        name: span.name,
        category: span.category,
        source: span.source,
        durationMs: span.durationMs,
        exclusiveMs: exclusiveById.get(span.spanId) ?? span.durationMs,
        status: span.status,
        ...(span.attributes ? { attributes: span.attributes } : {}),
      })),
  };
}

function normalizeSpan(span: LatencySpanSample): NormalizedSpan {
  const startedAtMs = Math.round(span.startedAtMs);
  const endedAtMs = Math.max(startedAtMs, Math.round(span.endedAtMs));
  return { ...span, startedAtMs, endedAtMs, durationMs: endedAtMs - startedAtMs };
}

function aggregateModules(
  spans: readonly NormalizedSpan[],
  exclusiveById: ReadonlyMap<string, number>,
  criticalPath: readonly CriticalPathSegment[],
): LatencyModuleAttribution[] {
  const criticalByModule = new Map<string, number>();
  for (const segment of criticalPath) {
    const key = `${segment.category}\u0000${segment.name}`;
    criticalByModule.set(key, (criticalByModule.get(key) ?? 0) + segment.durationMs);
  }
  const grouped = new Map<string, LatencyModuleAttribution>();
  for (const span of spans) {
    const key = `${span.category}\u0000${span.name}`;
    const current = grouped.get(key) ?? {
      name: span.name,
      category: span.category,
      count: 0,
      errorCount: 0,
      criticalPathMs: criticalByModule.get(key) ?? 0,
      inclusiveMs: 0,
      exclusiveMs: 0,
      maxMs: 0,
    };
    grouped.set(key, {
      ...current,
      count: current.count + 1,
      errorCount: current.errorCount + (span.status === 'error' ? 1 : 0),
      inclusiveMs: current.inclusiveMs + span.durationMs,
      exclusiveMs: current.exclusiveMs + (exclusiveById.get(span.spanId) ?? span.durationMs),
      maxMs: Math.max(current.maxMs, span.durationMs),
    });
  }
  return [...grouped.values()]
    .sort((a, b) => (
      b.criticalPathMs - a.criticalPathMs
      || b.exclusiveMs - a.exclusiveMs
      || b.inclusiveMs - a.inclusiveMs
      || a.name.localeCompare(b.name)
    ));
}

function buildCriticalPath(
  spans: readonly NormalizedSpan[],
  byId: ReadonlyMap<string, NormalizedSpan>,
  firstAt: number,
): CriticalPathSegment[] {
  const points = [...new Set(spans.flatMap(span => [span.startedAtMs, span.endedAtMs]))].sort((a, b) => a - b);
  const segments: CriticalPathSegment[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index]!;
    const end = points[index + 1]!;
    if (end <= start) continue;
    const active = spans.filter(span => span.startedAtMs <= start && span.endedAtMs >= end);
    if (active.length === 0) continue;
    const leaves = active.filter(candidate => !active.some(other => (
      other.spanId !== candidate.spanId && isDescendant(other, candidate.spanId, byId)
    )));
    const owner = [...leaves].sort((a, b) => (
      b.endedAtMs - a.endedAtMs
      || depthOf(b, byId) - depthOf(a, byId)
      || a.durationMs - b.durationMs
    ))[0]!;
    const durationMs = end - start;
    const previous = segments.at(-1);
    if (previous?.spanId === owner.spanId && previous.startOffsetMs + previous.durationMs === start - firstAt) {
      segments[segments.length - 1] = { ...previous, durationMs: previous.durationMs + durationMs };
    } else {
      segments.push({
        spanId: owner.spanId,
        name: owner.name,
        category: owner.category,
        source: owner.source,
        startOffsetMs: start - firstAt,
        durationMs,
        ...(owner.attributes ? { attributes: owner.attributes } : {}),
      });
    }
  }
  return segments;
}

function isDescendant(
  candidate: NormalizedSpan,
  ancestorId: string,
  byId: ReadonlyMap<string, NormalizedSpan>,
): boolean {
  let parentId = candidate.parentSpanId;
  const visited = new Set<string>();
  while (parentId && !visited.has(parentId)) {
    if (parentId === ancestorId) return true;
    visited.add(parentId);
    parentId = byId.get(parentId)?.parentSpanId ?? null;
  }
  return false;
}

function depthOf(span: NormalizedSpan, byId: ReadonlyMap<string, NormalizedSpan>): number {
  let depth = 0;
  let parentId = span.parentSpanId;
  const visited = new Set<string>();
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    depth += 1;
    parentId = byId.get(parentId)?.parentSpanId ?? null;
  }
  return depth;
}

function unionDuration(intervals: readonly { start: number; end: number }[]): number {
  const ordered = intervals.filter(interval => interval.end > interval.start).sort((a, b) => a.start - b.start || a.end - b.end);
  let total = 0;
  let currentStart: number | undefined;
  let currentEnd: number | undefined;
  for (const interval of ordered) {
    if (currentStart === undefined || currentEnd === undefined) {
      currentStart = interval.start;
      currentEnd = interval.end;
    } else if (interval.start <= currentEnd) {
      currentEnd = Math.max(currentEnd, interval.end);
    } else {
      total += currentEnd - currentStart;
      currentStart = interval.start;
      currentEnd = interval.end;
    }
  }
  return currentStart === undefined || currentEnd === undefined
    ? total
    : total + currentEnd - currentStart;
}
