import type {
  ShopifyPrivacyMutationResult,
  ShopifyPrivacyRepository,
} from './shopify-privacy.lifecycle';

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 100;

export async function drainExpiredShopifyPrivacyRequests(input: {
  readonly repository: Pick<ShopifyPrivacyRepository, 'sweep'>;
  readonly now?: Date;
  readonly pageSize?: number;
  readonly maxPages?: number;
}): Promise<ShopifyPrivacyMutationResult> {
  const pageSize = positiveInteger(input.pageSize ?? DEFAULT_PAGE_SIZE, 'pageSize');
  const maxPages = positiveInteger(input.maxPages ?? DEFAULT_MAX_PAGES, 'maxPages');
  const now = input.now ?? new Date();
  let affected = 0;

  for (let page = 0; page < maxPages; page += 1) {
    const result = await input.repository.sweep({ now, limit: pageSize });
    if (!result.ok) throw result.error;
    affected += result.value.affected;
    if (!result.value.hasMore) return { affected, hasMore: false };
    if (result.value.affected === 0) {
      throw new Error('Shopify privacy retention made no progress while expired rows remain.');
    }
  }

  return { affected, hasMore: true };
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive safe integer.`);
  }
  return value;
}
