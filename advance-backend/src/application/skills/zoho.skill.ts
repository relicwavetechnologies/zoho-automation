import type { Skill } from './skill.types';
import {
  ZOHO_BOOKS_CONTACT_OUTSTANDING_RULE,
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

/**
 * Rules every Zoho write shares. They used to live in `finance-ops-core`, which
 * was written, tested, and never added to the provisioned set — so no member ever
 * received them. Skills are read from the database, not from this file.
 */
const ZOHO_WRITE_SAFETY = `WRITE SAFETY:
- Stay read-only when the user says "don't change anything".
- Use a write op only after the exact record IDs, fields, and payload are clear. Never write from a guessed id.
- Let backend RBAC/HITL handle approval. Never state a mutation is complete until the tool confirms it.
- Report the status the tool returned, not the status you expected. A created invoice comes back as a draft unless you issue it.`;

export const financeZohoRouterSkill: Skill = {
  id: 'finance-zoho-router',
  name: 'Finance and Zoho Router',
  description: 'Route Zoho Books and CRM requests to the exact approved read, bill, or notification workflow.',
  toolIds: [],
  instructions: `Use this instruction-only router to choose the next exact Finance/Zoho skill.

- Zoho Books lookup, read-only reporting, whole-account aggregation, receivables, invoices, payments, bills, expenses, bank transactions, item and tax rate lookups, and tax summaries -> load \`zoho-books-read-analysis\`.
- Zoho CRM customer, lead, contact, account, deal, or case context -> load \`zoho-crm-read-analysis\`.
- Creating, issuing, emailing, correcting, or attaching a PDF to a customer invoice, or adding a new customer -> load \`zoho-books-invoice\`.
- Recording or creating a vendor bill from an invoice or PDF -> load \`zoho-books-bill\`.
- Recording a bill and then notifying the Accounts Lark group -> load \`zoho-bill-notify-accounts\`.

Creating an invoice and recording a vendor bill are different workflows. Money owed to us is an invoice; money we owe a supplier is a bill. Ask which one is meant rather than guessing when the request could be either.

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
- For a list request, omit the limit argument unless the user explicitly requested a numeric maximum. The backend keeps the model preview bounded and may attach \`exportCandidate\` when additional rows can be replayed through governed export.
- When a list result is truncated, do not retry with a larger limit, fetch source pages manually, or switch to a scripted workflow merely to enumerate the remaining rows. Summarize the bounded preview; when \`exportCandidate\` is present and the member wants Sheet, Excel, CSV, all rows, or a full export, call \`dataExport\` with \`op=plan\` for that candidate instead of rerunning the list.
- If a list result contains \`exportCandidate\` and the member did not ask for a file, you may end a useful table or report answer with one soft follow-up asking whether to export it to Google Sheets, Excel, or CSV, unless the member explicitly said not to export, not now, or chat-only. Do not call \`dataExport\` until the member says yes or names a format.
- For an explicit complete-data request, use \`exportAll=true\` only to publish a Zoho \`exportCandidate\`, then call \`dataExport op=plan\`. Never rebuild the Zoho query, copy rows, or use Python merely to create that one-source artifact.
- Latest/recent bounded invoices -> use zohoBooks op="list_invoices" with the requested limit; it is already sorted by invoice date newest-first. Do not scan or sort thousands of rows.
- Human invoice number -> use zohoBooks op="get_invoice" with that exact number, or list_invoices with searchQuery and accept only an exact normalized invoice_number match before using its invoice_id. Never substitute a fuzzy result.
- Exact whole-account or potentially large aggregate -> ${GOVERNED_LOCAL_DESKTOP_ONLY}, use the scripted workflow: fetch pages through divo-local, write them to a file, and aggregate over that file. On server channels there is no divo-local: stay on the governed zohoBooks operations and let the backend's export path own the complete set. Never go looking for a local CLI there. Either way, do not start with zohoBooks script mode; it is capped at 4,000 records, and pulling pages into context to add them up is how totals silently come out short.
- Aging/overdue report -> use zohoBooks op="build_overdue_report".
- Product, item, SKU, or standard rate question -> zohoBooks op="list_items". Report the item_id and rate it returns; never quote a price from memory or from an earlier conversation.
- GST or tax rate question, and any tax decision that will be written to a record -> zohoBooks op="list_taxes". Use the tax_id it returns. Never infer a percentage from an invoice you read, and never guess a rate.
- Vendor or customer outstanding / payable / receivable balance for one contact -> list_contacts with searchQuery when needed, then get_contact with the contactId. Report outstanding_payable_amount or outstanding_receivable_amount from get_contact; that matches Zoho's Payables/Receivables UI. Bill or invoice balance sums are detail only and can be lower when opening balances exist.
- Before describing a total as exact, reconcile it: every source page accounted for, and the row count you computed over stated alongside the figure.
- Zoho customer-payment list rows may omit original currency. When _currency is UNKNOWN, do not call it INR or produce an original-currency breakdown. _amount_inr remains safe when populated from Zoho bcy_amount; otherwise state that original-currency analysis requires stronger evidence.

ROW CONTRACT:
${ZOHO_BOOKS_ROW_CONTRACT}
${ZOHO_BOOKS_OUTSTANDING_RULE}
${ZOHO_BOOKS_CONTACT_OUTSTANDING_RULE}

OUTPUT:
- State the account used, material filters, count, total, and whether all pages were processed.
- Preserve Zoho identifiers exactly as returned, including invoice numbers; never add, remove, or reformat identifier characters.
- Report only figures returned by the tool computation. Do not add uncomputed remainders, percentages, or other derived claims.
- Never create, update, delete, schedule, message, email, or save anything in Zoho for a read-only request. Presenting the bounded preview is allowed; if \`exportCandidate\` is present and the member wants a file, call \`dataExport op=plan\`. The central export owns pagination, sample/full decisions, destination access, delivery, and verification.`,
};

const ZOHO_BOOKS_BILL_WORKFLOW = `ZOHO BOOKS BILL RECORDING:
- Use this workflow when the user asks to record, create, or enter a vendor bill/invoice in Zoho Books, especially with a PDF invoice.
- Extract invoice data from the attached/source PDF before writing: invoice or bill number, date, vendor name, GSTIN/PAN/address, line items, tax breakdown, total, and IRN when present. The PDF is already in the workspace at the path given in [ATTACHED_FILES]; open and read it before any Zoho write.
- Treat the source invoice/bill number as the unique Zoho Books bill_number.
- Never create a second bill with the same normalized bill_number. Search existing bills first with zohoBooks op="list_bills" using searchQuery/date/vendor filters where possible; accept only exact normalized bill_number matches.
- If an existing bill is found, do not create another bill and do not record another payment. Read its \`documents\` list with op="get_invoice"-style single-record reads or from the write response; attach the PDF only if it is missing.
- Resolve the vendor with op="list_contacts" and searchQuery first. Only when that returns no match, create it with op="create_contact", and say in your reply that a new vendor was created.
- Fetch chart of accounts with op="get_chart_of_accounts" and choose the expense account that matches the service. Do not guess silently when the account choice is ambiguous.
- Fetch the real tax records with op="list_taxes" and apply GST using the tax_id they return. EMIAC state is Rajasthan, code 08. Different vendor GST state means IGST; same state means CGST plus SGST. Never invent a rate or a tax id.
- Create the bill with zohoBooks op="create_bill" and fields containing vendor_id, bill_number, date, due_date, line_items, taxes, and notes including IRN/payment context when available.
- Attach the source PDF with op="attach_document", recordType="bill", recordId set to the bill_id, and fileName set to the exact name of the file the member sent in this conversation. The tool confirms against Zoho's own document list; report attached only when it says so.
- Attaching works only for a file sent in this Lark conversation. If the tool says it cannot find or download the file, say the bill was created without its PDF and ask the member to send the file again. Never describe an attachment the tool did not confirm.
- Record payment only when the user asks or the invoice is clearly paid. If unpaid or bill-only, leave it open and say payment was not recorded.
- For vendor payments, Zoho defaults to Undeposited Funds unless the paid-through account is set. Set paid_through_account_id in the create payload. There is no vendor-payment update op, so if that account is not known before recording, stop and ask rather than recording a payment that will need correcting by hand.
- Verify by re-reading the final bill and checking status, balance, payment_made, bill_id, and its document list.
- Final response must say whether the bill was created, updated, unchanged, or blocked; include bill ID/link, payment status, and PDF attachment status.`;

export const zohoBooksBillSkill: Skill = {
  id: 'zoho-books-bill',
  name: 'Zoho Books Bill Recording',
  description: 'Record vendor bills in Zoho Books from PDF invoices with duplicate checks, GST handling, PDF attachment, and optional payment routing.',
  toolIds: ['zohoCrm', 'zohoBooks'],
  instructions: `${ZOHO_CONNECTION_METHOD}

${ZOHO_WRITE_SAFETY}

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

export const zohoBooksInvoiceSkill: Skill = {
  id: 'zoho-books-invoice',
  name: 'Zoho Books Customer Invoicing',
  description: 'Create, correct, issue, email, and attach documents to customer invoices in Zoho Books, including customer, item, and GST resolution.',
  toolIds: ['zohoBooks'],
  instructions: `${ZOHO_CONNECTION_METHOD}

SCOPE:
- This is money owed TO us: customer invoices. Money we owe a supplier is a vendor bill — load \`zoho-books-bill\` instead.
- Use this for creating an invoice, correcting one, issuing or emailing one, attaching a PDF to one, and for adding a customer that does not exist yet.

${ZOHO_WRITE_SAFETY}

BEFORE WRITING:
1. Duplicate check. Search with op="list_invoices" and searchQuery, or op="get_invoice" with an exact invoice number, before creating anything the member describes as already existing. Accept only an exact normalized invoice_number match.
2. Customer. op="list_contacts" with searchQuery. Use the contact_id it returns. Only when there is no match, op="create_contact" — and say in your reply that a new customer was created.
3. Line items. op="list_items" for item_id and rate. Use free-typed name and rate only when the member explicitly describes a one-off charge that is not in the item list, and say that you did.
4. Tax. op="list_taxes" for the real tax_id values. EMIAC state is Rajasthan, code 08. A customer in another state means IGST; the same state means CGST plus SGST. Never guess a rate or a tax id, and never copy one from a document you read.

CREATING — STAGE, SHOW, THEN CREATE:
- Never call create_invoice first. It requires a stagingId and will refuse without one.
- op="stage_invoice" with fields containing customer_id, date, due_date or payment_terms, and line_items each carrying item_id or name, quantity, rate, and tax_id. Pass fileName when the member sent a document this invoice comes from, so the reviewer can read it.
- Nothing is written to Zoho by staging. It runs the automatic checks, has a reviewer read the draft cold, and returns a summary plus a stagingId.
- Supply invoice_number only when the member gave you one. Omitting it lets Zoho apply its own numbering, which is what most organisations want.

- If the reviewer FAILED the draft, it found something that contradicts what the member said, the document, or a Zoho record. Correct those exact fields and call stage_invoice again with supersedesStagingId set to the previous stagingId. You get two corrections. If the second is still refused, stop and put the reviewer's objection to the member in their own words — do not keep re-staging.
- If the reviewer could not run, the summary says so. Show the member and tell them plainly that this draft was not reviewed.

- Show the member the returned summary EXACTLY as written, including everything listed as unconfirmed. Those are values nobody stated — a rate taken from the catalogue, a due date copied from past terms. They are usually right, and the member is the only one who can say so.
- Ask them to confirm. When they agree, call op="create_invoice" with that stagingId and nothing else; the tool replays the payload they approved, so what they saw is what Zoho receives.
- If they want a change, do not edit and create. Stage again with the change and show them the new summary.
- Zoho creates invoices as drafts. The tool reports the status it stored — repeat that status; do not describe a draft as sent, issued, or billed.
- If the result carries a drift list, Zoho stored something differently from what the member approved. Tell them that before anything else, and before issuing or emailing it.

ISSUING:
- op="mark_invoice_sent" moves a draft to sent without emailing anyone.
- op="send_invoice" emails it, optionally to a specific address.
- These are different acts. Ask which the member wants rather than choosing; issuing an invoice and emailing a customer have different consequences.

CORRECTING:
- op="update_invoice" with invoiceId and only the fields that change.
- Zoho refuses edits to an invoice that is paid or partially paid. When that happens, say so and offer a credit note as the next step rather than retrying.

ATTACHING:
- op="attach_document" with recordType="invoice", recordId set to the invoice_id, and fileName set to the exact name of a file the member sent in this Lark conversation.
- The tool verifies against Zoho's own document list. Report attached only when it confirms it. If it says the file is missing, ambiguous, or undownloadable, say the invoice stands without its attachment and ask the member to send the file again.

VERIFY AND REPORT:
- State the invoice number, its status, total, balance, and its link, all from what the tool returned.
- Say plainly which of these happened: created, issued, emailed, attached, or left as a draft. Never imply an act you did not perform.
- Preserve Zoho identifiers exactly as returned; never reformat an invoice number.`,
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
