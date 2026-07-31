/**
 * The member session a scheduled run acts under.
 *
 * The Pi runtime mints its lease from a `MemberSession` row, and until now the
 * only thing that created one was a human signing in. A workflow firing at
 * 03:00 has nobody signed in, which is the single reason scheduled work still
 * ran on the in-backend engine instead of the container.
 *
 * So the backend issues one itself, for the workflow's creator, lasting only as
 * long as the run. This grants no authority the creator did not already have:
 *
 *   - authoring the workflow required `execute` on the tools it uses, and that
 *     was checked then;
 *   - the gateway re-resolves live `adminMembership` on every single tool call
 *     (see member-auth.middleware), so deactivating or demoting the member
 *     stops their scheduled runs mid-flight — the row is an identity, never a
 *     captured permission;
 *   - the session is revoked the moment the run ends, and is never renewed.
 *
 * `authProvider` marks these rows so they are distinguishable from a real
 * login in the table and in any audit that reads it.
 */

import type { PrismaClient } from '../../generated/prisma';

/** Marks a session as machine-issued for a scheduled run, never a human login. */
export const SCHEDULED_SESSION_AUTH_PROVIDER = 'scheduled_workflow';

/**
 * Pi refuses a session with under five minutes left, so a scheduled session has
 * to outlast the run by more than that margin or it would be rejected at the
 * moment it was created.
 */
const EXPIRY_MARGIN_MS = 10 * 60_000;

export interface ScheduledRuntimeSessionInput {
  readonly companyId: string;
  readonly userId: string;
  readonly role: string;
  readonly larkTenantKey: string;
  readonly larkOpenId: string;
  /** How long the run itself may take; the session outlives it by the margin. */
  readonly runTimeoutMs: number;
}

export interface ScheduledRuntimeSession {
  readonly sessionId: string;
  readonly expiresAt: Date;
}

type SessionDb = Pick<PrismaClient, 'memberSession'>;

/**
 * Issues the session a scheduled run acts under.
 *
 * Channel is `lark` because that is what the Pi lease is scoped to, and
 * because every scheduled result is delivered to the creator's own Lark DM —
 * including one scheduled from the desktop.
 */
export async function issueScheduledRuntimeSession(
  db: SessionDb,
  input: ScheduledRuntimeSessionInput,
  now: Date = new Date(),
): Promise<ScheduledRuntimeSession> {
  const expiresAt = new Date(now.getTime() + input.runTimeoutMs + EXPIRY_MARGIN_MS);
  const session = await db.memberSession.create({
    data: {
      userId:        input.userId,
      companyId:     input.companyId,
      role:          input.role,
      channel:       'lark',
      authProvider:  SCHEDULED_SESSION_AUTH_PROVIDER,
      larkTenantKey: input.larkTenantKey,
      larkOpenId:    input.larkOpenId,
      expiresAt,
    },
    select: { sessionId: true, expiresAt: true },
  });
  return { sessionId: session.sessionId, expiresAt: session.expiresAt };
}

/**
 * Retires the session once the run is over.
 *
 * Revocation is best-effort by design: the run has already finished and its
 * result is already recorded, so failing to revoke must not turn a successful
 * workflow into a failed one. An un-revoked row still expires on its own, which
 * is why the lifetime is bounded at creation rather than trusted to cleanup.
 */
export async function revokeScheduledRuntimeSession(
  db: SessionDb,
  sessionId: string,
  now: Date = new Date(),
): Promise<void> {
  await db.memberSession.updateMany({
    where: { sessionId, revokedAt: null },
    data: { revokedAt: now },
  });
}
