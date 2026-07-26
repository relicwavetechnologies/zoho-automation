import { argString } from './invoke-args'
import type { DescriptorTable } from './google/types'

/**
 * Descriptors for the three Airtable tools. Like Google, these are MCP-backed:
 * the card keys on `nativeTool` and the real arguments arrive nested under
 * `input`, so every `subject` here reads from the native input object.
 *
 * Airtable identifies things by prefixed IDs (app…, tbl…, fld…, rec…) but the
 * MCP also accepts table and field names, so each subject tries the readable
 * name first and falls back to the ID.
 */

const records: DescriptorTable = {
  list_bases: { verb: { present: 'Listing bases', past: 'Listed bases' }, countNoun: 'base' },
  list_workspaces: { verb: { present: 'Listing workspaces', past: 'Listed workspaces' }, countNoun: 'workspace' },
  search_bases: { verb: { present: 'Searching bases', past: 'Searched bases' }, countNoun: 'base', subject: (a) => argString(a, 'searchQuery') },
  list_tables_for_base: { verb: { present: 'Listing tables', past: 'Listed tables' }, countNoun: 'table', subject: (a) => argString(a, 'baseId') },
  get_table_schema: { verb: { present: 'Reading schema', past: 'Read schema' }, subject: (a) => argString(a, 'tables', 'baseId') },
  list_views_for_table: { verb: { present: 'Listing views', past: 'Listed views' }, countNoun: 'view', subject: (a) => argString(a, 'tableId') },
  list_records_for_table: { verb: { present: 'Reading records', past: 'Read records' }, countNoun: 'record', subject: (a) => argString(a, 'tableId') },
  search_records: { verb: { present: 'Searching records', past: 'Searched records' }, countNoun: 'record', subject: (a) => argString(a, 'query', 'table') },
  list_record_comments: { verb: { present: 'Reading comments', past: 'Read comments' }, countNoun: 'comment', subject: (a) => argString(a, 'recordId') },
  create_record_comment: { verb: { present: 'Commenting', past: 'Commented' }, action: 'create', subject: (a) => argString(a, 'text') },
  create_records_for_table: { verb: { present: 'Creating records', past: 'Created records' }, action: 'create', countNoun: 'record', subject: (a) => argString(a, 'tableId') },
  update_records_for_table: { verb: { present: 'Updating records', past: 'Updated records' }, action: 'update', countNoun: 'record', subject: (a) => argString(a, 'tableId') },
  delete_records_for_table: { verb: { present: 'Deleting records', past: 'Deleted records' }, action: 'delete', countNoun: 'record', subject: (a) => argString(a, 'tableId') },
  revert_action: { verb: { present: 'Reverting', past: 'Reverted' }, action: 'update', subject: (a) => argString(a, 'actionId') },
}

const schema: DescriptorTable = {
  list_bases: records['list_bases']!,
  list_workspaces: records['list_workspaces']!,
  search_bases: records['search_bases']!,
  list_tables_for_base: records['list_tables_for_base']!,
  get_table_schema: records['get_table_schema']!,
  list_views_for_table: records['list_views_for_table']!,
  create_base: { verb: { present: 'Creating base', past: 'Created base' }, action: 'create', subject: (a) => argString(a, 'name') },
  create_table: { verb: { present: 'Creating table', past: 'Created table' }, action: 'create', subject: (a) => argString(a, 'name') },
  update_table: { verb: { present: 'Updating table', past: 'Updated table' }, action: 'update', subject: (a) => argString(a, 'name', 'tableId') },
  delete_table: { verb: { present: 'Deleting table', past: 'Deleted table' }, action: 'delete', subject: (a) => argString(a, 'tableId') },
  create_field: { verb: { present: 'Adding field', past: 'Added field' }, action: 'create', subject: (a) => argString(a, 'tableId') },
  update_field: { verb: { present: 'Updating field', past: 'Updated field' }, action: 'update', subject: (a) => argString(a, 'name', 'fieldId') },
}

const automation: DescriptorTable = {
  list_pages_for_base: { verb: { present: 'Listing pages', past: 'Listed pages' }, countNoun: 'page', subject: (a) => argString(a, 'baseId') },
  describe_page_type: { verb: { present: 'Reading page type', past: 'Read page type' }, subject: (a) => argString(a, 'pageType') },
  describe_page_element: { verb: { present: 'Reading element', past: 'Read element' }, subject: (a) => argString(a, 'elementType') },
  get_form_schema: { verb: { present: 'Reading form', past: 'Read form' }, subject: (a) => argString(a, 'pageId') },
  list_records_for_page: { verb: { present: 'Reading page data', past: 'Read page data' }, countNoun: 'record', subject: (a) => argString(a, 'pageId') },
  get_record_for_page: { verb: { present: 'Reading record', past: 'Read record' }, subject: (a) => argString(a, 'path') },
  search_candidate_linked_records: { verb: { present: 'Finding links', past: 'Found links' }, countNoun: 'record', subject: (a) => argString(a, 'query') },
  list_automations: { verb: { present: 'Listing automations', past: 'Listed automations' }, countNoun: 'automation', subject: (a) => argString(a, 'baseId') },
  get_automation: { verb: { present: 'Reading automation', past: 'Read automation' }, subject: (a) => argString(a, 'automationId') },
  get_create_automation_instructions: { verb: { present: 'Preparing', past: 'Prepared' } },
  list_external_accounts: { verb: { present: 'Listing accounts', past: 'Listed accounts' }, countNoun: 'account' },
  fetch_automation_input_data: { verb: { present: 'Loading options', past: 'Loaded options' }, subject: (a) => argString(a, 'inputKey') },
  create_interface: { verb: { present: 'Creating interface', past: 'Created interface' }, action: 'create', subject: (a) => argString(a, 'name') },
  create_page: { verb: { present: 'Creating page', past: 'Created page' }, action: 'create', subject: (a) => argString(a, 'name') },
  delete_page: { verb: { present: 'Deleting page', past: 'Deleted page' }, action: 'delete', subject: (a) => argString(a, 'pageId') },
  submit_form: { verb: { present: 'Submitting form', past: 'Submitted form' }, action: 'create', subject: (a) => argString(a, 'pageId') },
  // Drafts, not live automations — the skill makes the agent say so, and the
  // card should not imply otherwise either.
  create_automation: { verb: { present: 'Drafting automation', past: 'Drafted automation' }, action: 'create', subject: (a) => argString(a, 'name') },
  update_automation: { verb: { present: 'Updating automation', past: 'Updated automation' }, action: 'update', subject: (a) => argString(a, 'name', 'automationId') },
  delete_automation: { verb: { present: 'Deleting automation', past: 'Deleted automation' }, action: 'delete', subject: (a) => argString(a, 'automationId') },
  publish_interface: { verb: { present: 'Publishing interface', past: 'Published interface' }, action: 'update', subject: (a) => argString(a, 'interfaceId') },
}

export const AIRTABLE_DESCRIPTORS = { records, schema, automation }
