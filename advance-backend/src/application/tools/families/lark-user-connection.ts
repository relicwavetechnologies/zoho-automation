import type { ToolExecutionContext } from '../tool.contract';

export type LarkConnectionAccess = 'read_only' | 'read_write';

export interface LarkConnectionChoice {
  readonly connectionId: string;
  readonly label: string;
  readonly accountEmail?: string;
  readonly accountName?: string;
  readonly access: 'read_only' | 'read_write' | 'admin';
}

export type LarkUserTokenResolution =
  | { readonly status: 'resolved'; readonly accessToken: string }
  | { readonly status: 'unavailable' }
  | { readonly status: 'choose_connection'; readonly connections: readonly LarkConnectionChoice[] };

export type LarkUserClientResolution<TClient> =
  | { readonly status: 'resolved'; readonly client: TClient }
  | { readonly status: 'unavailable' }
  | { readonly status: 'choose_connection'; readonly connections: readonly LarkConnectionChoice[] };

/**
 * Resolves a Divo-managed Lark connection to a short-lived user-token client.
 * The resolver remains backend-owned: tools receive neither credentials nor
 * permission decisions directly.
 */
export interface LarkUserTokenResolver {
  resolve(input: {
    userId: string;
    companyId: string;
    connectionId?: string;
    minimumAccess: LarkConnectionAccess;
  }): Promise<string | null | LarkUserTokenResolution>;
}

export interface LarkUserClientFactory<TClient> {
  readonly userTokenResolver?: LarkUserTokenResolver;
  readonly createUserClient?: (userToken: string) => TClient;
}

export async function resolveLarkUserClient<TClient>(
  deps: LarkUserClientFactory<TClient>,
  ctx: ToolExecutionContext,
  input: {
    connectionId?: string;
    minimumAccess: LarkConnectionAccess;
  },
): Promise<LarkUserClientResolution<TClient>> {
  // Unit-level clients may intentionally omit both dependencies. Production
  // composition always supplies the pair, so it never falls back to a tenant
  // credential when a managed Lark connection is unavailable.
  if (!deps.userTokenResolver && !deps.createUserClient) return { status: 'unavailable' };
  if (!deps.userTokenResolver || !deps.createUserClient) {
    throw new Error('Lark user-connection dependencies are incomplete');
  }

  const result = await deps.userTokenResolver.resolve({
    userId: String(ctx.runContext.userId),
    companyId: String(ctx.runContext.companyId),
    ...(input.connectionId ? { connectionId: input.connectionId } : {}),
    minimumAccess: input.minimumAccess,
  });
  if (typeof result === 'object' && result !== null) {
    if (result.status === 'choose_connection') return result;
    if (result.status === 'unavailable') return result;
    return { status: 'resolved', client: deps.createUserClient(result.accessToken) };
  }
  return result
    ? { status: 'resolved', client: deps.createUserClient(result) }
    : { status: 'unavailable' };
}

export const larkConnectionRequiredMessage =
  'Connect a Lark account or choose one shared with you before using Lark tools.';

export function larkConnectionSelectionData(connections: readonly LarkConnectionChoice[]) {
  return { code: 'lark_connection_selection_required', connections };
}
