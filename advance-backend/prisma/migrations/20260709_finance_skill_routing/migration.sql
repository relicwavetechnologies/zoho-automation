UPDATE "Skill"
SET
  "summary" = 'Route broad finance questions, unpaid invoices, recent payments, overdue reports, tax summaries, and safe read-only finance summaries across Zoho Books and Zoho CRM. Delegates operational workflows to specialist skills.',
  "markdown" = $skill$
# Finance Ops Core

Use this as the finance router and broad read/summary skill.

## Deterministic Routing

- Broad finance numbers, unpaid invoices, recent payments, bank transactions, bills, expenses, or tax summaries -> use this skill with Zoho Books read operations.
- Customer, lead, contact, account, deal, or case relationship context -> use Zoho CRM read operations.
- Vendor bill / invoice PDF / record bill / create bill -> fetch and follow skill `zoho-books-bill`.
- Bill plus Accounts/Core Accounts notification -> fetch and follow skill `zoho-bill-notify-accounts`.

## Zoho Connection

Always start by resolving available Zoho accounts through `divo_gateway`:

```json
{ "op": "connections.list", "payload": { "provider": "zoho" } }
```

Use only the returned `connectionId`. If multiple connections are plausible and the user did not specify, ask one short account-choice question.

## Broad Finance Reads

Invoke backend tools with `divo_gateway` op `tools.invoke`.

Use `zohoBooks`:

- overdue / unpaid invoices -> `op: "build_overdue_report"` or `op: "list_invoices"` with status/date filters
- recent payments -> `op: "list_payments"`
- bills -> `op: "list_bills"`
- expenses -> `op: "list_expenses"`
- bank transactions -> `op: "list_bank_transactions"` or `op: "search_transactions"`
- tax summary -> `op: "get_tax_summary"`

Use `zohoCrm` only when the finance task needs relationship context:

- discovery -> `op: "search_text"` or `op: "search"`
- exact lookup -> `op: "get"`
- broader module reads -> `op: "list"` or CRM report operations

## Write Safety

- Stay read-only when the user says "don't change anything".
- Do not run vendor bill creation from this skill; fetch `zoho-books-bill`.
- Do not run bill notification from this skill; fetch `zoho-bill-notify-accounts`.
- For any mutation, require exact target module/record/payload and let backend RBAC/HITL handle approval.
- Never state that a Zoho Books or Zoho CRM mutation is complete until the tool confirms success after approval.

## Output

Summarize confirmed tool results in business language: totals, statuses, aging/risk, customers/vendors, and follow-up priorities. Do not expose gateway plumbing, raw tool IDs, credentials, or guessed record IDs unless the user asks how it works.
$skill$,
  "toolIds" = ARRAY['zohoBooks', 'zohoCrm', 'documentRag', 'dataProcessor']::TEXT[],
  "updatedAt" = NOW()
WHERE "slug" = 'finance-ops-core';

INSERT INTO "Skill" (
  "id", "companyId", "departmentId", "scope", "name", "slug", "summary", "markdown",
  "toolIds", "tags", "status", "isSystem", "sortOrder", "createdAt", "updatedAt"
)
SELECT
  LOWER(CONCAT(
    SUBSTRING(MD5(base."companyId" || ':zoho-books-bill') FROM 1 FOR 8), '-',
    SUBSTRING(MD5(base."companyId" || ':zoho-books-bill') FROM 9 FOR 4), '-',
    SUBSTRING(MD5(base."companyId" || ':zoho-books-bill') FROM 13 FOR 4), '-',
    SUBSTRING(MD5(base."companyId" || ':zoho-books-bill') FROM 17 FOR 4), '-',
    SUBSTRING(MD5(base."companyId" || ':zoho-books-bill') FROM 21 FOR 12)
  )),
  base."companyId",
  NULL,
  'global',
  'Zoho Books Bill Recording',
  'zoho-books-bill',
  'Record vendor bills in Zoho Books from PDF invoices with duplicate checks, GST handling, PDF attachment, and optional payment routing.',
  $skill$
# Zoho Books Bill Recording

Use this skill when the user asks to record, create, enter, or update a vendor bill/invoice in Zoho Books, especially from a PDF invoice.

## One-Shot Workflow

1. Resolve Zoho connection with `connections.list` provider `zoho`; use only the returned `connectionId`.
2. Extract invoice data before writing: bill number, date, vendor, GSTIN/PAN/address, line items, tax breakdown, total, and IRN when present. Use document/data tools if source text needs extraction.
3. Treat the invoice/bill number as the unique Zoho Books `bill_number`.
4. Search existing bills first with `zohoBooks` read operations. Accept only an exact normalized bill-number match.
5. If the bill exists, do not create another bill and do not record another payment. Verify/repair PDF attachment only when backend support and evidence are clear.
6. Resolve vendor/contact, chart of accounts, and taxes from Zoho. Do not guess ambiguous accounts or taxes.
7. Apply GST rule: EMIAC state is Rajasthan code 08; different vendor state -> IGST, same state -> CGST + SGST. Use actual Zoho tax records.
8. Create the bill with `zohoBooks` op `create_bill` only when fields are exact.
9. Always attach or verify the source PDF when backend support exposes attachment handling; if not verifiable, say so instead of pretending.
10. Record payment only when the user asks or the invoice is clearly paid. Preserve the paid-through account two-step rule; if backend support cannot verify it, stop and report the limitation.
11. Fetch/verify final Zoho state after writes. Report created, updated, unchanged, or blocked.

## Safety

- Never create a duplicate bill with the same source invoice/bill number.
- Never present parsed PDF text as final Zoho truth until the Zoho record is fetched/verified.
- Never invent financial figures, tax IDs, bill IDs, account IDs, attachment status, or payment status.
- Let backend RBAC/HITL handle approvals and retry only the exact approved request.
$skill$,
  ARRAY['zohoBooks', 'zohoCrm', 'documentRag', 'dataProcessor']::TEXT[],
  ARRAY['finance', 'zoho', 'books', 'bill']::TEXT[],
  'active',
  TRUE,
  base."sortOrder" + 1,
  NOW(),
  NOW()
FROM (
  SELECT DISTINCT "companyId", COALESCE(MIN("sortOrder"), 0) AS "sortOrder"
  FROM "Skill"
  WHERE "slug" = 'finance-ops-core'
  GROUP BY "companyId"
) base
WHERE NOT EXISTS (
  SELECT 1 FROM "Skill" s
  WHERE s."companyId" = base."companyId" AND s."slug" = 'zoho-books-bill'
);

INSERT INTO "Skill" (
  "id", "companyId", "departmentId", "scope", "name", "slug", "summary", "markdown",
  "toolIds", "tags", "status", "isSystem", "sortOrder", "createdAt", "updatedAt"
)
SELECT
  LOWER(CONCAT(
    SUBSTRING(MD5(base."companyId" || ':zoho-bill-notify-accounts') FROM 1 FOR 8), '-',
    SUBSTRING(MD5(base."companyId" || ':zoho-bill-notify-accounts') FROM 9 FOR 4), '-',
    SUBSTRING(MD5(base."companyId" || ':zoho-bill-notify-accounts') FROM 13 FOR 4), '-',
    SUBSTRING(MD5(base."companyId" || ':zoho-bill-notify-accounts') FROM 17 FOR 4), '-',
    SUBSTRING(MD5(base."companyId" || ':zoho-bill-notify-accounts') FROM 21 FOR 12)
  )),
  base."companyId",
  NULL,
  'global',
  'Zoho Bill Notify Accounts',
  'zoho-bill-notify-accounts',
  'Create or update a Zoho Books vendor bill from a PDF invoice, then notify the Core Accounts Lark group with an audit summary and source PDF.',
  $skill$
# Zoho Bill Notify Accounts

Use this only when the user asks to notify Accounts/Core Accounts after a Zoho bill workflow.

## One-Shot Workflow

1. First follow `zoho-books-bill` exactly. Preserve duplicate prevention, GST handling, attachment verification, payment routing, and final Zoho verification.
2. Before notifying, fetch/verify the final bill values from Zoho. Do not notify from parsed PDF values alone.
3. Send a Core Accounts Lark message only when a Core Accounts chat/group is configured or the user explicitly identifies it. Do not guess the group.
4. The notification must include vendor, bill number, bill ID/link, bill date, due date, status, total, balance, payment made, expense account, paid-through account or "Payment not recorded", GST/tax details, PDF filename, and what changed.
5. Send the source PDF as a follow-up file when Lark file upload support is available.
6. Final response must say whether the Zoho bill was created/updated/unchanged/blocked, whether notification was sent, and whether the PDF was sent.

## Safety

- Never claim the Accounts notification was sent unless the Lark tool succeeded.
- If Lark sending fails because of missing auth/scopes/config, keep the Zoho bill intact and report the exact next step.
- Let backend RBAC/HITL handle approvals and retry only the exact approved request.
$skill$,
  ARRAY['zohoBooks', 'zohoCrm', 'documentRag', 'dataProcessor', 'larkMessaging']::TEXT[],
  ARRAY['finance', 'zoho', 'books', 'bill', 'lark']::TEXT[],
  'active',
  TRUE,
  base."sortOrder" + 2,
  NOW(),
  NOW()
FROM (
  SELECT DISTINCT "companyId", COALESCE(MIN("sortOrder"), 0) AS "sortOrder"
  FROM "Skill"
  WHERE "slug" = 'finance-ops-core'
  GROUP BY "companyId"
) base
WHERE NOT EXISTS (
  SELECT 1 FROM "Skill" s
  WHERE s."companyId" = base."companyId" AND s."slug" = 'zoho-bill-notify-accounts'
);
