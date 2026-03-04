import type { ZohoConnectionDTO } from '../../contracts';

export type ZohoConnectInput = {
  authorizationCode: string;
  scopes: string[];
};

export type ZohoConnectResult = ZohoConnectionDTO & {
  provider: 'zoho';
};

export class ZohoConnectionAdapter {
  async connect(input: ZohoConnectInput, companyId: string): Promise<ZohoConnectResult> {
    const now = new Date().toISOString();

    return {
      provider: 'zoho',
      companyId,
      status: input.authorizationCode.trim().length > 0 ? 'CONNECTED' : 'FAILED',
      connectedAt: now,
      scopes: input.scopes,
    };
  }
}

export const zohoConnectionAdapter = new ZohoConnectionAdapter();
