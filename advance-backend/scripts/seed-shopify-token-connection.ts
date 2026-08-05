import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaClient } from '../src/generated/prisma';
import { IntegrationConnectionRepository } from '../src/infrastructure/persistence/integration-connection.repository';
import { ShopifyAdminClient } from '../src/infrastructure/shopify/shopify-admin.client';
import { normalizeShopDomain } from '../src/domain/shopify/shopify-shop';

/**
 * Dev-only: seed a Shopify store from a private Admin API token and grant
 * department RBAC for Agent Seat / local testing.
 *
 * Production stores must use Partner OAuth. Never commit tokens or `.env`.
 *
 * Requires in advance-backend/.env:
 *   SHOPIFY_E2E_SHOP=your-dev-store.myshopify.com
 *   SHOPIFY_E2E_ACCESS_TOKEN=shpat_...
 *   SHOPIFY_E2E_SCOPES=read_reports,read_orders,read_customers   (optional)
 *   DATABASE_URL, INTEGRATION_TOKEN_ENCRYPTION_KEY
 *
 * Usage:
 *   pnpm tsx scripts/seed-shopify-token-connection.ts --user anish@emiactech.com
 *   pnpm tsx scripts/seed-shopify-token-connection.ts --user anish@emiactech.com --dry-run
 *   pnpm tsx scripts/seed-shopify-token-connection.ts --session   # read .agent-seat/session.json
 */

const SHOPIFY_TOOL_IDS = ['shopifyAnalytics', 'shopifyOrders', 'shopifyCustomers'] as const;
const ACTION_GROUPS = ['read'] as const;

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index < 0 ? undefined : process.argv[index + 1];
}

async function resolveActor(
  prisma: PrismaClient,
  input: { readonly userSelector?: string; readonly departmentId?: string },
): Promise<{ userId: string; companyId: string; email: string; departmentId: string; roleId: string; roleName: string }> {
  if (process.argv.includes('--session')) {
    const raw = await readFile(join(process.cwd(), '.agent-seat', 'session.json'), 'utf8');
    const session = JSON.parse(raw) as {
      userId?: string;
      companyId?: string;
      departmentId?: string;
      email?: string;
    };
    if (!session.userId || !session.companyId || !session.departmentId) {
      throw new Error('Agent Seat session is missing userId, companyId, or departmentId. Run agent-seat init first.');
    }
    const membership = await prisma.departmentMembership.findFirst({
      where: {
        userId: session.userId,
        departmentId: input.departmentId ?? session.departmentId,
        status: 'active',
      },
      include: { role: { select: { id: true, name: true } } },
    });
    if (!membership) throw new Error('Active department membership not found for Agent Seat session.');
    return {
      userId: session.userId,
      companyId: session.companyId,
      email: session.email ?? session.userId,
      departmentId: membership.departmentId,
      roleId: membership.roleId,
      roleName: membership.role.name,
    };
  }

  const userSelector = input.userSelector?.trim();
  if (!userSelector) {
    throw new Error('Pass --user <email|userId> or --session with an initialized Agent Seat session.');
  }

  const user = await prisma.user.findFirst({
    where: {
      OR: [
        { email: { equals: userSelector, mode: 'insensitive' } },
        { id: userSelector },
      ],
    },
    select: { id: true, email: true },
  });
  if (!user) throw new Error(`User not found for selector: ${userSelector}`);

  const admin = await prisma.adminMembership.findFirst({
    where: { userId: user.id, isActive: true },
    select: { companyId: true },
    orderBy: { createdAt: 'asc' },
  });
  if (!admin) throw new Error(`No active company membership for ${user.email}`);

  const membership = await prisma.departmentMembership.findFirst({
    where: {
      userId: user.id,
      status: 'active',
      department: { companyId: admin.companyId, status: 'active' },
      ...(input.departmentId ? { departmentId: input.departmentId } : {}),
    },
    include: { role: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'asc' },
  });
  if (!membership) {
    throw new Error(`No active department membership for ${user.email}; pass --department <id> if needed.`);
  }

  return {
    userId: user.id,
    companyId: admin.companyId,
    email: user.email,
    departmentId: membership.departmentId,
    roleId: membership.roleId,
    roleName: membership.role.name,
  };
}

async function grantShopifyDepartmentAccess(input: {
  readonly prisma: PrismaClient;
  readonly actor: Awaited<ReturnType<typeof resolveActor>>;
  readonly dryRun: boolean;
}): Promise<number> {
  let written = 0;
  for (const toolId of SHOPIFY_TOOL_IDS) {
    for (const actionGroup of ACTION_GROUPS) {
      if (input.dryRun) {
        console.log(`would grant ${toolId}:${actionGroup} to ${input.actor.roleName} (${input.actor.departmentId})`);
        continue;
      }
      const existing = await input.prisma.departmentToolPermission.findFirst({
        where: {
          departmentId: input.actor.departmentId,
          roleId: input.actor.roleId,
          toolId,
          actionGroup,
        },
        select: { id: true },
      });
      if (existing) {
        await input.prisma.departmentToolPermission.update({
          where: { id: existing.id },
          data: { allowed: true, updatedBy: input.actor.userId },
        });
      } else {
        await input.prisma.departmentToolPermission.create({
          data: {
            departmentId: input.actor.departmentId,
            roleId: input.actor.roleId,
            toolId,
            actionGroup,
            allowed: true,
            updatedBy: input.actor.userId,
          },
        });
      }
      written += 1;
    }
  }
  return written;
}

async function main(): Promise<void> {
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('Refusing to seed Shopify tokens in production.');
  }

  const shop = normalizeShopDomain(process.env['SHOPIFY_E2E_SHOP'] ?? '');
  const accessToken = process.env['SHOPIFY_E2E_ACCESS_TOKEN']?.trim();
  if (!shop || !accessToken) {
    throw new Error('Set SHOPIFY_E2E_SHOP and SHOPIFY_E2E_ACCESS_TOKEN in advance-backend/.env');
  }
  if (!process.env['DATABASE_URL']) throw new Error('DATABASE_URL is required.');
  if (!process.env['INTEGRATION_TOKEN_ENCRYPTION_KEY']) {
    throw new Error('INTEGRATION_TOKEN_ENCRYPTION_KEY is required.');
  }

  const dryRun = process.argv.includes('--dry-run');
  const apiVersion = process.env['SHOPIFY_API_VERSION'] ?? '2026-07';
  const scopes = (process.env['SHOPIFY_E2E_SCOPES'] ?? 'read_reports,read_orders,read_customers')
    .split(',')
    .map(scope => scope.trim())
    .filter(Boolean);

  const prisma = new PrismaClient();
  try {
    const actor = await resolveActor(prisma, {
      userSelector: argValue('--user'),
      departmentId: argValue('--department'),
    });
    const client = new ShopifyAdminClient({ apiVersion, timeoutMs: 20_000, maxRetries: 2 });
    const identity = await client.query<{ shop: { id: string; name: string; myshopifyDomain: string } }>({
      shop,
      accessToken,
      query: 'query DivoSeedIdentity { shop { id name myshopifyDomain } }',
    });
    const resolvedShop = normalizeShopDomain(identity.data.shop.myshopifyDomain);
    if (resolvedShop !== shop) {
      throw new Error(`Token shop domain mismatch: expected ${shop}, got ${resolvedShop}.`);
    }

    console.log(`Validated Shopify token for ${identity.data.shop.name} (${resolvedShop}).`);
    if (dryRun) {
      console.log(`Dry run for ${actor.email} @ ${actor.companyId} / dept ${actor.departmentId}.`);
      await grantShopifyDepartmentAccess({ prisma, actor, dryRun: true });
      return;
    }

    const repository = new IntegrationConnectionRepository(prisma, process.env as never);
    const saved = await repository.upsertShopifyConnection({
      companyId: actor.companyId,
      ownerType: 'company',
      createdBy: actor.userId,
      shopDomain: shop,
      shopName: identity.data.shop.name,
      shopGraphqlId: identity.data.shop.id,
      accessToken,
      scopes,
      apiVersion,
    });
    if (!saved.ok) throw saved.error;

    const grantsWritten = await grantShopifyDepartmentAccess({ prisma, actor, dryRun: false });

    console.log(JSON.stringify({
      status: 'seeded',
      shopDomain: resolvedShop,
      shopName: identity.data.shop.name,
      connectionId: saved.value.id,
      companyId: actor.companyId,
      userId: actor.userId,
      email: actor.email,
      departmentId: actor.departmentId,
      roleName: actor.roleName,
      scopes,
      departmentGrantsWritten: grantsWritten,
      next: [
        'pnpm tsx scripts/agent-seat.ts gateway \'{"op":"connections.list","payload":{"provider":"shopify"}}\'',
        `pnpm tsx scripts/agent-seat.ts invoke shopifyAnalytics '{"connectionId":"${saved.value.id}","operation":"sales_summary","metrics":["total_sales","orders"],"period":{"kind":"preset","value":"last_30_days"}}'`,
      ],
    }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
