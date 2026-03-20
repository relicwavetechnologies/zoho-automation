export const REQUIRED_ZOHO_OAUTH_SCOPES = [
  'ZohoCRM.modules.ALL',
  'ZohoCRM.coql.READ',
  'ZohoCRM.settings.fields.READ',
  'ZohoCRM.settings.modules.READ',
  'ZohoCRM.modules.notes.ALL',
  'ZohoCRM.modules.attachments.ALL',
  'ZohoBooks.contacts.ALL',
  'ZohoBooks.settings.READ',
  'ZohoBooks.settings.CREATE',
  'ZohoBooks.accountants.READ',
  'ZohoBooks.estimates.ALL',
  'ZohoBooks.invoices.ALL',
  'ZohoBooks.creditnotes.ALL',
  'ZohoBooks.customerpayments.ALL',
  'ZohoBooks.bills.ALL',
  'ZohoBooks.salesorders.ALL',
  'ZohoBooks.purchaseorders.ALL',
  'ZohoBooks.vendorpayments.ALL',
  'ZohoBooks.banking.ALL',
] as const;

const toNormalizedScopeList = (value: string | string[] | undefined): string[] => {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return raw
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
};

export const resolveZohoOAuthScopes = (value?: string | string[]): string[] => {
  const resolved = new Set<string>(REQUIRED_ZOHO_OAUTH_SCOPES);
  for (const scope of toNormalizedScopeList(value)) {
    resolved.add(scope);
  }
  return [...resolved];
};
