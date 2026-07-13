const CALLED_MARKER_RE = /^\[Called:\s*[^\]]+\]$/i;

/** Legacy read-time compaction marker. It must never enter a model prompt or user reply. */
export const isInternalHistoryMarker = (content: string): boolean =>
  CALLED_MARKER_RE.test(content.trim());
