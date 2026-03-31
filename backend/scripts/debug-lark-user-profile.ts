import 'dotenv/config';

import config from '../src/config';
import { LarkTenantTokenService } from '../src/company/channels/lark/lark-tenant-token.service';
import { larkWorkspaceConfigRepository } from '../src/company/channels/lark/lark-workspace-config.repository';

const TARGET_COMPANY_ID = '9f9360aa-28d1-49df-919f-3b121b7403df';
const TARGET_OPEN_ID = 'ou_45d30a74199a51a413585b091f213f55';

const main = async () => {
  const workspaceConfig = await larkWorkspaceConfigRepository.findByCompanyId(TARGET_COMPANY_ID);

  const tokenService = new LarkTenantTokenService({
    apiBaseUrl: workspaceConfig?.apiBaseUrl ?? config.LARK_API_BASE_URL,
    appId: workspaceConfig?.appId,
    appSecret: workspaceConfig?.appSecret,
    staticToken: workspaceConfig?.staticTenantAccessToken,
  });

  const token = await tokenService.getAccessToken();
  const apiBaseUrl = workspaceConfig?.apiBaseUrl ?? config.LARK_API_BASE_URL;
  const query = new URLSearchParams({
    user_id_type: 'open_id',
    fields: 'email,en_name,name,enterprise_email,job_title,mobile',
  });

  const response = await fetch(
    `${apiBaseUrl}/open-apis/contact/v3/users/${encodeURIComponent(TARGET_OPEN_ID)}?${query.toString()}`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    },
  );

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = { error: 'non_json_response' };
  }

  console.log(JSON.stringify(payload, null, 2));
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
