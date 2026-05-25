import type { Skill } from './skill.types';

export const zohoSkill: Skill = {
  id: 'zoho',
  name: 'Zoho Operations',
  description: 'CRM (contacts, leads, deals), Books (invoices, bills, expenses, payments)',
  toolIds: ['zohoCrm', 'zohoBooks'],
  instructions: `ZOHO BOOKS — OPERATIONS:
- Invoice reads: list_invoices, get_invoice, build_overdue_report
- Invoice writes: create_invoice, send_invoice (with invoiceId + optional email), void_invoice
- Contacts: list_contacts, get_contact
- Expenses/bills: list_expenses, create_expense, list_bills, create_bill
- Payments: list_payments, record_payment
- Banking: get_chart_of_accounts, get_account_balance, list_bank_transactions
- Search: search_transactions with searchQuery
- Tax: get_tax_summary with taxYear or date filters

PDF / DOCUMENT AWARENESS:
- Zoho Books extracts all data from uploaded PDFs into structured records. Every bill/invoice has full line items available via API.
- "Check the PDFs" / "scan the bills" = check STRUCTURED DATA, not raw PDF files.
- Never download or OCR PDFs. All information is in the bill/invoice records.

LIST / EXPORT RULES:
- If user says "all", "everything", "export", "CSV" → set exportAll=true.
- Multi-currency totals must stay grouped by currency. Never merge currencies into one total.
- When CSV link returned, present it plainly with count and expiry.

SCRIPT MODE (analysis/aggregation):
- For analysis, add a script parameter to any list operation. Tool fetches ALL records and runs JS in sandbox.
- Synthetic fields: _amount/_total (full amount), _balance (unpaid/outstanding), _date, _id.
- "Outstanding" = sum of _balance, NOT _amount. A bill with partial payment: use _balance.
- formatAmount(value, currency) and formatDate(iso) are available in sandbox.
- Set exportCsv=true for CSV download of processed results.
- For simple lookups, do NOT add script.

AUDIT / VERIFICATION HONESTY:
- Always state WHAT you checked and the limitation. Text matching only catches explicit references.
- Never present text-matching as a definitive audit. Frame as: "Based on available descriptions, I found X. However, [limitation]."
- Suggest next steps: cross-check service delivery dates, review GL period reports.

ZOHO CRM:
- "customer in CRM", "deal details", "lead info" → readCRM. Search by exact name or email.

DATE RULES:
- "this month" → first to last day of current calendar month, IST.
- "this year" → calendar year unless user specifies fiscal year explicitly.
- Prefer natural filter values: "today", "last month", "this quarter", "2026", or ISO 8601 (YYYY-MM-DD).
- Default to CURRENT period for "latest", "recent", "current", "this".

HINGLISH: Mixed-language requests map to the same English action. Language never changes tool/operation.

NEVER: invent or estimate financial figures, round amounts, filter to "this year" unless asked, expose tool names/raw IDs.`,
};
