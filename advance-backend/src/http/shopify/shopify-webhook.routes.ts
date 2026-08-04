import { createHmac, timingSafeEqual } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import type { Logger } from '../../shared/logger';
import type { ShopifyWebhookRepository } from '../../infrastructure/persistence/shopify-webhook.repository';
import { normalizeShopDomain } from '../../domain/shopify/shopify-shop';

const SUPPORTED_TOPICS = new Set([
  'app/uninstalled',
  'customers/data_request',
  'customers/redact',
  'shop/redact',
]);

export function createShopifyWebhookRoutes(deps: {
  readonly clientSecret?: string;
  readonly repository: ShopifyWebhookRepository;
  readonly logger: Logger;
}): Router {
  const router = Router();
  const log = deps.logger.child({ router: 'shopify-webhook' });
  router.post('/', async (req: Request, res: Response) => {
    const rawBody = (req as unknown as Record<string, unknown>)['rawBody'];
    const hmac = header(req, 'x-shopify-hmac-sha256');
    const webhookId = header(req, 'x-shopify-webhook-id');
    const topic = header(req, 'x-shopify-topic');
    const shopDomain = normalizeShopDomain(header(req, 'x-shopify-shop-domain'));
    if (!deps.clientSecret || typeof rawBody !== 'string' || !hmac || !webhookId || !topic || !shopDomain) {
      res.status(401).json({ error: 'invalid_shopify_webhook' });
      return;
    }
    if (!verifyHmac(rawBody, hmac, deps.clientSecret)) {
      res.status(401).json({ error: 'invalid_shopify_webhook' });
      return;
    }
    if (!SUPPORTED_TOPICS.has(topic)) {
      res.status(204).end();
      return;
    }
    let payload: unknown;
    try { payload = JSON.parse(rawBody); } catch {
      res.status(400).json({ error: 'invalid_shopify_webhook_payload' });
      return;
    }
    if (shopDomainFromPayloadForTopic(payload, topic, shopDomain) !== shopDomain) {
      res.status(400).json({ error: 'shopify_webhook_identity_mismatch' });
      return;
    }
    const action = topic === 'shop/redact' ? 'erase'
      : topic === 'app/uninstalled' ? 'revoke'
        : topic === 'customers/data_request' ? 'record_data_request'
          : 'purge_customer_traces';
    const privacyRequest = action === 'record_data_request' ? parseDataRequest(payload)
      : action === 'purge_customer_traces' ? parseCustomerRedaction(payload)
        : undefined;
    if ((action === 'record_data_request' || action === 'purge_customer_traces') && !privacyRequest) {
      res.status(400).json({ error: 'invalid_shopify_webhook_payload' });
      return;
    }
    const processed = await deps.repository.process({ webhookId, topic, shopDomain, action, ...(privacyRequest ? { privacyRequest } : {}) });
    if (!processed.ok) {
      res.status(503).json({ error: 'webhook_checkpoint_unavailable' });
      return;
    }
    if (processed.value.duplicate) {
      res.status(200).json({ ok: true, duplicate: true });
      return;
    }
    if (action === 'revoke') {
      log.info('shopify.webhook.store_revoked', { webhookId, topic, shopDomainHash: hashForLog(shopDomain), connections: processed.value.affectedConnections });
    } else if (action === 'erase') {
      log.info('shopify.webhook.store_erased', { webhookId, topic, shopDomainHash: hashForLog(shopDomain), connections: processed.value.affectedConnections });
    } else {
      // Divo has no customer replica. Any transient approval arguments/results
      // for this shop are erased atomically with the durable receipt.
      log.info('shopify.webhook.privacy_received', { webhookId, topic, shopDomainHash: hashForLog(shopDomain) });
    }
    res.status(200).json({ ok: true });
  });
  return router;
}

function parseDataRequest(payload: unknown): { requestId: string; customerId?: string; orderIds: string[] } | null {
  if (!payload || typeof payload !== 'object') return null;
  const value = payload as Record<string, unknown>;
  const request = value['data_request'];
  if (!request || typeof request !== 'object') return null;
  const requestId = (request as Record<string, unknown>)['id'];
  if (typeof requestId !== 'string' && typeof requestId !== 'number') return null;
  const customer = value['customer'];
  const customerId = customer && typeof customer === 'object' ? (customer as Record<string, unknown>)['id'] : undefined;
  const orders = Array.isArray(value['orders_requested']) ? value['orders_requested'] : [];
  if (orders.some(id => typeof id !== 'string' && typeof id !== 'number')) return null;
  if (typeof customerId !== 'string' && typeof customerId !== 'number' && orders.length === 0) return null;
  return {
    requestId: String(requestId),
    ...(typeof customerId === 'string' || typeof customerId === 'number' ? { customerId: String(customerId) } : {}),
    orderIds: orders.map(String),
  };
}

function parseCustomerRedaction(payload: unknown): { customerId?: string; orderIds: string[] } | null {
  if (!payload || typeof payload !== 'object') return null;
  const value = payload as Record<string, unknown>;
  const customer = value['customer'];
  const customerId = customer && typeof customer === 'object' ? (customer as Record<string, unknown>)['id'] : undefined;
  const orders = Array.isArray(value['orders_to_redact']) ? value['orders_to_redact'] : [];
  if (orders.some(id => typeof id !== 'string' && typeof id !== 'number')) return null;
  if (typeof customerId !== 'string' && typeof customerId !== 'number' && orders.length === 0) return null;
  return {
    ...(typeof customerId === 'string' || typeof customerId === 'number' ? { customerId: String(customerId) } : {}),
    orderIds: orders.map(String),
  };
}

function shopDomainFromPayloadForTopic(payload: unknown, topic: string, signedShopDomain: string): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const value = payload as Record<string, unknown>;
  if (topic === 'customers/data_request') {
    if (!Object.hasOwn(value, 'data_request') || !Object.hasOwn(value, 'orders_requested')) return null;
    return normalizeShopDomain(typeof value['shop_domain'] === 'string' ? value['shop_domain'] : '');
  }
  if (topic === 'customers/redact') {
    if (!Object.hasOwn(value, 'orders_to_redact') || Object.hasOwn(value, 'data_request')) return null;
    return normalizeShopDomain(typeof value['shop_domain'] === 'string' ? value['shop_domain'] : '');
  }
  if (topic === 'shop/redact') {
    if (!Object.hasOwn(value, 'shop_id') || Object.hasOwn(value, 'customer')) return null;
    return normalizeShopDomain(typeof value['shop_domain'] === 'string' ? value['shop_domain'] : '');
  }
  if (topic === 'app/uninstalled') {
    if (Object.hasOwn(value, 'data_request') || Object.hasOwn(value, 'orders_to_redact')) return null;
    const resourceId = value['id'];
    if (
      (typeof resourceId !== 'string' && typeof resourceId !== 'number')
      || !String(resourceId).trim()
    ) return null;

    const domainFields = ['myshopify_domain', 'domain'] as const;
    let hasDomainField = false;
    for (const field of domainFields) {
      if (!Object.hasOwn(value, field)) continue;
      hasDomainField = true;
      const embedded = value[field];
      if (embedded === null) continue;
      if (typeof embedded !== 'string' || normalizeShopDomain(embedded) !== signedShopDomain) return null;
    }
    return hasDomainField ? signedShopDomain : null;
  }
  return null;
}

function hashForLog(value: string): string {
  return createHmac('sha256', 'shopify-webhook-log').update(value).digest('hex').slice(0, 16);
}

function header(req: Request, name: string): string {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function verifyHmac(rawBody: string, supplied: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}
