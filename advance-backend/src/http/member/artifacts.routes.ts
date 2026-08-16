import { Router, type Response } from 'express';
import { z } from 'zod';
import type { Logger } from '../../shared/logger';
import type { ArtifactRepoPort } from '../../infrastructure/persistence/artifact.repository';
import { ARTIFACT_LIMITS, ARTIFACT_MIMES, type ArtifactMime } from '../../domain/artifact/artifact';

/**
 * The artifact's way in and out.
 *
 * Two very different callers share these routes, and share them on purpose. The
 * container POSTs one when the agent badges a file; the browser GETs it back to
 * draw. Both authenticate as the same member — the runtime holds a lease minted
 * for this person's container — so one ownership scope covers both, and there is
 * no second answer to "may this reader have this document".
 *
 * Nothing here is channel-aware, and nothing needs to be. Lark never reaches
 * these routes because Lark's runs are never given the tool that writes to them;
 * that decision lives in the runtime's manifest, where a capability belongs, and
 * not in a branch here that a future caller could forget to take.
 *
 * ── Why `http/member/` and not `http/desktop/` ─────────
 * The seam these routes sit at is *who is calling* — a signed-in member — not
 * *what they are running*. `http/admin/` is an admin session, `http/gateway/` is
 * the container calling back, and this is a member. `http/desktop/` names a
 * client instead, which is why it already holds `web-chat.routes.ts` and
 * `knowledge-files.routes.ts`, neither of which is a desktop thing.
 *
 * That folder is a rename this feature did not take on, because the prefix is in
 * the desktop app and the Pi runtime as well. Nothing new should be added to it;
 * this directory is where those files belong when someone does take it on. The
 * mount follows the convention the correctly-named member routes already use —
 * `/api/knowledge/files`, `/api/mail-automations` — and names the resource.
 */

const artifactIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(ARTIFACT_LIMITS.maxIdChars)
  // A key that reaches a URL may not be a path or a sentence.
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'malformed artifact id');

const saveSchema = z.object({
  artifactId: artifactIdSchema,
  title: z.string().trim().min(1).max(ARTIFACT_LIMITS.maxTitleChars),
  mime: z.enum(ARTIFACT_MIMES as unknown as [ArtifactMime, ...ArtifactMime[]]),
  body: z.string().max(ARTIFACT_LIMITS.maxBodyChars),
  threadId: z.string().trim().min(1).max(ARTIFACT_LIMITS.maxThreadIdChars).optional(),
  executionRunId: z.string().trim().min(1).max(200).optional(),
});

export function createArtifactRoutes(deps: {
  readonly artifacts: ArtifactRepoPort;
  readonly logger: Logger;
}) {
  const router = Router();
  const log = deps.logger.child({ service: 'artifact-routes' });

  router.post('/', async (req, res) => {
    const scope = scopeFrom(res);
    if (!scope) return unauthenticated(res);
    const parsed = saveSchema.safeParse(req.body);
    if (!parsed.success) {
      // The runtime reads this back and tells the model, so the reason has to
      // survive the trip. A bare 400 would surface to a person as an artifact
      // that silently never appeared.
      res.status(400).json({ ok: false, error: 'invalid_artifact', detail: parsed.error.issues[0]?.message });
      return;
    }
    const { artifactId, title, mime, body, threadId, executionRunId } = parsed.data;
    const saved = await deps.artifacts.save(scope, {
      artifactId,
      title,
      mime,
      body,
      ...(threadId ? { threadId } : {}),
      ...(executionRunId ? { executionRunId } : {}),
    });
    if (!saved.ok) {
      log.error('artifacts.save_failed', { artifactId: parsed.data.artifactId, error: String(saved.error) });
      res.status(500).json({ ok: false, error: 'artifact_not_saved' });
      return;
    }
    res.json({ ok: true, artifact: saved.value });
  });

  router.get('/', async (req, res) => {
    const scope = scopeFrom(res);
    if (!scope) return unauthenticated(res);
    const threadId = typeof req.query['threadId'] === 'string' ? req.query['threadId'] : undefined;
    // A band showing four asks for four. Clamped rather than trusted, and
    // ignored when it is nonsense, because a list route is not the place a
    // caller gets to choose how much of the table to read.
    const asked = Number(req.query['limit']);
    const limit = Number.isFinite(asked) ? Math.min(50, Math.max(1, Math.trunc(asked))) : undefined;
    const listed = await deps.artifacts.list(
      { ...scope, ...(threadId ? { threadId } : {}) },
      limit,
    );
    if (!listed.ok) {
      log.error('artifacts.list_failed', { error: String(listed.error) });
      res.status(500).json({ ok: false, error: 'artifacts_unavailable' });
      return;
    }
    res.json({ ok: true, artifacts: listed.value });
  });

  router.get('/:artifactId', async (req, res) => {
    const scope = scopeFrom(res);
    if (!scope) return unauthenticated(res);
    const artifactId = artifactIdSchema.safeParse(req.params['artifactId']);
    if (!artifactId.success) {
      res.status(400).json({ ok: false, error: 'invalid_artifact_id' });
      return;
    }
    const found = await deps.artifacts.get({ ...scope, artifactId: artifactId.data });
    if (!found.ok) {
      log.error('artifacts.get_failed', { error: String(found.error) });
      res.status(500).json({ ok: false, error: 'artifacts_unavailable' });
      return;
    }
    // Somebody else's artifact and a nonexistent one answer identically. The
    // difference is only interesting to someone probing for ids.
    if (!found.value) {
      res.status(404).json({ ok: false, error: 'artifact_not_found' });
      return;
    }
    res.json({ ok: true, artifact: found.value });
  });

  return router;
}

function unauthenticated(res: Response): void {
  res.status(401).json({ ok: false, error: 'unauthenticated' });
}

function scopeFrom(res: Response): { companyId: string; userId: string } | null {
  const companyId = res.locals['companyId'] as string | undefined;
  const userId = res.locals['userId'] as string | undefined;
  if (!companyId || !userId) return null;
  return { companyId, userId };
}
