import type { Skill } from './skill.types';
import { GOVERNED_LOCAL_AVAILABLE_RUNTIME } from './governed-local-routing';

/**
 * How connectionId itself behaves — omit it when one account qualifies, retry
 * with the exact ID an error returns — is stated by both Zoho tools' own
 * parameterDocs. What survives here is what a schema cannot say: which surface
 * to call, when to ask the member, and when to stop.
 */
const ZOHO_CONNECTION_METHOD = `DIVO-GOVERNED ZOHO CONNECTION:
- Invoke Zoho only through the matching registered Divo Zoho tool for a direct action. Inside a governed terminal workflow, ${GOVERNED_LOCAL_AVAILABLE_RUNTIME}, use \`divo-local\` with the source recipe's exact toolId. Never call Zoho directly, use local credentials, or switch to an unavailable tool surface.
- Treat only the current run bootstrap and current tool response as evidence of connection availability, access, and OAuth scope. Earlier chat, memory, and summaries are not current connection evidence.
- Do not call connections.list to rediscover an account the backend can select for itself.
- If the loaded work context shows multiple Zoho accounts, first restrict them to the requested service: CRM or Books. When exactly one account lists that service, omit connectionId or use that exact ID and let backend validation select it. Ask the member only when multiple accounts list the requested service.
- If Divo returns structured connection choices, ask one short account-choice question using those labels, then retry with the selected exact ID. Never send a label, organisation name, or guessed value as connectionId.
- If no accessible connection lists the requested service, tell the member that the matching CRM or Books authorization is missing and ask them to reconnect or request access.`;

/**
 * Rules every Zoho write shares. They used to live in `finance-ops-core`, which
 * was written, tested, and never added to the provisioned set — so no member ever
 * received them. Skills are read from the database, not from this file.
 */
const ZOHO_WRITE_SAFETY = `WRITE SAFETY:
- Stay read-only when the user says "don't change anything".
- Use a write op only after the exact record IDs, fields, and payload are clear. Never write from a guessed id.
- Let backend RBAC/HITL handle approval. Never state a mutation is complete until the tool confirms it.
- Keep failures distinct: a Divo permission denial is an access decision; a Zoho provider rejection is a payload or accounting-rule response. Never relabel one as the other or silently retry with changed tax treatment.
- Report the status the tool returned, not the status you expected.`;

/**
 * Shared finance evidence rules. Provider schemas describe field shapes; this
 * is the smaller piece they cannot express: which evidence wins when a PDF,
 * an old transaction, and today's Zoho records disagree.
 */
const ZOHO_FINANCE_EVIDENCE = `FINANCE EVIDENCE:
- Read every supplied source document before proposing a write. Use the whole document, including later-page taxes, adjustments, shipping, credits, and totals; never substitute a filename, email subject, old record, or first-page summary for its contents.
- Reconcile the document arithmetic before presenting it: taxable subtotal, tax, TDS/withholding, shipping or adjustments, and final total. If it does not reconcile, show the difference and ask rather than inventing a balancing value.
- Treat earlier Zoho transactions as clues for ledger, tax, tag, location, terms, or custom-field choices, never as authority to copy them. The member's current instruction and source document come first; current contact, item, tax, and account records establish the usable IDs.
- Current Zoho reads and the current loaded skill/tool contract override chat history, memory, and compaction summaries. Never take a permission, scope, connection state, field shape, contact, account, item, tax, or ID from an earlier conversation.
- Never embed or reuse an organisation, contact, item, account, tax, tag, location, storage, or custom-field ID from instructions or memory. Resolve it in the selected Zoho organisation this turn.
- Keep organisation-specific conventions company-scoped. Apply a reporting tag, channel, branch, ledger convention, or numbering series only when the member, a current company procedure, or live Zoho evidence establishes it.`;

export const financeZohoRouterSkill: Skill = {
  id: 'finance-zoho-router',
  name: 'Finance and Zoho Router',
  description: 'Route Zoho Books and CRM requests to the exact approved read, bill, or notification workflow.',
  toolIds: [],
  instructions: `Use this instruction-only router to choose the next exact Finance/Zoho skill.

- Zoho Books lookup, read-only reporting, whole-account aggregation, receivables, invoices, payments, bills, expenses, bank transactions, item and tax rate lookups, and tax summaries -> load \`zoho-books-read-analysis\`.
- GSTR-2B comparison, missing purchase-bill analysis, or finance reconciliation against an uploaded spreadsheet -> load \`zoho-books-read-analysis\`.
- Zoho CRM customer, lead, contact, account, deal, or case context -> load \`zoho-crm-read-analysis\`.
- Creating, issuing, emailing, correcting, or attaching a PDF to a customer invoice, or adding a new customer -> load \`zoho-books-invoice\`.
- Recording a customer payment against an invoice, or logging an expense -> load \`zoho-books-money\`.
- Creating or reviewing a purchase order for goods or services requested from a vendor -> load \`zoho-books-purchase-order\`.
- Recording or creating a vendor bill from an invoice or PDF -> load \`zoho-books-bill\`.
- Recording a bill and then notifying the Accounts Lark group -> load \`zoho-bill-notify-accounts\`.

An invoice requests money from a customer. A purchase order requests goods or services from a vendor before the vendor bills us. A bill records money we owe after the vendor has charged us. Ask which stage is meant rather than guessing.

After choosing the direction, load the exact current specialist before planning or using Zoho; this router does not contain the write procedure.

Preserve explicit read-only constraints. Never create a todo, export data, or perform a write merely because routing was ambiguous.`,
};

export const zohoCrmReadAnalysisSkill: Skill = {
  id: 'zoho-crm-read-analysis',
  name: 'Zoho CRM Read and Analysis',
  description: 'Read and summarize Zoho CRM records without side effects.',
  toolIds: ['zohoCrm'],
  instructions: `${ZOHO_CONNECTION_METHOD}

READ ROUTING:
- Use zohoCrm read operations for customer, lead, contact, account, deal, case, owner, and relationship context.
- Use \`search\` with provider-side criteria for a bounded filtered set. \`list\` does not accept criteria; never scan a whole module and filter locally when Zoho search can answer the request.
- Keep the pages of a complete CRM artifact in local files rather than model context, and do not claim completeness without reconciling every one of them.

WRITES ARE NOT THIS SKILL:
- This skill reads. Creating, editing, issuing, emailing, voiding, paying, or attaching anything is a different workflow with its own safeguards, and those safeguards are not in this file: \`zoho-books-invoice\` for invoices and customers, \`zoho-books-bill\` for vendor bills, \`zoho-books-money\` for payments and expenses.
- Sharing a tool with those skills does not make a write safe here. Do not perform one merely because the tool would accept it.

OUTPUT:
- State the account used, material filters, record type, and confirmed result.
- Never create, update, delete, export, schedule, message, email, or save anything for a read-only request.`,
};

export const zohoBooksReadAnalysisSkill: Skill = {
  id: 'zoho-books-read-analysis',
  name: 'Zoho Books Read and Analysis',
  description: 'Read, aggregate, reconcile, and verify Zoho Books data without side effects, including complete paginated calculations and GSTR-2B comparisons.',
  toolIds: ['zohoBooks'],
  instructions: `${ZOHO_CONNECTION_METHOD}

READ ROUTING:
- Bounded lookup or preview, with no requested artifact or destination -> the matching zohoBooks read op with narrow filters.
- Complete artifact -> use the local Python workflow below, persist every page outside model context, then use the requested destination specialist and reconcile source, written, and read-back counts. A request such as “export all expenses for this date range from this account into a new Google Sheet” is already clear. Do not ask whether to proceed.
- Exact whole-account or potentially large aggregate with no requested artifact -> ${GOVERNED_LOCAL_AVAILABLE_RUNTIME}, load \`divo-python-automation\`, fetch \`page=1\` then each returned \`nextPage\` through the same persistent Python file, and write rows to disk before calculating. Do not pull pages into model context. If page 100 still reports more rows, state that the source cap was reached rather than claiming completeness.
- In either terminal paging loop, set \`limit=200\` on every page, matching Zoho Books' supported page size. A chat-preview limit such as 10 or 25 belongs to chat; carrying it into the loop multiplies provider calls for no benefit.
- Zoho Books arguments are top-level. Never wrap them in a Google-style \`input\` object — that is a different tool's shape.
- When the member gives a bounded date range, pass its exact ISO boundaries as \`dateFrom\` and \`dateTo\` on the first call and every paginated call. Never fetch the whole Zoho account and filter it locally when the provider operation accepts those filters.
- Never page or transfer with the Zoho \`script\` parameter. ${GOVERNED_LOCAL_AVAILABLE_RUNTIME}, use \`page\`, \`hasMore\`, and \`nextPage\` through \`divo-local\` so each saved response keeps the documented structured page envelope.
- ${GOVERNED_LOCAL_AVAILABLE_RUNTIME}, read the result file path returned by \`divo-local invoke\`; its governed Zoho result is at \`data\`, list rows are \`data.preview.rows\`, the reported count is \`data.report.returnedCount\`, and pagination is \`data.hasMore\` plus \`data.nextPage\`. Never count keys in \`data\` as records.
- Latest/recent bounded invoices -> op="list_invoices" with the requested limit. Do not scan or sort thousands of rows to find them.
- Human invoice number -> op="get_invoice" with that exact number, or list_invoices with searchQuery. Accept only an exact normalized invoice_number match before using its invoice_id; never substitute a fuzzy result.
- Purchase-order lookup -> op="list_purchase_orders" for a bounded list, or op="get_purchase_order" with an exact purchase-order ID or number.
- Aging/overdue report -> op="build_overdue_report".
- Product, item, SKU, or standard rate question -> op="list_items". Report the rate it returns; never quote a price from memory or from an earlier conversation.
- GST or tax rate question, and any tax decision that will be written to a record -> op="list_taxes". Never infer a percentage from an invoice you read.
- Vendor or customer outstanding / payable / receivable balance for one contact -> list_contacts with searchQuery when needed, then get_contact with the contactId. Bill or invoice balance sums are detail only and can be lower when opening balances exist.
- Before describing a total as exact, reconcile it: every source page accounted for, and the row count you computed over stated alongside the figure.

GSTR-2B AND DOCUMENT RECONCILIATION:
- Read the uploaded workbook from its attached workspace path. Identify B2B and B2B-CDNR tables by their headers rather than trusting one company's fixed row numbers, and exclude repeated headers and total rows.
- Verify the GSTIN/period in the workbook against the selected organisation when that identity is available. If Divo cannot verify the organisation identity, say so and ask the member to confirm it; a filename is not proof.
- Build the Zoho bill index through the complete paginated \`list_bills\` workflow. Match first on exact normalized document number; use vendor name, date, and total to confirm, and resolve the live contact/GSTIN only where ambiguity requires it. A substring or fuzzy number is only an ambiguous candidate and must never be marked reconciled automatically.
- Report matched, missing, ambiguous, and unverified records separately, with source and Zoho counts. The current governed tool does not expose Zoho vendor credits, so B2B-CDNR/vendor-credit coverage must be labelled incomplete rather than silently treated as missing or complete.
- Create an output workbook only when requested. Preserve original document numbers and amounts alongside match status and the Zoho record ID; never modify Zoho during reconciliation.

WRITES ARE NOT THIS SKILL:
- This skill reads. Creating, editing, issuing, emailing, voiding, attaching, paying, or expensing anything is a different workflow, and the safeguards those need are not in this file: \`zoho-books-invoice\` for invoices, \`zoho-books-purchase-order\` for purchase orders, \`zoho-books-bill\` for vendor bills, and \`zoho-books-money\` for payments and expenses.
- The zohoBooks tool will accept a write from here because it is the same tool. That is not permission. A write performed under this skill is a write performed without its checks.

OUTPUT:
- State the account used, material filters, count, total, and whether all pages were processed.
- Preserve Zoho identifiers exactly as returned, including invoice numbers; never add, remove, or reformat identifier characters.
- Report only figures returned by the tool computation. Do not add uncomputed remainders, percentages, or other derived claims.
- Never create, update, delete, schedule, message, email, or save anything in Zoho for a read-only request. A requested export may write only to the explicitly requested destination, after all source pages are on disk and counts reconcile.`,
};

const ZOHO_BOOKS_BILL_WORKFLOW = `ZOHO BOOKS BILL RECORDING:
- Use this workflow when the user asks to record, create, or enter a vendor bill/invoice in Zoho Books, especially with a PDF invoice.
- Keep this order: read the source, resolve the live vendor/account/tax IDs, check the exact bill number for duplicates, decide GST or RCM, show the review, create only after confirmation, attach the source, then verify the stored bill.
- Extract invoice data from the attached/source PDF before writing: invoice or bill number, date, vendor name, GSTIN/PAN/address, line items, tax breakdown, total, and IRN when present. The PDF is already in the workspace at the path given in [ATTACHED_FILES]; open and read it before any Zoho write.
- The source invoice/bill number is the Zoho Books bill_number. It is the vendor's own reference, printed on their invoice: read it from the document or ask for it. Never compose one from the vendor's name and the month — an invented number reconciles against nothing and hides the real duplicate.
- Never create a second bill with the same normalized bill_number. Search existing bills first with op="list_bills" using searchQuery/date/vendor filters where possible; accept only exact normalized bill_number matches. If one already exists, do not create another bill and do not record another payment — read its \`documents\` list and attach the PDF only if it is missing.
- Resolve the vendor by GSTIN when the document provides one, then by name. Use op="list_contacts" and then op="get_contact" on the exact candidate. Verify it is active, usable as a vendor, and that gst_treatment, GSTIN, place/state, currency, and address agree with the source. Never create or select a near-name vendor merely to get past a provider rejection.
- Fetch chart of accounts with op="get_chart_of_accounts" and choose the expense account that matches the service. Do not guess silently when the account choice is ambiguous.
- Determine tax treatment before choosing a tax ID. The supplier PDF's tax is evidence of what the supplier charged, but it does not override buyer-side reverse-charge rules. Use the current vendor gst_treatment, supplier registration/GSTIN, place of supply, source document, company procedure, and live op="list_taxes" result together.
- For ordinary registered domestic GST, compare vendor and buying-organisation states: different means IGST; the same means CGST plus SGST. For an overseas/import-of-services case, an unregistered vendor (including gst_treatment="business_none"), freight/transport, or another reverse-charge category, do not assume ordinary line tax. If the correct treatment is uncertain, show the alternatives and ask before creating.
- For reverse charge, set is_reverse_charge_applied=true on the bill and put only reverse_charge_tax_id on each taxable RCM line. Omit/clear ordinary tax_id on those lines; never send both. Resolve the applicable live tax ID rather than copying one from another organisation.
- Before every bill create, show a concise human review: vendor and GST status, bill number and dates, lines and ledger/item mapping, ordinary GST or RCM treatment, TDS/withholding, supplier payable, tax liability when distinct, total, tag/location when applicable, payment state, and attachment. Obtain confirmation; a provider rejection is new evidence, never permission to silently retry tax-free or with different tax fields.
- Apply TDS/withholding only when the source, member, current company procedure, and live Zoho setup establish that it applies. Resolve its live ID; calculate it on the taxable value rather than the GST-inclusive total, and show how it changes supplier payable. Do not infer “no TDS” merely because the purchase is goods.
- Preserve the source currency for a foreign vendor unless the member or current Zoho record establishes a different booked currency. Never invent an exchange rate.
- For inventory-backed lines, resolve the exact item/SKU. When governed live evidence says storage/bin tracking applies, use the confirmed location and storage with in_quantity for purchased stock. Never evade tracking by altering an item name or silently converting it to a generic expense line. If the governed surface cannot expose the required location/storage, say that plainly and stop rather than borrowing an old or hard-coded ID.
- Create the bill with op="create_bill" and fields containing vendor_id, bill_number, date, due_date, line_items, and notes including IRN/payment context when available. Every line uses a numeric account_id or item_id resolved from current Zoho data plus quantity and rate; never put an account name in an ID field or replace quantity/rate with an improvised amount. Ordinary GST belongs on each taxable line as tax_id. Reverse charge belongs on each taxable line as reverse_charge_tax_id with is_reverse_charge_applied=true at bill level and no ordinary tax_id. Never send a top-level taxes array or mix normal and reverse-charge tax fields.
- Attach the source PDF with op="attach_document" and recordType="bill" on the bill_id. If the tool says it cannot find or download the file, say the bill was created without its PDF and ask the member to send the file again.
- Record payment only when the user asks or the invoice is clearly paid. If unpaid or bill-only, leave it open and say payment was not recorded.
- For vendor payments, Zoho defaults to Undeposited Funds unless paid_through_account_id is set in the create payload. There is no vendor-payment update op, so if that account is not known before recording, stop and ask rather than recording a payment that will need correcting by hand.
- Verify from the stored record returned by create_bill and, where needed, an exact list_bills read-back. Check vendor, bill number, dates, line mapping, ordinary tax versus RCM fields, tax/TDS totals, supplier balance, status, payment_made, bill_id, and document list. State anything the available read surface could not verify.
- Final response must say whether the bill was created, updated, unchanged, or blocked; include bill ID/link, payment status, and PDF attachment status.`;

export const zohoBooksBillSkill: Skill = {
  id: 'zoho-books-bill',
  name: 'Zoho Books Bill Recording',
  description: 'Record vendor bills in Zoho Books from PDFs with duplicate checks, normal GST or reverse-charge reasoning, TDS review, attachment, and optional payment routing.',
  toolIds: ['zohoCrm', 'zohoBooks'],
  instructions: `${ZOHO_CONNECTION_METHOD}

SCOPE — CHECK THIS BEFORE ANYTHING ELSE:
- This is money WE OWE A SUPPLIER: a bill they issued to us. Money owed TO us is a customer invoice — load \`zoho-books-invoice\` instead.
- If the member said "invoice", "raise", "bill a customer", or named someone we are charging, this is not the right skill. Stop and load \`zoho-books-invoice\`. Do not translate their word into a bill because a PDF is attached.

WHICH WAY DOES THE DOCUMENT POINT:
- Before resolving any vendor, say to yourself who ISSUED the document and who it is ADDRESSED TO. The issuer is the letterhead, the sender, the party whose GSTIN sits at the top; the addressee is under "Bill to", "Invoice to", or "Customer".
- If the issuer is this Zoho organisation — our own name or our own GSTIN on the letterhead — then WE sent this document. It is an invoice we raised, never a bill we owe. Stop and load \`zoho-books-invoice\`, and treat the party under "Bill to" as the customer.
- A vendor bill is a document somebody else issued TO us. If you cannot tell which direction it runs, ask the member rather than picking one; a bill booked backwards makes the company its own supplier and puts money it is owed on the wrong side of the books.
- Divo refuses a bill or a contact whose party is this organisation. If you meet that refusal, it means the direction was read backwards — do not work around it by renaming the vendor.

${ZOHO_WRITE_SAFETY}

${ZOHO_FINANCE_EVIDENCE}

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

export const zohoBooksPurchaseOrderSkill: Skill = {
  id: 'zoho-books-purchase-order',
  name: 'Zoho Books Purchase Orders',
  description: 'Prepare and create vendor purchase orders with staged human confirmation, duplicate protection, and attachment verification.',
  toolIds: ['zohoBooks'],
  instructions: `${ZOHO_CONNECTION_METHOD}

SCOPE:
- A purchase order is our request to a vendor for goods or services before their invoice arrives. It does not record money owed and it is not a vendor bill.
- Use this workflow to list, inspect, prepare, or create a purchase order. Creating a bill after delivery is a separate \`zoho-books-bill\` workflow.

${ZOHO_WRITE_SAFETY}

${ZOHO_FINANCE_EVIDENCE}

PREPARE:
1. Read any supplied quotation, estimate, specification, or procurement request fully. Confirm it is addressed to the selected organisation and extract its vendor, quotation/reference number, dates, delivery terms, items, shipping/adjustments, taxes, and total.
2. Resolve the vendor with op="list_contacts", inspect the exact contact with op="get_contact", and use its vendor_id. Check gst_treatment, GSTIN, and state/place before choosing any line tax. A previous purchase order is evidence of a convention, not permission to copy stale vendor, address, tax, tag, or terms.
3. Resolve every item with op="list_items" and every applicable tax with op="list_taxes". Never invent an item ID or tax ID. For ordinary registered domestic GST, use the live tax_id that matches the intra-state or inter-state treatment. For an unregistered vendor, including gst_treatment="business_none", do not stage ordinary GST: set is_reverse_charge_applied=true on the purchase order and put only reverse_charge_tax_id on each taxable line, omitting ordinary tax_id. Never send both tax fields. Show the vendor value separately from the projected RCM liability and let Zoho calculate the stored totals. If the treatment is uncertain, ask before staging. A purchase order does not move stock, so do not add in_quantity/out_quantity merely because a later invoice or bill will need storage allocation.
4. Search op="list_purchase_orders" for any supplied purchaseorder_number or reference_number. If an exact existing record matches, read it instead of creating a duplicate.
5. Include date and expected_delivery_date when known. Delivery cannot precede the purchase-order date. Use delivery/billing address IDs from the live contact or organisation when available instead of inventing or compressing an address.
6. Apply company tags, branch/location, terms, or custom fields only when the member, current company procedure, or live Zoho records establish them.
7. Use the vendor quotation, approved estimate, specification, or procurement request as fileName only when that exact file was supplied in the conversation.

STAGE, CONFIRM, CREATE:
- Call op="stage_purchase_order" with fields containing vendor_id, date, line_items, and any purchaseorder_number, reference_number, expected_delivery_date, notes, terms, tax, and delivery details the member supplied.
- stage_purchase_order writes nothing. Show stagedSummary exactly and ask the member to confirm it.
- Only after confirmation call op="create_purchase_order" with the returned stagingId and the same connectionId. Creation replays the stored draft rather than accepting replacement fields.
- The created record remains a draft. Do not say it was submitted, approved, marked open, emailed, or sent to the vendor; those actions are not part of this capability.
- A provider tax rejection is new evidence, not permission to retry silently. Re-stage the corrected treatment, show the changed summary, and obtain fresh confirmation before another create attempt.
- If creation loses its response, do not retry or stage a duplicate. Check Zoho first and report the uncertainty exactly.

VERIFY:
- Report the returned purchase-order number, status, vendor, total, link, and attachment result.
- Preserve identifiers exactly as Zoho returns them.`,
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

${ZOHO_FINANCE_EVIDENCE}

BEFORE WRITING:
1. Source direction. If a document is supplied, verify this organisation is the issuer and the other party is the customer/addressee. Extract the complete lines, PO/reference, dates, address, shipping/adjustments, tax, and total; stop on a GSTIN or organisation contradiction rather than billing the wrong entity.
2. Duplicate check. Search with op="list_invoices" and searchQuery, or op="get_invoice" with an exact invoice number, before creating anything the member describes as already existing. Accept only an exact normalized invoice_number match. Never assume a voided or failed number can be reused; let Zoho auto-number when the member did not provide an approved number.
3. Customer and line items. Resolve by GSTIN when available and then name with op="list_contacts"; inspect the exact contact with op="get_contact", then op="list_items". Use a free-typed name and rate only when the member explicitly describes a one-off charge that is not in the item list, and say that you did.
4. Tax. op="list_taxes", and set place_of_supply to the customer's state code as Zoho writes it ("RJ", "KA"). A customer in another state than the selling organisation means IGST; the same state means CGST plus SGST. Divo checks that direction against the organisation it is creating in and refuses a draft that has it backwards. An overseas/export invoice uses the treatment and zero-rated tax Zoho returns for that organisation; never copy a rate or tax ID from another invoice or instruction.
5. Inventory. Resolve an exact item/SKU. When governed live evidence says storage/bin tracking applies, include the confirmed location and storages with out_quantity. Never evade matching or bin rules by changing the item name. If the governed surface cannot expose the required location/storage, say that plainly and stop rather than borrowing an old or hard-coded ID.
6. Company conventions. Tags, channel/custom fields, branch/location, template, and numbering series must come from the member, a current company procedure, or live Zoho evidence. Show any inferred convention as unconfirmed during staging.

CREATING — STAGE, SHOW, THEN CREATE:
- op="stage_invoice" writes nothing to Zoho: it runs the automatic checks, has a reviewer read the draft cold, and returns a summary plus a stagingId. Pass fileName when the member sent the document this invoice comes from, so the reviewer reads the source rather than your account of it.
- Show the member that summary EXACTLY as written, including everything listed as unconfirmed. Those are values nobody stated — a rate taken from the catalogue, a due date copied from past terms. They are usually right, and the member is the only one who can say so.
- Ask them to confirm, then op="create_invoice" with that stagingId. If they want a change, do not edit and create: stage again with the change and show them the new summary.
- If the reviewer FAILED the draft, it found something that contradicts what the member said, the document, or a Zoho record. Correct those exact fields and re-stage. When the tool reports no corrections left, stop and put the reviewer's objection to the member in their own words — do not keep re-staging.
- If the reviewer could not run, the summary says so. Show the member and tell them plainly that this draft was not reviewed.
- If the result carries a drift list, Zoho stored something differently from what the member approved. Tell them that before anything else, and before issuing or emailing it.

WHEN A CREATE DOES NOT COME BACK CLEANLY:
- Read what the tool says and repeat it. It distinguishes three different things, and they are not interchangeable: the invoice was never sent to Zoho, Zoho refused it, or the answer was lost.
- When the answer was lost, Divo searches Zoho itself. If it finds the invoice, the create is reported as a success with the real invoice — say it was created, not that it might have been.
- If that search found nothing, the invoice most likely does not exist, but the draft is spent. Do not create it again on your own initiative. Tell the member what happened, and stage it afresh only once they confirm it is missing.
- Re-staging is a decision the member makes, never a retry you perform. When they do confirm, Divo searches Zoho again before letting the new draft through — so if it refuses at that point, an earlier attempt did reach the books and the customer would have been billed twice. Repeat that refusal to them as it is written.

ISSUING:
- Ask whether the member wants the invoice issued (mark_invoice_sent) or emailed to the customer (send_invoice) rather than choosing for them. Issuing an invoice and emailing a customer have different consequences.

CORRECTING:
- op="update_invoice" with invoiceId and only the fields that change.
- Zoho refuses edits to an invoice that is paid or partially paid. When that happens, say so and offer a credit note as the next step rather than retrying.

ATTACHING:
- op="attach_document" with recordType="invoice" on the invoice_id. If the tool says the file is missing, ambiguous, or undownloadable, say the invoice stands without its attachment and ask the member to send the file again.

VERIFY AND REPORT:
- State the invoice number, its status, total, balance, and its link, all from what the tool returned.
- Say plainly which of these happened: created, issued, emailed, attached, or left as a draft. Never imply an act you did not perform.
- Preserve Zoho identifiers exactly as returned; never reformat an invoice number.`,
};

export const zohoBooksMoneySkill: Skill = {
  id: 'zoho-books-money',
  name: 'Zoho Books Payments and Expenses',
  description: 'Record customer payments against invoices and log expenses in Zoho Books, settling the right record rather than leaving money unattached.',
  toolIds: ['zohoBooks'],
  instructions: `${ZOHO_CONNECTION_METHOD}

SCOPE:
- Money arriving from a customer, and money the company spends. Raising an invoice is \`zoho-books-invoice\`; recording what a supplier billed us is \`zoho-books-bill\`.

${ZOHO_WRITE_SAFETY}

${ZOHO_FINANCE_EVIDENCE}

RECORDING A CUSTOMER PAYMENT:
- Receiving money and settling an invoice are two different events, and only one of them is usually meant. A payment recorded without naming an invoice sits in Zoho as an unapplied credit: the invoice keeps its full balance and the customer is chased for money they have already paid.
- Find the invoice first. op="list_invoices" with searchQuery, or op="get_invoice" with the exact number. Take its invoice_id and its current balance.
- op="record_payment" with fields containing customer_id, date, amount, payment_mode, and invoices: [{ invoice_id, amount_applied }]. The tool refuses a payment that settles nothing.
- amount_applied is what this payment clears on that invoice, and it cannot exceed the invoice balance. Paying several invoices at once means several entries in that list.
- Money genuinely received before any invoice exists is an advance. Only then, say so to the member and pass on_account: true.
- If the tool reports that Zoho attached part of the payment to no invoice, repeat that figure and read the invoice back with op="get_invoice" before describing it. A leftover can mean the customer overpaid, in which case the invoice is settled and the surplus is a credit; or that less was applied than intended, in which case it is still outstanding. The invoice's own balance decides, not the leftover.
- Ask which account the money landed in rather than choosing one. Zoho files a payment with no account under Undeposited Funds, which someone has to unpick later.

LOGGING AN EXPENSE:
- Read the complete receipt or supporting document when one is supplied. If it is actually a supplier invoice that creates a payable, stop and use \`zoho-books-bill\` rather than flattening it into an expense.
- op="list_taxes" and the chart of accounts give the real ids. Treat old expenses as clues only. op="create_expense" with fields containing account_id, date, amount, and paid_through_account_id.
- The expense account and the account it was paid from are two separate choices, and both belong to the member. Never pick either silently — if the member did not say, ask, and name the options you found.

VERIFY AND REPORT:
- Report the balance the tool returned, not the balance you expect after arithmetic you did yourself.
- Say which invoice was settled and by how much. If an invoice is now fully paid, say so; if it is part paid, give the remaining balance.
- Never describe money as received, applied, or paid unless the tool confirmed it.`,
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
- Use this only when the user asks to notify an Accounts group or explicitly requests this workflow.
- After the Zoho bill step is created, updated, or verified, notify the exact Accounts Lark/Feishu group the member named or the company has configured, from the user's identity when available.
- The notification must include: vendor name, bill number, bill ID, bill date, due date, status, total, balance, payment made, expense account, paid-through account or "Payment not recorded", vendor GSTIN, source/destination of supply, tax name and amount, PDF filename, and Zoho bill link.
- Use only the Zoho bill link returned by the tool. Never construct a company-specific hostname or organisation URL.
- Send the source PDF as the immediate follow-up file attachment when Lark file upload is available.
- If the requested/configured Accounts group is unavailable, stop after the Zoho bill verification and tell the user the group must be configured. Do not guess a Lark group.
- If Lark sending fails because of missing auth/scopes, keep the Zoho bill intact and report the exact next authorization step.

FINAL RESPONSE:
- Report whether the bill was created, updated, unchanged, or blocked.
- Include bill ID/link, whether payment was recorded or intentionally skipped, whether the Accounts notification was sent, and whether the PDF attachment was sent.
- Never claim the notification was sent unless the Lark tool succeeded.`,
};
