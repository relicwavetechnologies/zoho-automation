/**
 * AirNote auth middleware.
 *
 * AirNote and Divo both authenticate against the SAME Lark app/org, so the Lark
 * `open_id` is a shared, stable identity key. The AirNote client presents the
 * end user's Lark **user_access_token** (from AirNote's own Lark OAuth). We:
 *   1. verify that token against Lark (`getUserInfo`) to obtain a TRUSTED open_id
 *      and tenant_key — never trust a client-supplied open_id (spoofable),
 *   2. resolve the Divo user within that installation via the same tenant-scoped
 *      resolver the Lark webhook channel uses. An `open_id` is only unique per
 *      Lark app installation, so resolving without the tenant key can select an
 *      identity belonging to a different tenant that reuses the same open_id.
 *
 * On success sets:
 *   res.locals.userId, .companyId, .aiRole, .larkOpenId, .email, .departmentId, .displayName?
 */

import type { Request, Response, NextFunction } from 'express';
import type { LarkOAuthService } from '../../infrastructure/lark/lark-oauth.service';
import type { ChannelIdentityRepository } from '../../infrastructure/persistence/channel-identity.repository';
import type { Logger } from '../../shared/logger';

export interface AirnoteAuthMiddlewareDeps {
  larkOAuthService:    LarkOAuthService;
  channelIdentityRepo: ChannelIdentityRepository;
  logger:              Logger;
}

export function createAirnoteAuthMiddleware(deps: AirnoteAuthMiddlewareDeps) {
  const log = deps.logger.child({ service: 'airnote-auth' });

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authHeader = req.headers['authorization'];
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : undefined;
    if (!token) {
      res.status(401).json({ error: 'Missing Lark user access token' });
      return;
    }

    // 1. Verify the token with Lark → trusted open_id.
    let larkOpenId: string;
    let larkTenantKey: string | null = null;
    let larkEmail: string | null = null;
    try {
      const info = await deps.larkOAuthService.getUserInfo(token);
      larkOpenId    = info.larkOpenId;
      larkTenantKey = info.tenantKey;
      larkEmail     = info.larkEmail;
    } catch (e) {
      log.warn('airnote-auth.lark_verify_failed', { error: e instanceof Error ? e.message : String(e) });
      res.status(401).json({ error: 'Invalid or expired Lark token' });
      return;
    }
    if (!larkOpenId) {
      res.status(401).json({ error: 'Lark token did not resolve to a user' });
      return;
    }
    // Fail closed rather than falling back to an unscoped open_id lookup: an
    // installation we cannot name is one we cannot authorize against.
    if (!larkTenantKey) {
      log.warn('airnote-auth.tenant_missing', { larkOpenId });
      res.status(401).json({ error: 'Lark token did not resolve to a workspace' });
      return;
    }

    // 2. Resolve the Divo user within the verified Lark installation.
    const resolved = await deps.channelIdentityRepo.resolveByLarkTenantIdentity(
      larkOpenId,
      larkTenantKey,
    );
    if (!resolved.ok || !resolved.value) {
      log.warn('airnote-auth.user_not_linked', { larkOpenId, larkTenantKey });
      res.status(403).json({
        error: 'This Lark user is not connected to Divo yet. Open Divo in Lark once to link your account.',
      });
      return;
    }

    const id = resolved.value;
    res.locals['userId']       = id.userId;
    res.locals['companyId']    = id.companyId;
    res.locals['aiRole']       = id.aiRole;
    res.locals['larkOpenId']   = larkOpenId;
    res.locals['email']        = id.email ?? larkEmail ?? null;
    res.locals['departmentId'] = id.activeDepartmentId ?? null;
    if (id.displayName) res.locals['displayName'] = id.displayName;
    next();
  };
}
