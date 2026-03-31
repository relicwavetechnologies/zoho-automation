import 'dotenv/config';

import config from '../src/config';
import { prisma } from '../src/utils/prisma';
import { LarkTenantTokenService } from '../src/company/channels/lark/lark-tenant-token.service';
import { larkWorkspaceConfigRepository } from '../src/company/channels/lark/lark-workspace-config.repository';

type LarkUserProfilePayload = {
  code?: number;
  msg?: string;
  data?: {
    user?: {
      email?: string;
      en_name?: string;
      name?: string;
    };
  };
};

const readEmail = (payload: LarkUserProfilePayload): string | null => {
  const email = payload.data?.user?.email;
  if (typeof email !== 'string') {
    return null;
  }
  const trimmed = email.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const main = async () => {
  const rows = await prisma.channelIdentity.findMany({
    where: {
      channel: 'lark',
      email: null,
    },
    select: {
      id: true,
      companyId: true,
      larkOpenId: true,
      larkUserId: true,
    },
    orderBy: [
      { companyId: 'asc' },
      { id: 'asc' },
    ],
  });

  if (rows.length === 0) {
    console.log('No null-email Lark channel identities found.');
    return;
  }

  let resolvedCount = 0;
  let unresolvedCount = 0;
  const tokenServices = new Map<string, LarkTenantTokenService>();

  for (const row of rows) {
    const openId = row.larkOpenId?.trim();
    if (!openId) {
      console.log(`unresolved: ${row.larkOpenId ?? row.larkUserId ?? row.id} — missing open id`);
      unresolvedCount += 1;
      continue;
    }

    let tokenService = tokenServices.get(row.companyId);
    if (!tokenService) {
      const workspaceConfig = await larkWorkspaceConfigRepository.findByCompanyId(row.companyId);
      tokenService = new LarkTenantTokenService({
        apiBaseUrl: workspaceConfig?.apiBaseUrl ?? config.LARK_API_BASE_URL,
        appId: workspaceConfig?.appId,
        appSecret: workspaceConfig?.appSecret,
        staticToken: workspaceConfig?.staticTenantAccessToken,
      });
      tokenServices.set(row.companyId, tokenService);
    }

    try {
      const token = await tokenService.getAccessToken();
      const workspaceConfig = await larkWorkspaceConfigRepository.findByCompanyId(row.companyId);
      const apiBaseUrl = workspaceConfig?.apiBaseUrl ?? config.LARK_API_BASE_URL;
      const query = new URLSearchParams({
        user_id_type: 'open_id',
        fields: 'email,en_name,name',
      });

      const response = await fetch(
        `${apiBaseUrl}/open-apis/contact/v3/users/${encodeURIComponent(openId)}?${query.toString()}`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        },
      );

      let payload: LarkUserProfilePayload = {};
      try {
        payload = (await response.json()) as LarkUserProfilePayload;
      } catch {
        payload = {};
      }

      if (!response.ok || payload.code !== 0) {
        console.log(
          `unresolved: ${openId} — Lark API error ${response.status}${payload.msg ? ` (${payload.msg})` : ''}`,
        );
        unresolvedCount += 1;
        continue;
      }

      const email = readEmail(payload);
      if (!email) {
        console.log(`unresolved: ${openId} — no email in Lark profile`);
        unresolvedCount += 1;
        continue;
      }

      await prisma.channelIdentity.update({
        where: { id: row.id },
        data: { email },
      });
      console.log(`resolved: ${openId} -> ${email}`);
      resolvedCount += 1;
    } catch (error) {
      console.log(
        `unresolved: ${openId} — ${error instanceof Error ? error.message : 'unknown_error'}`,
      );
      unresolvedCount += 1;
    }
  }

  console.log(`resolved=${resolvedCount} unresolved=${unresolvedCount}`);
};

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
