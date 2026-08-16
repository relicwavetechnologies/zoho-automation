import type { CanonicalToolId } from '../../domain/tools/tool-id';

const MAX_PROTECTED_REFERENCES = 100;
const SHOPIFY_RESOURCE_ID = /^gid:\/\/shopify\/(Customer|Order)\/[1-9][0-9]*$/;

export interface ShopifyProtectedReference {
  readonly provider: 'shopify';
  readonly connectionId: string;
  readonly resourceType: 'customer' | 'order';
  readonly resourceId: string;
}

export interface ShopifyProtectedResult {
  readonly used: true;
  readonly provider: 'shopify';
  readonly connectionId: string;
  readonly category: 'customers' | 'orders';
  readonly references: readonly ShopifyProtectedReference[];
  readonly referencesTruncated?: true;
}

/**
 * The Shopify capabilities, named as the canonical registry names them.
 *
 * Typed as `CanonicalToolId` rather than as strings, which is the whole point:
 * these ids decide whether a run's output may be retained at all, and they were
 * three bare string literals with nothing tying them to the registry that
 * defines them. Renaming a capability in `tool-id.ts` would have left this
 * matching nothing — and a predicate that silently stops recognising protected
 * data does not fail loudly, it simply starts keeping customer records.
 *
 * With the annotation, that rename is a compile error here.
 */
const SHOPIFY_TOOL_IDS: readonly CanonicalToolId[] =
  ['shopifyAnalytics', 'shopifyOrders', 'shopifyCustomers'];

/**
 * The two that read personal data.
 *
 * Analytics is aggregate and is deliberately not here. Everything downstream of
 * this — suppressed result content, transient delivery, the destruction of a
 * durable session — hangs off the answer.
 */
const PROTECTED_SHOPIFY_TOOL_IDS: readonly CanonicalToolId[] =
  ['shopifyOrders', 'shopifyCustomers'];

export function isShopifyToolId(toolId: string): boolean {
  return (SHOPIFY_TOOL_IDS as readonly string[]).includes(toolId);
}

export function isProtectedShopifyToolId(toolId: string): boolean {
  return (PROTECTED_SHOPIFY_TOOL_IDS as readonly string[]).includes(toolId);
}

/**
 * Classify only backend-registered protected Shopify tools. Arguments have
 * already passed the tool's closed Zod schema before this function runs.
 */
export function classifyShopifyProtectedResult(input: {
  readonly toolId: string;
  readonly args: Record<string, unknown>;
  readonly result: unknown;
}): ShopifyProtectedResult | undefined {
  if (!isProtectedShopifyToolId(input.toolId)) return undefined;
  const category = input.toolId === 'shopifyCustomers'
    ? 'customers'
    : 'orders';

  const connectionId = input.args['connectionId'];
  if (typeof connectionId !== 'string' || !connectionId.trim()) {
    // This should be unreachable after Shopify schema validation. Refusing to
    // emit an unbound marker is safer than inventing connection provenance.
    return undefined;
  }

  const expectedType = category === 'customers' ? 'Customer' : 'Order';
  const ids = new Set<string>();
  const directId = category === 'customers' ? input.args['customerId'] : input.args['orderId'];
  collectId(directId, expectedType, ids);
  collectIds(input.result, expectedType, ids, new Set<object>());

  const references = [...ids];
  return {
    used: true,
    provider: 'shopify',
    connectionId,
    category,
    references: references.slice(0, MAX_PROTECTED_REFERENCES).map(resourceId => ({
      provider: 'shopify',
      connectionId,
      resourceType: category === 'customers' ? 'customer' : 'order',
      resourceId,
    })),
    ...(references.length > MAX_PROTECTED_REFERENCES ? { referencesTruncated: true as const } : {}),
  };
}

function collectIds(
  value: unknown,
  expectedType: 'Customer' | 'Order',
  ids: Set<string>,
  seen: Set<object>,
): void {
  if (ids.size > MAX_PROTECTED_REFERENCES || value === null || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) collectIds(entry, expectedType, ids, seen);
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'id' || key === 'orderId' || key === 'customerId') collectId(entry, expectedType, ids);
    collectIds(entry, expectedType, ids, seen);
    if (ids.size > MAX_PROTECTED_REFERENCES) return;
  }
}

function collectId(value: unknown, expectedType: 'Customer' | 'Order', ids: Set<string>): void {
  if (
    typeof value === 'string'
    && SHOPIFY_RESOURCE_ID.test(value)
    && value.startsWith(`gid://shopify/${expectedType}/`)
  ) ids.add(value);
}
