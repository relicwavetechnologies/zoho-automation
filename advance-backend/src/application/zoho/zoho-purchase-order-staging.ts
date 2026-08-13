import { formatAmount } from './zoho-format.utils';

export type PurchaseOrderFinding = {
  readonly code: string;
  readonly severity: 'blocking' | 'warning';
  readonly message: string;
};

export interface StagedPurchaseOrder {
  readonly stagingId: string;
  readonly companyId: string;
  readonly userId: string;
  readonly connectionId: string;
  readonly organizationId: string;
  readonly payload: Record<string, unknown>;
  readonly summary: string;
  readonly findings: readonly PurchaseOrderFinding[];
  readonly attachFileName?: string;
  readonly createdPurchaseOrderId?: string;
  readonly claimedAt?: Date;
  readonly createdAt?: Date;
  readonly expiresAt: Date;
}

export interface StagedPurchaseOrderStore {
  put(staged: StagedPurchaseOrder): Promise<void>;
  get(input: { stagingId: string; companyId: string; userId: string }): Promise<StagedPurchaseOrder | null>;
  claim(input: { stagingId: string; companyId: string; marker: string }): Promise<{ claimed: boolean; heldBy?: string }>;
  settle(input: { stagingId: string; companyId: string; purchaseOrderId: string }): Promise<void>;
  release(input: { stagingId: string; companyId: string; marker: string }): Promise<void>;
  markUnresolved(input: { stagingId: string; companyId: string; marker: string; unresolved: string }): Promise<void>;
  findUnresolved(input: { companyId: string; connectionId: string }): Promise<readonly StagedPurchaseOrder[]>;
}

export const STAGED_PURCHASE_ORDER_TTL_MS = 24 * 60 * 60_000;
export const PURCHASE_ORDER_CLAIM_PENDING = 'pending:';
export const PURCHASE_ORDER_CLAIM_UNRESOLVED = 'unknown:';

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const number = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value);
  return null;
};

export const purchaseOrderLineItems = (payload: Record<string, unknown>): Record<string, unknown>[] =>
  Array.isArray(payload['line_items']) ? payload['line_items'].filter(record) : [];

export const purchaseOrderLineTotal = (payload: Record<string, unknown>): number | null => {
  const items = purchaseOrderLineItems(payload);
  if (items.length === 0) return null;
  let total = 0;
  for (const item of items) {
    const quantity = number(item['quantity']);
    const rate = number(item['rate']);
    if (quantity === null || rate === null) return null;
    total += quantity * rate;
  }
  return total;
};

export function checkPurchaseOrder(input: {
  purchaseOrder: Record<string, unknown>;
  sameNumberPurchaseOrders?: readonly Record<string, unknown>[];
  sameReferencePurchaseOrders?: readonly Record<string, unknown>[];
  numberCheckUnavailable?: boolean;
  referenceCheckUnavailable?: boolean;
}): PurchaseOrderFinding[] {
  const payload = input.purchaseOrder;
  const findings: PurchaseOrderFinding[] = [];
  const add = (code: string, severity: PurchaseOrderFinding['severity'], message: string) =>
    findings.push({ code, severity, message });

  if (!text(payload['vendor_id'])) add('missing_vendor', 'blocking', 'The purchase order has no vendor_id.');
  const items = purchaseOrderLineItems(payload);
  if (items.length === 0) add('no_line_items', 'blocking', 'The purchase order has no line items.');
  for (const item of items) {
    const name = text(item['name']) || text(item['description']) || 'unnamed line';
    if (!text(item['item_id'])) add('missing_item_id', 'blocking', `Line "${name}" has no Zoho item_id.`);
    const quantity = number(item['quantity']);
    const rate = number(item['rate']);
    if (quantity === null || quantity <= 0) add('invalid_quantity', 'blocking', `Line "${name}" needs a positive quantity.`);
    if (rate === null || rate < 0) add('invalid_rate', 'blocking', `Line "${name}" needs a non-negative rate.`);
  }

  const date = text(payload['date']);
  const delivery = text(payload['expected_delivery_date']) || text(payload['delivery_date']);
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) add('invalid_date', 'blocking', 'The purchase order date must be YYYY-MM-DD.');
  if (delivery && !/^\d{4}-\d{2}-\d{2}$/.test(delivery)) add('invalid_delivery_date', 'blocking', 'The expected delivery date must be YYYY-MM-DD.');
  if (date && delivery && delivery < date) add('delivery_before_order', 'blocking', `Expected delivery ${delivery} is before purchase-order date ${date}.`);

  const poNumber = text(payload['purchaseorder_number']);
  if (poNumber && input.numberCheckUnavailable) {
    add('duplicate_check_unavailable', 'blocking', `Divo could not verify whether purchase order ${poNumber} already exists.`);
  } else if (poNumber && (input.sameNumberPurchaseOrders?.length ?? 0) > 0) {
    add('duplicate_purchase_order_number', 'blocking', `Purchase order ${poNumber} already exists in Zoho Books.`);
  }
  const referenceNumber = text(payload['reference_number']);
  if (referenceNumber && input.referenceCheckUnavailable) {
    add('reference_check_unavailable', 'blocking', `Divo could not verify whether vendor reference ${referenceNumber} already exists on a purchase order.`);
  } else if (referenceNumber && (input.sameReferencePurchaseOrders?.length ?? 0) > 0) {
    add('duplicate_purchase_order_reference', 'blocking', `Vendor reference ${referenceNumber} already exists on a purchase order in Zoho Books.`);
  }
  return findings;
}

export const hasBlockingPurchaseOrderFinding = (findings: readonly PurchaseOrderFinding[]): boolean =>
  findings.some(finding => finding.severity === 'blocking');

export function samePurchaseOrderDraft(
  earlier: Pick<StagedPurchaseOrder, 'payload'>,
  current: Record<string, unknown>,
): boolean {
  const left = earlier.payload;
  if (!text(left['vendor_id']) || text(left['vendor_id']) !== text(current['vendor_id'])) return false;
  const leftNumber = text(left['purchaseorder_number']).toLowerCase();
  const rightNumber = text(current['purchaseorder_number']).toLowerCase();
  if (leftNumber && rightNumber) return leftNumber === rightNumber;
  const leftReference = text(left['reference_number']).toLowerCase();
  const rightReference = text(current['reference_number']).toLowerCase();
  if (leftReference && rightReference) return leftReference === rightReference;
  const leftTotal = purchaseOrderLineTotal(left);
  const rightTotal = purchaseOrderLineTotal(current);
  return text(left['date']) === text(current['date'])
    && leftTotal !== null && rightTotal !== null
    && Math.abs(leftTotal - rightTotal) <= 0.02;
}

export function renderStagedPurchaseOrder(input: {
  payload: Record<string, unknown>;
  vendorName?: string;
  attachFileName?: string;
}): string {
  const payload = input.payload;
  const currency = text(payload['currency_code']) || 'INR';
  const money = (value: number) => formatAmount(value, currency);
  const lines = [
    `Vendor: ${input.vendorName || text(payload['vendor_name']) || text(payload['vendor_id']) || 'not set'}`,
    `Purchase order number: ${text(payload['purchaseorder_number']) || 'assigned by Zoho'}`,
  ];
  if (text(payload['reference_number'])) lines.push(`Reference: ${text(payload['reference_number'])}`);
  if (text(payload['date'])) lines.push(`Date: ${text(payload['date'])}`);
  const delivery = text(payload['expected_delivery_date']) || text(payload['delivery_date']);
  if (delivery) lines.push(`Expected delivery: ${delivery}`);
  const items = purchaseOrderLineItems(payload);
  if (items.length > 0) {
    lines.push('Lines:');
    for (const item of items) {
      const name = text(item['name']) || text(item['description']) || text(item['item_id']) || 'unnamed line';
      const quantity = number(item['quantity']);
      const rate = number(item['rate']);
      lines.push(`  • ${name}${quantity !== null && rate !== null ? ` ${quantity} × ${money(rate)} = ${money(quantity * rate)}` : ''}`);
    }
  }
  const subtotal = purchaseOrderLineTotal(payload);
  if (subtotal !== null) lines.push(`Before tax: ${money(subtotal)}`, 'Tax and total are calculated by Zoho when the purchase order is created.');
  if (text(payload['notes'])) lines.push(`Notes: ${text(payload['notes'])}`);
  if (text(payload['terms'])) lines.push(`Terms: ${text(payload['terms'])}`);
  if (input.attachFileName) lines.push(`Attachment after creation: ${input.attachFileName}`);
  lines.push('Nothing has been created or sent to the vendor yet.');
  return lines.join('\n');
}
