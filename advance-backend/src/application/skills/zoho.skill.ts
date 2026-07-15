import type { Skill } from './skill.types';

const ZOHO_CONNECTION_METHOD = `DIVO-GOVERNED ZOHO CONNECTION:
- Invoke Zoho only through the Divo tool surface available in the current runtime: server channels use call_tool; desktop uses divo_gateway. Never call Zoho directly, use local credentials, or switch to an unavailable tool surface.
- If the member already selected a connected or shared Zoho account, pass its backend connectionId with every Zoho action.
- If no connectionId was selected, let Divo resolve access. It auto-selects only when exactly one accessible Zoho connection exists.
- If Divo returns a structured connection choice, ask one short account-choice question using the returned labels. Do not guess.
- If no connection is accessible, tell the member to connect or request access to Zoho.
- Never use a label, organization name, or guessed value as connectionId. Use only a backend-provided connectionId.`;

export const financeOpsCoreSkill: Skill = {
  id: 'finance-ops-core',
  name: 'Finance Ops Core',
  description: 'Route broad finance questions, unpaid invoices, recent payments, overdue reports, tax summaries, and safe read-only finance summaries across Zoho Books and Zoho CRM. Delegates operational workflows to specialist skills.',
  toolIds: ['zohoBooks', 'zohoCrm', 'documentRag', 'dataProcessor'],
  instructions: `${ZOHO_CONNECTION_METHOD}

ROLE:
- This is the finance router and broad read/summary skill.
- Use it for finance numbers, unpaid invoices, recent payments, customer/vendor context, Books/CRM lookup, and safe summaries.
- Do not duplicate specialized workflows here. If the user asks to record/create/enter a vendor bill from a PDF or invoice, fetch and follow skill zoho-books-bill.
- If the user asks to notify Accounts/Core Accounts after bill work, fetch and follow skill zoho-bill-notify-accounts.

ROUTING:
- Broad unpaid invoice / receivables / overdue question -> zohoBooks op="build_overdue_report" or op="list_invoices" with status/date filters.
- Recent payments / customer payments -> zohoBooks op="list_payments".
- Bills / expenses / bank transactions -> zohoBooks op="list_bills", "list_expenses", "list_bank_transactions", or "search_transactions".
- Tax summary -> zohoBooks op="get_tax_summary".
- Customer, lead, contact, account, deal, or case relationship context -> zohoCrm read ops: "search_text", "search", "get", "list", or CRM report ops.
- Uploaded finance documents used as evidence -> use documentRag/dataProcessor only to extract or analyze; verify final financial truth in Zoho before claiming it.

WRITE SAFETY:
- Stay read-only when the user says "don't change anything".
- For Zoho Books writes, use zohoBooks write ops only after exact module, record IDs/fields, and payload are clear.
- For Zoho CRM writes, use zohoCrm create/update/delete only after exact module, record ID when needed, and field values are clear.
- Let backend RBAC/HITL handle approval; never state a mutation is complete until the tool confirms success after approval.

OUTPUT:
- Answer in business language: totals, statuses, aging/risk, owners or customers/vendors, and concrete follow-up priorities.
- Do not expose internal tool IDs, gateway plumbing, raw API dumps, credentials, or guessed IDs in the final answer unless the user asks how it works.`,
};

const ZOHO_BOOKS_BILL_WORKFLOW = `ZOHO BOOKS BILL RECORDING:
- Use this workflow when the user asks to record, create, or enter a vendor bill/invoice in Zoho Books, especially with a PDF invoice.
- Extract invoice data from the attached/source PDF before writing: invoice or bill number, date, vendor name, GSTIN/PAN/address, line items, tax breakdown, total, and IRN when present. Use documentRag/dataProcessor if the source text needs extraction before Zoho writes.
- Treat the source invoice/bill number as the unique Zoho Books bill_number.
- Never create a second bill with the same normalized bill_number. Search existing bills first with zohoBooks op="list_bills" using searchQuery/date/vendor filters where possible; accept only exact normalized bill_number matches.
- If an existing bill is found, do not create another bill and do not record another payment. Check attachment metadata. Attach the PDF only if it is missing; if attachment state cannot be verified, stop and report the risk.
- Resolve or create the vendor only after the global duplicate check.
- Fetch chart of accounts and choose the expense account that matches the service. Do not guess silently when the account choice is ambiguous.
- Fetch taxes and apply GST correctly. EMIAC state is Rajasthan, code 08. Different vendor GST state means IGST; same state means CGST plus SGST. Use actual tax records from Zoho.
- Create the bill with zohoBooks op="create_bill" and fields containing vendor_id, bill_number, date, due_date, line_items, taxes, and notes including IRN/payment context when available.
- Always attach the source PDF to the bill after creation or when repairing a missing attachment.
- Record payment only when the user asks or the invoice is clearly paid. If unpaid or bill-only, leave it open and say payment was not recorded.
- For vendor payments, preserve the two-step paid-through account rule whenever the backend exposes it: create the payment, then update paid_through_account_id; Zoho can otherwise default to Undeposited Funds. If the current backend tool cannot perform the required second step, stop and report that payment routing cannot be verified instead of pretending it was done.
- Verify by fetching the final bill/list result and checking status, balance, payment_made, bill_id, and attachment state where the backend response exposes it.
- Final response must say whether the bill was created, updated, unchanged, or blocked; include bill ID/link, payment status, and PDF attachment status.`;

export const zohoBooksBillSkill: Skill = {
  id: 'zoho-books-bill',
  name: 'Zoho Books Bill Recording',
  description: 'Record vendor bills in Zoho Books from PDF invoices with duplicate checks, GST handling, PDF attachment, and optional payment routing.',
  toolIds: ['zohoCrm', 'zohoBooks', 'documentRag', 'dataProcessor'],
  instructions: `${ZOHO_CONNECTION_METHOD}

${ZOHO_BOOKS_BILL_WORKFLOW}

TOOL MAPPING:
- Use zohoBooks for bill lookup, contact/vendor lookup, account/tax discovery, bill creation, attachment-aware verification where supported, and payment recording.
- Use documentRag or dataProcessor before Zoho writes when the source is an image/PDF and text extraction is needed.
- Use zohoCrm only when the user explicitly needs CRM-side context for the bill workflow.

AUDIT / VERIFICATION HONESTY:
- Always state what was checked in Zoho and what could not be verified.
- Never present parsed PDF text as final Zoho truth until the final Zoho bill has been fetched.
- Never invent financial figures, tax IDs, bill IDs, account IDs, or payment status.`,
};

export const zohoBillNotifyAccountsSkill: Skill = {
  id: 'zoho-bill-notify-accounts',
  name: 'Zoho Bill Notify Accounts',
  description: 'Create or update a Zoho Books vendor bill from a PDF invoice, then notify the Core Accounts Lark group with an audit summary and source PDF.',
  toolIds: ['zohoCrm', 'zohoBooks', 'documentRag', 'dataProcessor', 'larkMessaging'],
  instructions: `${ZOHO_CONNECTION_METHOD}

DEPENDENCY:
- First follow the zoho-books-bill workflow exactly. Preserve duplicate prevention, PDF attachment checks, GST handling, payment routing, and final Zoho verification.

NOTIFICATION WORKFLOW:
- Use this only when the user asks to notify Accounts/Core Accounts or explicitly requests this skill/workflow.
- After the Zoho bill step is created, updated, or verified, notify the Core Accounts Lark/Feishu group from the user's identity when available.
- The notification must include: vendor name, bill number, bill ID, bill date, due date, status, total, balance, payment made, expense account, paid-through account or "Payment not recorded", vendor GSTIN, source/destination of supply, tax name and amount, PDF filename, and Zoho bill link.
- Zoho bill link format: https://finance.emiactech.com/app/<organization_id>#/bills/<bill_id>
- Send the source PDF as the immediate follow-up file attachment when Lark file upload is available.
- If the Core Accounts group/chat ID is unavailable, stop after the Zoho bill verification and tell the user the group must be configured. Do not guess a Lark group.
- If Lark sending fails because of missing auth/scopes, keep the Zoho bill intact and report the exact next authorization step.

FINAL RESPONSE:
- Report whether the bill was created, updated, unchanged, or blocked.
- Include bill ID/link, whether payment was recorded or intentionally skipped, whether the Accounts notification was sent, and whether the PDF attachment was sent.
- Never claim the notification was sent unless the Lark tool succeeded.`,
};
