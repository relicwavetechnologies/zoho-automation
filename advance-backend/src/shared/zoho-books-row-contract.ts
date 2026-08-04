export const ZOHO_BOOKS_FIELDS = {
  id: '_id',
  status: '_status',
  currency: '_currency',
  amount: '_amount',
  total: '_total',
  balance: '_balance',
  amountInr: '_amount_inr',
  totalInr: '_total_inr',
  balanceInr: '_balance_inr',
  date: '_date',
} as const;

export const ZOHO_BOOKS_ROW_CONTRACT = [
  'Zoho source rows retain raw API fields and add Divo-normalized fields:',
  '_id (module record ID), _status (raw status), _currency (ISO code, or UNKNOWN when Zoho omits it), _date (primary date),',
  '_amount/_total (full amount in original currency), _balance (unpaid amount in original currency),',
  '_amount_inr/_total_inr (full amount in INR), _balance_inr (unpaid amount in INR).',
].join(' ');

export const ZOHO_BOOKS_OUTSTANDING_RULE =
  'Outstanding invoice/bill rows have Number(_balance_inr) > 0 and _status is neither draft nor void.';

/** Matches Zoho Books Payables/Receivables on a contact — not the sum of list_bills/list_invoices. */
export const ZOHO_BOOKS_CONTACT_OUTSTANDING_RULE =
  'Vendor/customer outstanding shown in Zoho Payables/Receivables is contact-level: use get_contact and report outstanding_payable_amount or outstanding_receivable_amount. Do not infer that total by summing list_bills or list_invoices balances — Zoho list APIs omit vendor opening-balance rows.';
