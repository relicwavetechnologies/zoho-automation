import type { ToolActionGroup } from '../permissions/tool-action-group';

export type ZohoService = 'crm' | 'books';

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
): boolean {
  const normalized = normalizedScopes(scopes);
  if (service === 'books') {
    return action === 'read'
      ? normalized.has('zohobooks.fullaccess.read') || normalized.has('zohobooks.fullaccess.all')
      : normalized.has('zohobooks.fullaccess.all');
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
