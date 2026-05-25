import type { Skill } from './skill.types';

export const zohoSkill: Skill = {
  id: 'zoho',
  name: 'Zoho Operations',
  description: 'CRM (contacts, leads, deals, accounts, tasks, pipeline, forecasts), Books (invoices, bills, expenses, payments)',
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

ZOHO CRM — OPERATIONS:
- List records: op=list, module=Leads|Contacts|Accounts|Deals|Tasks
- Get single record: op=get, module, recordId
- Search by criteria: op=search, module, criteria="(Field:operator:value)"
  Operators: equals, starts_with, contains, not_equal, greater_than, less_than, between
  Combine with and/or: "(Deal_Name:contains:Acme)and(Stage:equals:Qualification)"
- Free-text search: op=search_text, module, query="search term"
- Create: op=create, module, fields={...}
- Update: op=update, module, recordId, fields={...}
- Delete: op=delete, module, recordId

CRM REPORTS:
- Pipeline summary: op=build_pipeline_summary — deals grouped by stage with amounts
- Lead funnel: op=build_lead_report — leads grouped by source and status
- Deal forecast: op=build_deal_forecast, closingFrom, closingTo — deals closing in period

CRM FIELD NAMES:
- Leads: First_Name, Last_Name, Email, Company, Phone, Lead_Source, Lead_Status, Annual_Revenue
- Contacts: First_Name, Last_Name, Email, Phone, Account_Name (lookup)
- Accounts: Account_Name, Website, Phone, Industry, Annual_Revenue, Account_Type
- Deals: Deal_Name, Amount, Stage, Closing_Date, Account_Name (lookup), Contact_Name (lookup), Probability
- Tasks: Subject, Due_Date, Status, Priority, Who_Id (contact), What_Id (deal/account)
- All modules have: Owner (lookup), Created_Time, Modified_Time

CRM SCRIPT MODE:
- Add script parameter to list op. Tool fetches ALL records and runs JS in sandbox.
- Synthetic fields: _amount (primary amount), _date (primary date), _id, _status, _owner (resolved name)
- Set exportCsv=true for CSV download of processed results.

PDF / DOCUMENT AWARENESS:
- Zoho Books extracts all data from uploaded PDFs into structured records.
- "Check the PDFs" / "scan the bills" = check STRUCTURED DATA, not raw PDF files.

LIST / EXPORT RULES:
- If user says "all", "everything", "export", "CSV" → set exportAll=true.
- Multi-currency totals must stay grouped by currency. Never merge currencies into one total.

AUDIT / VERIFICATION HONESTY:
- Always state WHAT you checked and the limitation.
- Never present text-matching as a definitive audit.

DATE RULES:
- "this month" → first to last day of current calendar month, IST.
- "this year" → calendar year unless user specifies fiscal year explicitly.
- Prefer natural filter values: "today", "last month", "this quarter", "2026", or ISO 8601.

HINGLISH: Mixed-language requests map to the same English action.

NEVER: invent or estimate financial figures, round amounts, filter to "this year" unless asked, expose tool names/raw IDs.`,
};
