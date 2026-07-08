import type { Skill } from './skill.types';

const ZOHO_CONNECTION_METHOD = `ZOHO CONNECTION METHOD:
- Always start by resolving available Zoho accounts. Call divo_gateway with op="connections.list" and payload={"provider":"zoho"} before Zoho CRM or Zoho Books.
- If no connections are returned, tell the user to connect Zoho from the desktop Plugins page.
- If exactly one connection is returned, use that connectionId.
- If multiple connections are returned, choose by explicit user intent: account label/name, personal/shared ownership, access level, or business purpose.
- If multiple connections are plausible and the user did not specify, ask one short account-choice question. Do not guess.
- Never use a label, organization name, or guessed value as connectionId. Use only the backend connectionId from connections.list.
- Invoke tools with divo_gateway op="tools.invoke" and payload={"toolId":"zohoBooks","args":{...,"connectionId":"selected id"}}.`;

const ZOHO_BOOKS_BILL_WORKFLOW = `ZOHO BOOKS BILL RECORDING:
- Use this workflow when the user asks to record, create, or enter a vendor bill/invoice in Zoho Books, especially with a PDF invoice.
- Extract invoice data from the attached/source PDF before writing: invoice or bill number, date, vendor name, GSTIN/PAN/address, line items, tax breakdown, total, and IRN when present.
- Treat the source invoice/bill number as the unique Zoho Books bill_number.
- Never create a second bill with the same normalized bill_number. Search existing bills first with bill_number and, if needed, search_text/vendor bills; accept only exact normalized bill_number matches.
- If an existing bill is found, do not create another bill and do not record another payment. Check attachment metadata. Attach the PDF only if it is missing; if attachment state cannot be verified, stop and report the risk.
- Resolve or create the vendor only after the global duplicate check.
- Fetch chart of accounts and choose the expense account that matches the service. Do not guess silently when the account choice is ambiguous.
- Fetch taxes and apply GST correctly. EMIAC state is Rajasthan, code 08. Different vendor GST state means IGST; same state means CGST plus SGST. Use actual tax records from Zoho.
- Create the bill with vendor_id, bill_number, date, due_date, line_items, taxes, and notes including IRN/payment context when available.
- Always attach the source PDF to the bill after creation or when repairing a missing attachment.
- Record payment only when the user asks or the invoice is clearly paid. If unpaid or bill-only, leave it open and say payment was not recorded.
- For vendor payments, create payment first, then update paid_through_account_id in a second call; Zoho can otherwise default to Undeposited Funds.
- Verify by fetching the final bill and checking status, balance, payment_made, bill_id, and attachment state.
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
- Use media.image_ocr or available document extraction before Zoho writes when the source is an image/PDF and text extraction is needed.
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
