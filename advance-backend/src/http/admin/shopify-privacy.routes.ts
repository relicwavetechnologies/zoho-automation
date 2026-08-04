import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type {
  ShopifyPrivacyRepository,
  ShopifyPrivacyState,
} from '../../application/shopify/shopify-privacy.lifecycle';
import { SHOPIFY_PRIVACY_DELIVERY_CHANNELS } from '../../application/shopify/shopify-privacy.lifecycle';

const listQuery = z.object({
  companyId: z.string().trim().min(1).max(256).optional(),
  shopDomain: z.string().trim().min(1).max(256).optional(),
  states: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const requestQuery = z.object({
  companyId: z.string().trim().min(1).max(256).optional(),
  shopDomain: z.string().trim().min(1).max(256),
});

const deliveryAcknowledgementBody = z.object({
  companyId: z.string().trim().min(1).max(256).optional(),
  shopDomain: z.string().trim().min(1).max(256),
  channel: z.enum(SHOPIFY_PRIVACY_DELIVERY_CHANNELS),
  recipient: z.string().trim().min(1).max(256),
  receiptId: z.string().trim().min(1).max(256),
  deliveredAt: z.string().datetime({ offset: true }),
}).strict();

const allowedStates = new Set<ShopifyPrivacyState>([
  'received', 'ready', 'delivered', 'expired', 'redacted', 'failed',
]);

export function createShopifyPrivacyRoutes(deps: { repository: ShopifyPrivacyRepository }): Router {
  const router = Router();

  router.use((_req, res, next) => {
    const role = res.locals['adminRole'];
    if (role !== 'COMPANY_ADMIN' && role !== 'SUPER_ADMIN') {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    next();
  });

  router.get('/', asyncRoute(async (req, res) => {
    const query = listQuery.parse(req.query);
    const companyId = resolveCompanyId(res, query.companyId);
    const states = query.states?.split(',').map(value => value.trim()).filter(Boolean);
    if (states?.some(state => !allowedStates.has(state as ShopifyPrivacyState))) {
      throw routeError(400, 'states contains an unsupported lifecycle state');
    }
    const listed = await deps.repository.list({
      companyId,
      ...(query.shopDomain ? { shopDomain: query.shopDomain } : {}),
      ...(states ? { states: states as ShopifyPrivacyState[] } : {}),
      ...(query.limit ? { limit: query.limit } : {}),
    });
    if (!listed.ok) throw routeError(503, 'Shopify privacy storage is unavailable');
    res.status(200).json({ data: listed.value });
  }));

  router.get('/:id', asyncRoute(async (req, res) => {
    const query = requestQuery.parse(req.query);
    const companyId = resolveCompanyId(res, query.companyId);
    const found = await deps.repository.get({
      companyId,
      shopDomain: query.shopDomain,
      id: requiredRouteId(req),
      actorId: resolveActorId(res),
    });
    if (!found.ok) throw routeError(503, 'Shopify privacy storage is unavailable');
    if (!found.value) throw routeError(404, 'Shopify privacy request not found');
    res.status(200).json({ data: found.value });
  }));

  router.post('/:id/delivery-acknowledgement', asyncRoute(async (req, res) => {
    const body = deliveryAcknowledgementBody.parse(req.body);
    const companyId = resolveCompanyId(res, body.companyId);
    const id = requiredRouteId(req);
    const actorId = resolveActorId(res);
    const deliveredAt = new Date(body.deliveredAt);
    const delivered = await deps.repository.markDelivered({
      companyId,
      shopDomain: body.shopDomain,
      id,
      actorId,
      deliveryEvidence: {
        channel: body.channel,
        recipient: body.recipient,
        receiptId: body.receiptId,
        deliveredAt,
      },
    });
    if (!delivered.ok) throw routeError(503, 'Shopify privacy storage is unavailable');
    if (!delivered.value) {
      throw routeError(409, 'Shopify privacy request is missing, expired, or not ready for delivery acknowledgement');
    }
    res.status(200).json({
      data: {
        id,
        state: 'delivered',
        deliveredAt: deliveredAt.toISOString(),
      },
    });
  }));

  return router;
}

type RouteError = Error & { status: number };

function routeError(status: number, message: string): RouteError {
  return Object.assign(new Error(message), { status });
}

function asyncRoute(handler: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      await handler(req, res);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: 'invalid_request', message: error.issues[0]?.message ?? 'Invalid request' });
        return;
      }
      if (error instanceof Error && 'status' in error) {
        const routed = error as RouteError;
        res.status(routed.status).json({ error: 'shopify_privacy_request_failed', message: routed.message });
        return;
      }
      throw error;
    }
  };
}

function resolveCompanyId(res: Response, provided?: string): string {
  const local = typeof res.locals['companyId'] === 'string' ? res.locals['companyId'] : '';
  if (res.locals['isSuperAdmin'] === true) {
    if (!provided) throw routeError(400, 'companyId is required for super-admin requests');
    return provided;
  }
  if (!local || (provided && provided !== local)) throw routeError(403, 'Access denied: company mismatch');
  return local;
}

function resolveActorId(res: Response): string {
  return typeof res.locals['userId'] === 'string' ? res.locals['userId'] : 'super-admin:internal';
}

function requiredRouteId(req: Request): string {
  const id = req.params['id'];
  if (!id || id.length > 256) throw routeError(400, 'A valid privacy request id is required');
  return id;
}
