import { createHash } from 'node:crypto';
import type { InfraError } from '../../shared/errors';
import type { Result } from '../../shared/result';
import { normalizeShopDomain } from '../../domain/shopify/shopify-shop';

export const SHOPIFY_PRIVACY_STATES = [
  'received',
  'ready',
  'delivered',
  'expired',
  'redacted',
  'failed',
] as const;

export type ShopifyPrivacyState = typeof SHOPIFY_PRIVACY_STATES[number];
export type ShopifyPrivacyInitialState = Extract<ShopifyPrivacyState, 'received' | 'ready' | 'failed'>;
export type ShopifyPrivacyExport = Readonly<Record<string, unknown>>;

type CreateBase = {
  readonly companyId: string;
  readonly shopDomain: string;
  readonly requestId: string;
  readonly customerId?: string;
  readonly orderIds: readonly string[];
  readonly deadlineAt: Date;
  readonly expiresAt: Date;
};

export type CreateShopifyPrivacyRequest = CreateBase & (
  | { readonly state: 'received' }
  | { readonly state: 'ready'; readonly exportPayload: ShopifyPrivacyExport }
  | { readonly state: 'failed'; readonly failureCode: string }
);

export type ShopifyPrivacyRequestSummary = {
  readonly id: string;
  readonly companyId: string;
  readonly shopDomain: string;
  readonly requestId: string;
  readonly customerIdHash: string | null;
  readonly orderIdHashes: readonly string[];
  readonly state: ShopifyPrivacyState;
  readonly failureCode: string | null;
  readonly deadlineAt: Date;
  readonly expiresAt: Date;
  readonly readyAt: Date | null;
  readonly deliveredAt: Date | null;
  readonly redactedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export type ShopifyPrivacyRequestDetail = ShopifyPrivacyRequestSummary & {
  readonly exportPayload: ShopifyPrivacyExport | null;
};

export type ShopifyPrivacyMutationResult = {
  readonly affected: number;
  readonly hasMore: boolean;
};

export const SHOPIFY_PRIVACY_DELIVERY_CHANNELS = ['email', 'shopify_admin', 'other'] as const;
export type ShopifyPrivacyDeliveryChannel = typeof SHOPIFY_PRIVACY_DELIVERY_CHANNELS[number];

export type ShopifyPrivacyDeliveryEvidence = {
  readonly channel: ShopifyPrivacyDeliveryChannel;
  readonly recipient: string;
  readonly receiptId: string;
  readonly deliveredAt: Date;
};

export interface ShopifyPrivacyRepository {
  create(input: CreateShopifyPrivacyRequest): Promise<Result<{
    readonly created: boolean;
    readonly request: ShopifyPrivacyRequestSummary;
  }, InfraError>>;
  list(input: {
    readonly companyId: string;
    readonly shopDomain?: string;
    readonly states?: readonly ShopifyPrivacyState[];
    readonly limit?: number;
  }): Promise<Result<readonly ShopifyPrivacyRequestSummary[], InfraError>>;
  get(input: {
    readonly companyId: string;
    readonly shopDomain: string;
    readonly id: string;
    readonly actorId: string;
  }): Promise<Result<ShopifyPrivacyRequestDetail | null, InfraError>>;
  markDelivered(input: {
    readonly companyId: string;
    readonly shopDomain: string;
    readonly id: string;
    readonly actorId: string;
    readonly deliveryEvidence: ShopifyPrivacyDeliveryEvidence;
  }): Promise<Result<boolean, InfraError>>;
  redact(input: {
    readonly companyId: string;
    readonly shopDomain: string;
    readonly requestId?: string;
    readonly customerId?: string;
    readonly orderIds?: readonly string[];
    readonly limit?: number;
  }): Promise<Result<ShopifyPrivacyMutationResult, InfraError>>;
  sweep(input?: {
    readonly now?: Date;
    readonly limit?: number;
  }): Promise<Result<ShopifyPrivacyMutationResult, InfraError>>;
}

export class ShopifyPrivacyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShopifyPrivacyValidationError';
  }
}

export type PreparedShopifyPrivacyRequest = Omit<CreateBase, 'customerId' | 'orderIds'> & {
  readonly customerIdHash: string | null;
  readonly orderIdHashes: readonly string[];
  readonly state: ShopifyPrivacyInitialState;
  readonly serializedExport: string | null;
  readonly failureCode: string | null;
};

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_ORDER_IDS = 250;
const MAX_EXPORT_BYTES = 1_048_576;
const SAFE_FAILURE_CODE = /^[a-z0-9][a-z0-9_.-]{0,99}$/;

export function prepareShopifyPrivacyRequest(input: CreateShopifyPrivacyRequest): PreparedShopifyPrivacyRequest {
  const companyId = requiredIdentifier(input.companyId, 'companyId');
  const shopDomain = normalizeShopDomain(input.shopDomain);
  if (!shopDomain) throw new ShopifyPrivacyValidationError('shopDomain must be a canonical myshopify.com domain.');
  const requestId = requiredIdentifier(input.requestId, 'requestId');
  const customerId = optionalIdentifier(input.customerId, 'customerId');
  const orderIds = uniqueIdentifiers(input.orderIds, 'orderIds');
  if (!customerId && orderIds.length === 0) {
    throw new ShopifyPrivacyValidationError('At least one exact customerId or orderId is required.');
  }
  if (!isValidDate(input.deadlineAt) || !isValidDate(input.expiresAt)) {
    throw new ShopifyPrivacyValidationError('deadlineAt and expiresAt must be valid dates.');
  }
  if (input.expiresAt.getTime() < input.deadlineAt.getTime()) {
    throw new ShopifyPrivacyValidationError('expiresAt must not be earlier than deadlineAt.');
  }

  let serializedExport: string | null = null;
  let failureCode: string | null = null;
  if (input.state === 'ready') serializedExport = serializeExport(input.exportPayload);
  if (input.state === 'failed') {
    failureCode = input.failureCode.trim();
    if (!SAFE_FAILURE_CODE.test(failureCode)) {
      throw new ShopifyPrivacyValidationError('failureCode must be a bounded machine-readable code.');
    }
  }
  return {
    companyId,
    shopDomain,
    requestId,
    customerIdHash: customerId ? hashProtectedIdentifier(customerId) : null,
    orderIdHashes: orderIds.map(hashProtectedIdentifier),
    deadlineAt: new Date(input.deadlineAt),
    expiresAt: new Date(input.expiresAt),
    state: input.state,
    serializedExport,
    failureCode,
  };
}

export function preparePrivacyLookup(input: { companyId: string; shopDomain: string; id?: string }) {
  const shopDomain = normalizeShopDomain(input.shopDomain);
  if (!shopDomain) throw new ShopifyPrivacyValidationError('shopDomain must be a canonical myshopify.com domain.');
  return {
    companyId: requiredIdentifier(input.companyId, 'companyId'),
    shopDomain,
    ...(input.id === undefined ? {} : { id: requiredIdentifier(input.id, 'id') }),
  };
}

export function prepareRedactionSelectors(input: {
  requestId?: string;
  customerId?: string;
  orderIds?: readonly string[];
}) {
  const requestId = optionalIdentifier(input.requestId, 'requestId');
  const customerId = optionalIdentifier(input.customerId, 'customerId');
  const orderIds = uniqueIdentifiers(input.orderIds ?? [], 'orderIds');
  if (!requestId && !customerId && orderIds.length === 0) {
    throw new ShopifyPrivacyValidationError('Redaction requires an exact requestId, customerId, or orderId.');
  }
  return {
    requestId,
    customerIdHash: customerId ? hashProtectedIdentifier(customerId) : null,
    orderIdHashes: orderIds.map(hashProtectedIdentifier),
  };
}

export function boundedPrivacyLimit(value: number | undefined): number {
  if (value === undefined) return 100;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ShopifyPrivacyValidationError('limit must be a positive safe integer.');
  }
  return Math.min(value, 100);
}

export function parseShopifyPrivacyExport(serialized: string): ShopifyPrivacyExport {
  const parsed: unknown = JSON.parse(serialized);
  if (!isPlainObject(parsed)) throw new ShopifyPrivacyValidationError('Stored Shopify privacy export is not a JSON object.');
  return parsed;
}

function serializeExport(payload: ShopifyPrivacyExport): string {
  if (!isPlainObject(payload)) throw new ShopifyPrivacyValidationError('exportPayload must be a JSON object.');
  assertJsonValue(payload, 0, { nodes: 0 });
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    throw new ShopifyPrivacyValidationError('exportPayload must contain only serializable JSON values.');
  }
  if (serialized === undefined || !isPlainObject(JSON.parse(serialized))) {
    throw new ShopifyPrivacyValidationError('exportPayload must contain only serializable JSON values.');
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_EXPORT_BYTES) {
    throw new ShopifyPrivacyValidationError(`exportPayload must not exceed ${MAX_EXPORT_BYTES} bytes.`);
  }
  return serialized;
}

function assertJsonValue(value: unknown, depth: number, budget: { nodes: number }): void {
  budget.nodes += 1;
  if (depth > 32 || budget.nodes > 100_000) {
    throw new ShopifyPrivacyValidationError('exportPayload exceeds the JSON structure limit.');
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return;
    throw new ShopifyPrivacyValidationError('exportPayload numbers must be finite.');
  }
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, depth + 1, budget);
    return;
  }
  if (!isPlainObject(value)) {
    throw new ShopifyPrivacyValidationError('exportPayload must contain only JSON values.');
  }
  for (const item of Object.values(value)) assertJsonValue(item, depth + 1, budget);
}

function requiredIdentifier(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_IDENTIFIER_LENGTH) {
    throw new ShopifyPrivacyValidationError(`${field} must be between 1 and ${MAX_IDENTIFIER_LENGTH} characters.`);
  }
  return normalized;
}

function optionalIdentifier(value: string | undefined, field: string): string | null {
  return value === undefined ? null : requiredIdentifier(value, field);
}

function uniqueIdentifiers(values: readonly string[], field: string): readonly string[] {
  if (values.length > MAX_ORDER_IDS) {
    throw new ShopifyPrivacyValidationError(`${field} must contain at most ${MAX_ORDER_IDS} identifiers.`);
  }
  return [...new Set(values.map(value => requiredIdentifier(value, field)))].sort();
}

function isValidDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function isPlainObject(value: unknown): value is ShopifyPrivacyExport {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function hashProtectedIdentifier(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
