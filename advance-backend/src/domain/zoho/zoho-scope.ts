import type { ToolActionGroup } from '../permissions/tool-action-group';

export type ZohoService = 'crm' | 'books';
export type ZohoBooksScopeModule = 'bills' | 'invoices' | 'purchaseorders';

const normalizedScopes = (scopes: readonly string[]) =>
  new Set(scopes.map(scope => scope.trim().toLowerCase()).filter(Boolean));

export function zohoServicesForScopes(scopes: readonly string[]): ZohoService[] {
  const normalized = normalizedScopes(scopes);
  const services: ZohoService[] = [];
  if ([...normalized].some(scope => scope.startsWith('zohocrm.'))) services.push('crm');
  if ([...normalized].some(scope => scope.startsWith('zohobooks.'))) services.push('books');
  return services;
}

export function hasZohoScope(
  scopes: readonly string[],
  service: ZohoService,
  action: ToolActionGroup,
  booksModule?: ZohoBooksScopeModule,
): boolean {
  const normalized = normalizedScopes(scopes);
  if (service === 'books') {
    if (normalized.has('zohobooks.fullaccess.all')) return true;
    if (action === 'read' && normalized.has('zohobooks.fullaccess.read')) return true;
    if (!booksModule || !['read', 'create', 'update', 'delete'].includes(action)) return false;

    return normalized.has(`zohobooks.${booksModule}.${action}`)
      || normalized.has(`zohobooks.${booksModule}.all`);
  }

  const suffix = action === 'read'
    ? 'read'
    : action === 'create'
      ? 'create'
      : action === 'update'
        ? 'update'
        : 'delete';
  return normalized.has('zohocrm.modules.all') || normalized.has(`zohocrm.modules.${suffix}`);
}
