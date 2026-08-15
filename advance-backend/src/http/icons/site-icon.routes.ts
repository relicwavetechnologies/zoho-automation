import { Router } from 'express';
import type { Logger } from '../../shared/logger';
import { normalizeDomain, type SiteIconService } from '../../application/icons/site-icon.service';

/**
 * A site's icon, served from our own origin.
 *
 * **Unauthenticated, and that is a decision rather than an oversight.** These
 * are drawn by `<img src>`, and an image element cannot carry an Authorization
 * header — the browser fetches it, not our client code. Cookie auth would work
 * and is worse: it would mean every icon request carried a session, to an
 * endpoint whose entire job is to reach out to the public internet.
 *
 * What stops it being an open proxy is the shape of what it accepts. There is
 * no URL parameter. A caller supplies a *domain*, which is matched against a
 * strict allowlist of shapes, and the paths fetched from it are ones this file
 * chose — the homepage, and whatever icon that homepage declares. Nothing here
 * can be aimed. `guardedFetch` refuses private addresses, non-image responses
 * and anything over 256KB, so the worst an anonymous caller achieves is making
 * us request one favicon they could have requested themselves, once, because
 * the answer is then cached for a month.
 *
 * A miss is a 404 rather than a placeholder image. The surface already draws a
 * monogram for a domain it cannot picture, and that is a better fallback than
 * anything this route could invent — sending a grey square would replace it.
 */
export function createSiteIconRoutes(deps: {
  readonly icons: SiteIconService;
  readonly logger: Logger;
}): Router {
  const router = Router();

  router.get('/:domain', async (req, res) => {
    const domain = normalizeDomain(String(req.params.domain ?? ''));
    if (!domain) {
      res.status(400).json({ error: 'malformed domain' });
      return;
    }

    try {
      const icon = await deps.icons.iconFor(domain);
      if (!icon) {
        /* Cached at the edge too. The domains with no icon are exactly the ones
           that would otherwise be asked for on every render, forever. */
        res.set('Cache-Control', 'public, max-age=86400');
        res.status(404).json({ error: 'no icon' });
        return;
      }

      res.set('Content-Type', icon.contentType);
      res.set('Cache-Control', 'public, max-age=604800, stale-while-revalidate=2592000');
      /* An image is not a document and must never be treated as one: an SVG
         favicon served inline is a script that runs on our origin. */
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
      res.send(icon.body);
    } catch (error) {
      deps.logger.error('site_icon_failed', { domain, err: String(error) });
      res.status(404).json({ error: 'no icon' });
    }
  });

  return router;
}
