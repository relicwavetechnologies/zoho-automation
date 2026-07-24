import { argString } from './invoke-args'
import type { DescriptorTable } from './google/types'

/**
 * Zoho CRM / Books descriptor tables. Zoho calls are flat (`args.op` + fields);
 * op keys match the backend zod enums. CRM's subject is its module/record,
 * Books' is the invoice/contact. Unmapped ops fall back to generic handling.
 */

// op: list | get | search | search_text | create | update | delete | build_pipeline_summary | build_lead_report | build_deal_forecast
const crm: DescriptorTable = {
  list: { verb: { present: 'Listing', past: 'Listed' }, countNoun: 'record', subject: (a) => argString(a, 'module') },
  search: { countNoun: 'record', subject: (a) => argString(a, 'criteria', 'query', 'module') },
  search_text: { countNoun: 'record', subject: (a) => argString(a, 'query', 'module') },
  get: { verb: { present: 'Reading', past: 'Read' }, subject: (a) => argString(a, 'module', 'recordId') },
  create: { verb: { present: 'Creating record', past: 'Created record' }, action: 'create', subject: (a) => argString(a, 'module') },
  update: { verb: { present: 'Updating record', past: 'Updated record' }, action: 'update', subject: (a) => argString(a, 'module', 'recordId') },
  delete: { verb: { present: 'Deleting record', past: 'Deleted record' }, action: 'delete', subject: (a) => argString(a, 'module', 'recordId') },
  build_pipeline_summary: { verb: { present: 'Building pipeline summary', past: 'Built pipeline summary' } },
  build_lead_report: { verb: { present: 'Building lead report', past: 'Built lead report' } },
  build_deal_forecast: { verb: { present: 'Building deal forecast', past: 'Built deal forecast' } },
}

// op: list_invoices | get_invoice | create_invoice | list_contacts | get_contact | list_expenses | list_bills | list_payments | get_chart_of_accounts ...
const books: DescriptorTable = {
  list_invoices: { countNoun: 'invoice' },
  get_invoice: { verb: { present: 'Reading invoice', past: 'Read invoice' }, subject: (a) => argString(a, 'invoiceId', 'invoiceNumber') },
  create_invoice: { verb: { present: 'Creating invoice', past: 'Created invoice' }, action: 'create', subject: (a) => argString(a, 'customerName', 'invoiceNumber') },
  list_contacts: { countNoun: 'contact' },
  get_contact: { verb: { present: 'Reading contact', past: 'Read contact' }, subject: (a) => argString(a, 'contactId', 'contactName') },
  list_expenses: { countNoun: 'expense' },
  list_bills: { countNoun: 'bill' },
  list_payments: { countNoun: 'payment' },
  get_chart_of_accounts: { verb: { present: 'Reading accounts', past: 'Read accounts' }, countNoun: 'account' },
}

export const ZOHO_DESCRIPTORS = { crm, books }
