import { formatAmount } from './zoho-format.utils';

export type BillFinding = {
  readonly code: string;
  readonly severity: 'blocking' | 'warning';
  readonly message: string;
};

export interface StagedBill {
  readonly stagingId: string;
  readonly companyId: string;
  readonly userId: string;
  readonly connectionId: string;
  readonly organizationId: string;
  readonly payload: Record<string, unknown>;
  readonly summary: string;
  readonly findings: readonly BillFinding[];
  readonly attachFileName?: string;
  readonly createdBillId?: string;
  readonly claimedAt?: Date;
  readonly createdAt?: Date;
  readonly expiresAt: Date;
}

export interface StagedBillStore {
  put(staged: StagedBill): Promise<void>;
  get(input: { stagingId: string; companyId: string; userId: string }): Promise<StagedBill | null>;
  claim(input: { stagingId: string; companyId: string; marker: string }): Promise<{ claimed: boolean; heldBy?: string }>;
  settle(input: { stagingId: string; companyId: string; billId: string }): Promise<void>;
  release(input: { stagingId: string; companyId: string; marker: string }): Promise<void>;
  markUnresolved(input: { stagingId: string; companyId: string; marker: string; unresolved: string }): Promise<void>;
  findUnresolved(input: { companyId: string; connectionId: string }): Promise<readonly StagedBill[]>;
}

export const STAGED_BILL_TTL_MS = 24 * 60 * 60_000;
export const BILL_CLAIM_PENDING = 'pending:';
export const BILL_CLAIM_UNRESOLVED = 'unknown:';

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const number = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value);
  return null;
};

const normalizedNumber = (value: unknown): string =>
  text(value).replace(/\s+/g, '').toLowerCase();

export const billLineItems = (payload: Record<string, unknown>): Record<string, unknown>[] =>
  Array.isArray(payload['line_items']) ? payload['line_items'].filter(record) : [];

export const billLineTotal = (payload: Record<string, unknown>): number | null => {
  const items = billLineItems(payload);
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

export function checkBill(input: {
  bill: Record<string, unknown>;
  sameNumberBills?: readonly Record<string, unknown>[];
  duplicateCheckUnavailable?: boolean;
}): BillFinding[] {
  const payload = input.bill;
  const findings: BillFinding[] = [];
  const add = (code: string, severity: BillFinding['severity'], message: string) =>
    findings.push({ code, severity, message });

  if (!text(payload['vendor_id'])) add('missing_vendor', 'blocking', 'The bill has no vendor_id.');
  const billNumber = text(payload['bill_number']);
  if (!billNumber) add('missing_bill_number', 'blocking', 'The bill has no bill_number from the supplier document.');
  if (billNumber && input.duplicateCheckUnavailable) {
    add('duplicate_check_unavailable', 'blocking', `Divo could not verify whether bill ${billNumber} already exists.`);
  } else if (billNumber && (input.sameNumberBills?.length ?? 0) > 0) {
    add('duplicate_bill_number', 'blocking', `Bill ${billNumber} already exists in Zoho Books.`);
  }

  const date = text(payload['date']);
  const dueDate = text(payload['due_date']);
  if (!date) add('missing_date', 'blocking', 'The bill has no date.');
  if (!dueDate) add('missing_due_date', 'blocking', 'The bill has no due_date.');
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) add('invalid_date', 'blocking', 'The bill date must be YYYY-MM-DD.');
  if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) add('invalid_due_date', 'blocking', 'The bill due_date must be YYYY-MM-DD.');
  if (date && dueDate && dueDate < date) add('due_before_bill', 'blocking', `Due date ${dueDate} is before bill date ${date}.`);

  if (Array.isArray(payload['taxes'])) {
    add('top_level_taxes', 'blocking', 'Bills must not send a top-level taxes array; put tax_id or reverse_charge_tax_id on each line.');
  }

  const reverseCharge = payload['is_reverse_charge_applied'] === true;
  const items = billLineItems(payload);
  if (items.length === 0) add('no_line_items', 'blocking', 'The bill has no line items.');
  for (const item of items) {
    const name = text(item['name']) || text(item['description']) || 'unnamed line';
    const hasItem = Boolean(text(item['item_id']));
    const hasAccount = Boolean(text(item['account_id']));
    if (!hasItem && !hasAccount) add('missing_line_account', 'blocking', `Line "${name}" needs a Zoho item_id or account_id.`);
    const quantity = number(item['quantity']);
    const rate = number(item['rate']);
    if (quantity === null || quantity <= 0) add('invalid_quantity', 'blocking', `Line "${name}" needs a positive quantity.`);
    if (rate === null || rate < 0) add('invalid_rate', 'blocking', `Line "${name}" needs a non-negative rate.`);

    const hasOrdinaryTax = Boolean(text(item['tax_id']));
    const hasReverseTax = Boolean(text(item['reverse_charge_tax_id']));
    if (hasOrdinaryTax && hasReverseTax) {
      add('mixed_tax_fields', 'blocking', `Line "${name}" mixes ordinary tax_id and reverse_charge_tax_id.`);
    }
    if (reverseCharge && hasOrdinaryTax) {
      add('ordinary_tax_on_reverse_charge', 'blocking', `Line "${name}" uses ordinary tax_id while the bill is marked reverse charge.`);
    }
    if (!reverseCharge && hasReverseTax) {
      add('reverse_tax_without_flag', 'blocking', `Line "${name}" uses reverse_charge_tax_id but the bill is not marked reverse charge.`);
    }
  }
  return findings;
}

export const hasBlockingBillFinding = (findings: readonly BillFinding[]): boolean =>
  findings.some(finding => finding.severity === 'blocking');

export function sameBillDraft(
  earlier: Pick<StagedBill, 'payload'>,
  current: Record<string, unknown>,
): boolean {
  const left = earlier.payload;
  if (!text(left['vendor_id']) || text(left['vendor_id']) !== text(current['vendor_id'])) return false;
  const leftNumber = normalizedNumber(left['bill_number']);
  const rightNumber = normalizedNumber(current['bill_number']);
  if (leftNumber && rightNumber) return leftNumber === rightNumber;
  const leftTotal = billLineTotal(left);
  const rightTotal = billLineTotal(current);
  return text(left['date']) === text(current['date'])
    && leftTotal !== null && rightTotal !== null
    && Math.abs(leftTotal - rightTotal) <= 0.02;
}

export function renderStagedBill(input: {
  payload: Record<string, unknown>;
  vendorName?: string;
  attachFileName?: string;
}): string {
  const payload = input.payload;
  const currency = text(payload['currency_code']) || 'INR';
  const money = (value: number) => formatAmount(value, currency);
  const lines = [
    `Vendor: ${input.vendorName || text(payload['vendor_name']) || text(payload['vendor_id']) || 'not set'}`,
    `Bill number: ${text(payload['bill_number']) || 'not set'}`,
  ];
  if (text(payload['date'])) lines.push(`Date: ${text(payload['date'])}`);
  if (text(payload['due_date'])) lines.push(`Due: ${text(payload['due_date'])}`);
  const items = billLineItems(payload);
  if (items.length > 0) {
    lines.push('Lines:');
    for (const item of items) {
      const name = text(item['name']) || text(item['description']) || text(item['item_id']) || text(item['account_id']) || 'unnamed line';
      const quantity = number(item['quantity']);
      const rate = number(item['rate']);
      lines.push(`  - ${name}${quantity !== null && rate !== null ? ` ${quantity} x ${money(rate)} = ${money(quantity * rate)}` : ''}`);
    }
  }
  const subtotal = billLineTotal(payload);
  if (subtotal !== null) lines.push(`Before tax: ${money(subtotal)}`, 'Tax and total are calculated by Zoho when the bill is created.');
  lines.push(payload['is_reverse_charge_applied'] === true ? 'Tax treatment: reverse charge.' : 'Tax treatment: ordinary line tax or no tax, as shown on the lines.');
  if (text(payload['notes'])) lines.push(`Notes: ${text(payload['notes'])}`);
  if (input.attachFileName) lines.push(`Attachment after creation: ${input.attachFileName}`);
  lines.push('Nothing has been created or paid yet.');
  return lines.join('\n');
}
