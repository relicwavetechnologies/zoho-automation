import { PrismaClient } from '../src/generated/prisma';
import { zohoBooksClient } from '../src/company/integrations/zoho/zoho-books.client';
import { zohoHttpClient } from '../src/company/integrations/zoho/zoho-http.client';
import { zohoTokenService } from '../src/company/integrations/zoho/zoho-token.service';

const prisma = new PrismaClient();

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

const normalize = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const includesNeedle = (record: Record<string, unknown>, needleTokens: string[]): boolean => {
  const haystack = normalize(JSON.stringify(record));
  return needleTokens.every((token) => haystack.includes(token));
};

async function resolveRecentLarkCompany(): Promise<string> {
  const recentMessages = await prisma.desktopMessage.findMany({
    where: { thread: { channel: 'lark' } },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: {
      metadata: true,
      thread: { select: { companyId: true } },
    },
  });

  for (const recentMessage of recentMessages) {
    const larkMeta = asRecord(asRecord(recentMessage.metadata)?.lark);
    if (asString(larkMeta?.chatId)) {
      return recentMessage.thread.companyId;
    }
  }

  throw new Error('Could not resolve recent Lark company from desktopMessage metadata.');
}

async function fetchPagedModule(input: {
  companyId: string;
  organizationId: string;
  moduleName: 'contacts';
  token: string;
  perPage?: number;
  maxPages?: number;
  onPage?: (input: { organizationId: string; moduleName: 'contacts'; page: number; count: number }) => void;
}): Promise<Record<string, unknown>[]> {
  const perPage = input.perPage ?? 200;
  const maxPages = input.maxPages ?? 50;
  const results: Record<string, unknown>[] = [];

  for (let page = 1; page <= maxPages; page += 1) {
    const payload = await zohoHttpClient.requestJson<Record<string, unknown>>({
      base: 'api',
      path:
        `/books/v3/${input.moduleName}`
        + `?organization_id=${encodeURIComponent(input.organizationId)}`
        + `&page=${page}`
        + `&per_page=${perPage}`,
      method: 'GET',
      headers: {
        Authorization: `Zoho-oauthtoken ${input.token}`,
      },
      retry: {
        maxAttempts: 2,
        baseDelayMs: 250,
      },
    });

    const items = Array.isArray(payload[input.moduleName])
      ? payload[input.moduleName] as Record<string, unknown>[]
      : [];
    input.onPage?.({
      organizationId: input.organizationId,
      moduleName: input.moduleName,
      page,
      count: items.length,
    });
    results.push(...items);
    if (items.length < perPage) {
      break;
    }
  }

  return results;
}

async function main(): Promise<void> {
  const companyId = await resolveRecentLarkCompany();
  const token = await zohoTokenService.getValidAccessToken(companyId, 'prod');
  const organizations = await zohoBooksClient.listOrganizations({ companyId });
  const needle = 'Humani AI LLC';
  const needleTokens = normalize(needle).split(' ').filter(Boolean);

  const diagnostic: Array<Record<string, unknown>> = [];

  for (const organization of organizations) {
    console.error(`Scanning contacts in ${organization.name ?? organization.organizationId} (${organization.organizationId})`);
    const contacts = await fetchPagedModule({
      companyId,
      organizationId: organization.organizationId,
      moduleName: 'contacts',
      token,
      maxPages: 20,
      onPage: ({ organizationId, page, count }) => {
        console.error(`contacts page ${page} for ${organizationId}: ${count}`);
      },
    });

    const matchingContacts = contacts
      .filter((record) => includesNeedle(record, needleTokens))
      .slice(0, 20)
      .map((record) => ({
        contactId: record.contact_id ?? record.id ?? null,
        contactName: record.contact_name ?? record.customer_name ?? record.company_name ?? null,
        companyName: record.company_name ?? null,
        email: record.email ?? record.primary_contact_email ?? null,
      }));

    diagnostic.push({
      organizationId: organization.organizationId,
      organizationName: organization.name ?? null,
      isDefault: organization.isDefault ?? false,
      contactCountScanned: contacts.length,
      matchingContacts,
    });
  }

  console.log(JSON.stringify({
    companyId,
    needle,
    diagnostic,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
