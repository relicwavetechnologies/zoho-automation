const SHOP_DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/;

/** Normalize only Shopify's canonical shop host; never accept arbitrary URLs. */
export function normalizeShopDomain(value: string): string | null {
  const candidate = value.trim().toLowerCase();
  const domain = candidate.endsWith('.myshopify.com')
    ? candidate
    : `${candidate}.myshopify.com`;
  return SHOP_DOMAIN.test(domain) ? domain : null;
}

export function isShopifyGraphqlId(value: string, resource: 'Shop' | 'Order' | 'Customer'): boolean {
  return new RegExp(`^gid://shopify/${resource}/[1-9][0-9]*$`).test(value);
}
