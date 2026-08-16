/**
 * An artifact: the durable thing Divo made, separated from the chat that asked
 * for it.
 *
 * The rule that shapes everything here is that the chat message and the artifact
 * answer different questions. A message says what happened; an artifact *is* the
 * work. So a message may be summarised, truncated and re-rendered per surface,
 * and an artifact may not be — it is stored whole and read back byte for byte.
 *
 * Markdown only, deliberately. HTML written by a model and rendered on our own
 * origin is a script-injection surface, and the honest fix for that is a
 * separate origin, not a sanitiser. Until that exists, an artifact is prose.
 */

/** What a surface is able to render. One entry today; the union is the point. */
export type ArtifactMime = 'text/markdown';

export const ARTIFACT_MIMES: readonly ArtifactMime[] = ['text/markdown'];

/**
 * Bounds. Generous enough for a long report, small enough that a row stays a
 * row — an artifact that wants more than this wants object storage, and should
 * say so rather than silently becoming a slow query.
 */
export const ARTIFACT_LIMITS = {
  maxBodyChars: 400_000,
  maxTitleChars: 160,
  maxIdChars: 120,
  maxThreadIdChars: 200,
} as const;

/** The artifact as a reader receives it. */
export interface Artifact {
  readonly artifactId: string;
  readonly title: string;
  readonly mime: ArtifactMime;
  readonly body: string;
  readonly version: number;
  readonly threadId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Enough to list one without carrying its body.
 *
 * A thread with six artifacts would otherwise send six full documents to draw
 * six tabs, and five of them are not being read.
 */
export type ArtifactSummary = Omit<Artifact, 'body'>;

export interface ArtifactWrite {
  readonly artifactId: string;
  readonly title: string;
  readonly mime: ArtifactMime;
  readonly body: string;
  readonly threadId?: string;
  readonly executionRunId?: string;
}

export function isArtifactMime(value: unknown): value is ArtifactMime {
  return typeof value === 'string' && (ARTIFACT_MIMES as readonly string[]).includes(value);
}
