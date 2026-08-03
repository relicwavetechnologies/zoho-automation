import type { Skill } from './skill.types';
import {
  ZOHO_BOOKS_OUTSTANDING_RULE,
  ZOHO_BOOKS_ROW_CONTRACT,
} from '../../shared/zoho-books-row-contract';
import { GOVERNED_LOCAL_DESKTOP_ONLY } from './governed-local-routing';

const ZOHO_CONNECTION_METHOD = `DIVO-GOVERNED ZOHO CONNECTION:
- Invoke Zoho only through the Divo tool surface available in the current runtime: server channels use call_tool; desktop uses divo_gateway. Never call Zoho directly, use local credentials, or switch to an unavailable tool surface.
- Reuse an exact connectionId already supplied by the current run. Otherwise omit it: the backend selects an account only when exactly one accessible account qualifies.
- If Divo returns structured connection choices, ask one short account-choice question using those labels, then retry with the selected exact ID. Do not guess.
- Do not call connections.list merely to rediscover an account the backend can select.
- If no connection is accessible, tell the member to connect or request access to Zoho.
- Never use a label, organization name, or guessed value as connectionId. Use only a backend-provided connectionId.`;

export const financeOpsCoreSkill: Skill = {
  id: 'finance-ops-core',
  name: 'Finance Ops Core',
  description: 'Route broad finance questions, unpaid invoices, recent payments, overdue reports, tax summaries, and safe read-only finance summaries across Zoho Books and Zoho CRM. Delegates operational workflows to specialist skills.',
  toolIds: ['zohoBooks', 'zohoCrm'],
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
- Finance documents sent in chat are already saved in the workspace and listed under [ATTACHED_FILES]; read them from there to extract or analyze, then verify final financial truth in Zoho before claiming it.

WRITE SAFETY:
- Stay read-only when the user says "don't change anything".
- For Zoho Books writes, use zohoBooks write ops only after exact module, record IDs/fields, and payload are clear.
- For Zoho CRM writes, use zohoCrm create/update/delete only after exact module, record ID when needed, and field values are clear.
- Let backend RBAC/HITL handle approval; never state a mutation is complete until the tool confirms success after approval.

OUTPUT:
- Answer in business language: totals, statuses, aging/risk, owners or customers/vendors, and concrete follow-up priorities.
- Do not expose internal tool IDs, gateway plumbing, raw API dumps, credentials, or guessed IDs in the final answer unless the user asks how it works.`,
};

export const financeZohoRouterSkill: Skill = {
  id: 'finance-zoho-router',
  name: 'Finance and Zoho Router',
  description: 'Route Zoho Books and CRM requests to the exact approved read, bill, or notification workflow.',
  toolIds: [],
  instructions: `Use this instruction-only router to choose the next exact Finance/Zoho skill.

- Zoho Books lookup, read-only reporting, whole-account aggregation, receivables, invoices, payments, bills, expenses, bank transactions, and tax summaries -> load \`zoho-books-read-analysis\`.
- Zoho CRM customer, lead, contact, account, deal, or case context -> load \`zoho-crm-read-analysis\`.
- Recording or creating a vendor bill from an invoice or PDF -> load \`zoho-books-bill\`.
- Recording a bill and then notifying the Accounts Lark group -> load \`zoho-bill-notify-accounts\`.

Preserve explicit read-only constraints. If more than one accessible Zoho account could satisfy the request, ask one short account-choice question using backend-provided labels before calling a Zoho tool. Never guess an account, create a todo, export data, or perform a write merely because routing was ambiguous.`,
};

export const zohoCrmReadAnalysisSkill: Skill = {
  id: 'zoho-crm-read-analysis',
  name: 'Zoho CRM Read and Analysis',
  description: 'Read and summarize Zoho CRM records without side effects.',
  toolIds: ['zohoCrm'],
  instructions: `${ZOHO_CONNECTION_METHOD}

READ ROUTING:
- Use zohoCrm read operations for customer, lead, contact, account, deal, case, owner, and relationship context.
- Use narrow search/list filters before fetching a specific record.
- Stay read-only unless the user explicitly requests a CRM mutation and an approved write specialist is available.

OUTPUT:
- State the account used, material filters, record type, and confirmed result.
- Never create, update, delete, export, schedule, message, email, or save anything for a read-only request.`,
};

export const zohoBooksReadAnalysisSkill: Skill = {
  id: 'zoho-books-read-analysis',
  name: 'Zoho Books Read and Analysis',
  description: 'Read, aggregate, and verify Zoho Books data without side effects, including complete paginated finance calculations.',
  toolIds: ['zohoBooks'],
  instructions: `${ZOHO_CONNECTION_METHOD}

READ ROUTING:
- Bounded lookup or preview -> use the matching zohoBooks read operation with narrow filters.
- For a list request, omit the limit argument unless the user explicitly requested a numeric maximum. The backend keeps the model preview bounded and may attach governed export actions when additional rows exist.
- When a list result is truncated, do not retry with a larger limit, fetch source pages manually, or switch to a scripted workflow merely to enumerate the remaining rows. Summarize the bounded preview; when preview.exportOfferId is present in Lark, finish the response and let Divo's verified Sheet/CSV/XLSX card own the choice and queue. Do not ask again or load/call dataExport for that offer.
- For an explicit complete-data request that genuinely returned no provider offer, load secure-data-export only when the exact backend-resolved Zoho source identifiers are available. Never rebuild the Zoho query, copy rows, or use Python merely to create that one-source artifact.
- Latest/recent bounded invoices -> use zohoBooks op="list_invoices" with the requested limit; it is already sorted by invoice date newest-first. Do not scan or sort thousands of rows.
- Human invoice number -> use zohoBooks op="get_invoice" with that exact number, or list_invoices with searchQuery and accept only an exact normalized invoice_number match before using its invoice_id. Never substitute a fuzzy result.
- Exact whole-account or potentially large aggregate -> ${GOVERNED_LOCAL_DESKTOP_ONLY}, use the scripted workflow: fetch pages through divo-local, write them to a file, and aggregate over that file. On server channels there is no divo-local: stay on the governed zohoBooks operations and let the backend's export path own the complete set. Never go looking for a local CLI there. Either way, do not start with zohoBooks script mode; it is capped at 4,000 records, and pulling pages into context to add them up is how totals silently come out short.
- Aging/overdue report -> use zohoBooks op="build_overdue_report".
- Before describing a total as exact, reconcile it: every source page accounted for, and the row count you computed over stated alongside the figure.
- Zoho customer-payment list rows may omit original currency. When _currency is UNKNOWN, do not call it INR or produce an original-currency breakdown. _amount_inr remains safe when populated from Zoho bcy_amount; otherwise state that original-currency analysis requires stronger evidence.

ROW CONTRACT:
${ZOHO_BOOKS_ROW_CONTRACT}
${ZOHO_BOOKS_OUTSTANDING_RULE}

OUTPUT:
- State the account used, material filters, count, total, and whether all pages were processed.
- Preserve Zoho identifiers exactly as returned, including invoice numbers; never add, remove, or reformat identifier characters.
- Report only figures returned by the tool computation. Do not add uncomputed remainders, percentages, or other derived claims.
- Never create, update, delete, schedule, message, email, or save anything in Zoho for a read-only request. Presenting the bounded preview is allowed; only Divo's verified Lark card callback may confirm its governed export offer. The central export owns pagination, destination access, delivery, and verification.`,
};

const ZOHO_BOOKS_BILL_WORKFLOW = `ZOHO BOOKS BILL RECORDING:
- Use this workflow when the user asks to record, create, or enter a vendor bill/invoice in Zoho Books, especially with a PDF invoice.
- Extract invoice data from the attached/source PDF before writing: invoice or bill number, date, vendor name, GSTIN/PAN/address, line items, tax breakdown, total, and IRN when present. The PDF is already in the workspace at the path given in [ATTACHED_FILES]; open and read it before any Zoho write.
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
  toolIds: ['zohoCrm', 'zohoBooks'],
  instructions: `${ZOHO_CONNECTION_METHOD}

${ZOHO_BOOKS_BILL_WORKFLOW}

TOOL MAPPING:
- Use zohoBooks for bill lookup, contact/vendor lookup, account/tax discovery, bill creation, attachment-aware verification where supported, and payment recording.
- When the source is an image or PDF, read it from its workspace path first; never write to Zoho from a filename or an assumed value.
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
  toolIds: ['zohoCrm', 'zohoBooks', 'larkMessaging'],
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
