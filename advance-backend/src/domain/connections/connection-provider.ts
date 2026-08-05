/**
 * Canonical connected-account providers.
 *
 * Keep provider identifiers here so persistence, gateway validation, runtime
 * discovery, and tool-family metadata cannot silently drift apart.
 */
export const CONNECTION_PROVIDER_IDS = [
  'google_workspace',
  'zoho',
  'canva',
  'airtable',
  'aitable',
  'lark',
  'shopify',
] as const;

export type ConnectionProvider = typeof CONNECTION_PROVIDER_IDS[number];

export const CONNECTION_PROVIDER_LABELS: Readonly<Record<ConnectionProvider, string>> = {
  google_workspace: 'Google Workspace',
  zoho: 'Zoho',
  canva: 'Canva',
  airtable: 'Airtable',
  aitable: 'AITable',
  lark: 'Lark',
  shopify: 'Shopify',
};

export function isConnectionProvider(value: string): value is ConnectionProvider {
  return (CONNECTION_PROVIDER_IDS as readonly string[]).includes(value);
}
