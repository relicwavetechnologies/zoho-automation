import type { Skill } from './skill.types';

type AirtableToolId = 'airtableRecords' | 'airtableSchema' | 'airtableAutomation';

const airtableConnectionMethod = (toolId: AirtableToolId) => `DIVO-GOVERNED AIRTABLE CONNECTION:
- Invoke Airtable only through the Divo tool surface available in the current runtime: Pi/desktop exposes divo_gateway, while a direct server runner may expose call_tool. Never call Airtable directly, never use a personal access token, and never switch to an unavailable tool surface.
- A call requires an exact connectionId supplied by the current run. Describe may omit it only to inspect an approved operation schema.
- For divo_gateway, the only valid wrapper for this skill's primary Airtable tool is root \`op: "tools.invoke"\` with \`payload: { toolId: "${toolId}", args: { op: "describe"|"call", nativeTool, connectionId, input } }\`. Put \`connectionId\` inside \`payload.args\`, never beside \`payload\`.
- If this skill intentionally uses another loaded Airtable tool, substitute that exact toolId: record native tools use \`airtableRecords\`, schema native tools use \`airtableSchema\`, and automation/interface native tools use \`airtableAutomation\`.
- If the current run supplies multiple connections, ask one short account-choice question using those labels, then use the selected exact ID. Do not guess.
- If no connection is accessible, tell the member to connect Airtable or request access to an existing connection.
- Never use a base name, workspace name, or label as connectionId. Use only a backend-provided connectionId.`;

const AIRTABLE_ID_DISCIPLINE = `IDENTIFIER DISCIPLINE:
- Airtable IDs have fixed prefixes: bases are app..., tables tbl..., fields fld..., records rec..., views viw....
- Never invent, guess, or reconstruct an ID, and never pass a user-facing name where an ID is required.
- Resolve IDs first: search_bases or list_bases for a base, list_tables_for_base for tables, list_fields_for_table for the complete field ID/name index of one table, get_table_schema for detailed selected-field schemas, and list_records_for_table or search_records for records.
- get_table_schema input is { baseId, tables: [{ tableId, fieldIds: ["fld..."] }] }. Resolve field IDs with list_fields_for_table first; never guess this shape.
- Some operations accept a table or field NAME as well as an ID. Table names resolve case-insensitively; field names resolve case-SENSITIVELY. When a name has failed once, resolve the ID and use it.
- To act on specific records, filter or search for them first and use the returned record IDs. Never assume a record ID from context.`;

const AIRTABLE_WRITE_SAFETY = `WRITE SAFETY:
- Read the table schema before the first write to a table in this run. Field names, types, and select options must come from the schema, not from assumption.
- update_records_for_table merges: fields you omit keep their current values. Send only the fields that should change.
- performUpsert CREATES rows whose merge values do not exist yet. Treat it as a create, say so before using it, and only merge on unique non-computed fields (never a formula, lookup, or rollup).
- Use typecast only when deliberately coercing strings into select/date/number values. It can silently create new select options.
- Writes are capped per request. Batch related records into one call rather than looping one record at a time, and never fan out many single-record calls.
- Airtable rate limits per BASE. Work through one base at a time instead of interleaving several.
- Confirm before any delete. Say exactly what will be removed and how many rows.
- Let backend RBAC/HITL handle approval. Never state a mutation is complete until the tool confirms success after approval.

UNDO:
- revert_action reverses an earlier eligible write using the actionId that write returned.
- Only calls that explicitly returned an actionId can be reverted, one actionId per call.
- Record UPDATES are NOT revertible. Never promise a member that an update can be undone; if the previous values matter, read and report them before updating.`;

const AIRTABLE_READ_CRAFT = `READING AND FILTERING:
- list_records_for_table input uses \`filters\` plural, not \`filter\`: \`{ baseId, tableId, fieldIds, filters, sort?, pageSize? }\`. \`filters\` is a structured tree, not a formula string: an operator ("and"/"or") plus operands, each with its own comparison operator (=, !=, <, >, <=, >=, contains, doesNotContain, isAnyOf, isNoneOf, hasAnyOf, hasAllOf, isWithin, isEmpty, isNotEmpty). Build the filter tree; never hand-write or URL-encode a formula.
- Each leaf condition is \`{ operator, operands: [fieldId, value] }\`, and the first operand must be a \`fld...\` ID. isEmpty and isNotEmpty take the field ID alone.
- For single-select and multiple-select operands, prefer the choice ID from get_table_schema (\`sel...\`) over the choice name. The contract is the ID; a renamed or near-duplicate option makes a name silently wrong.
- search_records has a different input shape: \`{ baseId, table, query, fields?, resultFieldIds?, filters?, sort?, limit? }\`. Never pass \`tableId\`, \`fieldIds\`, \`filter\`, or \`pageSize\` to search_records. Prefer list_records_for_table when you already have exact table and field IDs.
- Match the operator to the field type: single select and single collaborator use =, !=, isAnyOf, isNoneOf; multiple selects and multiple collaborators use hasAnyOf, hasAllOf, =, doesNotContain; linked records use hasAnyOf, hasAllOf, =, isNoneOf, contains, doesNotContain.
- Always pass fieldIds with only the fields the answer needs. Pulling every field on a wide table wastes the run's context for no benefit.
- Prefer sort plus a small page over fetching everything when the member asked for a top-N answer.

DATE WINDOWS:
- A date operand is never a bare date string. For =, !=, <, >, <=, >= on a date or dateTime field the second operand is a date VALUE object. Fixed points use \`{ mode: "exactDate", exactDate: "2026-07-01", timeZone: "Asia/Kolkata" }\`; relative points use mode today, tomorrow, yesterday, oneWeekAgo, oneWeekFromNow, oneMonthAgo, oneMonthFromNow, or \`{ mode: "daysAgo"|"daysFromNow", numberOfDays, timeZone }\`. \`timeZone\` is always required.
- isWithin takes a date RANGE object instead: \`{ mode: "pastWeek"|"pastMonth"|"pastYear"|"nextWeek"|"nextMonth"|"nextYear"|"thisWeekToDate"|"thisMonthToDate"|"thisYearToDate"|"thisCalendarWeek"|"thisCalendarMonth"|"thisCalendarYear", timeZone }\` or \`{ mode: "pastNumberOfDays"|"nextNumberOfDays", numberOfDays, timeZone }\`.
- When the member named a specific month, quarter, year, or date range, express it as two exactDate comparisons — \`>=\` the first day and \`<\` the first day of the NEXT period — and never substitute a relative mode. \`pastMonth\` is a rolling window ending today, not a calendar month, and \`thisCalendarMonth\` is the current month, not the one the member named. Filtering July with pastMonth answers a different question and returns a different number.
- Use the time zone the business keeps its dates in, not UTC. Menhood order dates are Asia/Kolkata.

COUNTS FROM A BOUNDED PREVIEW:
- Record reads return a small preview and never a continuation cursor. Paging is deliberately impossible here: never send \`offset\` or \`cursor\`, and never try to walk the table for a total.
- The response still carries \`metadata.totalRecordCount\`, which is the server's exact count of every record matching the filter, not the number of rows previewed. When the member asked how many, that number IS the answer: filter precisely, read totalRecordCount, and report it. Send \`pageSize: 1\` when only the count is wanted.
- To break a count down by category, run one more filtered read per bucket and read each totalRecordCount. Resolve the buckets from the field's real options, and show the leftover between the buckets and the total rather than dropping it.
- When \`hasMore\` is true the returned rows are a preview, not a sample. Never derive a distribution, share, percentage, average, minimum, maximum, date range, or sum from them, and never call them representative. Present them as examples or not at all.
- Sums — units, quantity, amount — cannot be computed through this lane at all: there is no aggregation and no full row set. Report the exact count, say plainly that the value total is not available here, and offer a backend-replayable export if the member needs it.
- If a preview says more rows exist, do not page through Airtable MCP for a broad analysis, CSV, Excel, or Google Sheet. For settled synced Menhood analytics use \`menhood-data\`; for live/recent Menhood order counts or Airtable-view filters that the sync does not carry, use the live Orders table here and answer from totalRecordCount. For other Airtable data, use \`secure-data-export\` only when an exact backend-replayable connection, base, table, operation, and filters are already resolved. Otherwise ask for a bounded preview or say the full export is not available through MCP.
- Do not claim a total the selected route did not actually prove, and say so plainly when a bounded answer stopped early.`;

export const airtableCoreSkill: Skill = {
  id: 'airtable-core',
  name: 'Airtable Core',
  description: 'Read, search, create, update, upsert, and delete Airtable records and comments across bases and tables, with schema-aware filtering and safe batch writes.',
  toolIds: ['airtableRecords'],
  instructions: `${airtableConnectionMethod('airtableRecords')}

ROLE:
- This is Divo's Airtable record specialist.
- Use it for reading, searching, reporting on, and editing records and record comments.
- If the member asks to change the SHAPE of a base — new table, new field, field type change, deleting a table — fetch and follow skill airtable-schema-ops instead.
- If the member asks about interfaces, pages, forms, or automations, fetch and follow skill airtable-automation-ops.

${AIRTABLE_ID_DISCIPLINE}

${AIRTABLE_READ_CRAFT}

${AIRTABLE_WRITE_SAFETY}

ANALYSIS:
- Airtable returns raw rows; it does not aggregate. For Menhood settled historical totals, grouping, ratios, cohorts, or cross-table joins, switch to \`menhood-data\` instead of paging Airtable MCP. Exception: use live Airtable for narrow current/recent Menhood order counts and Airtable-view semantics such as \`Order Status (Team)\`, \`Order Sub Status\`, Duplicate/TEST/Testing cleanup, or Regular Order filtering, because the reporting sync cannot represent those filters. When routed here for recent Menhood data or cleanup fields, perform the live read yourself; do not ask whether to check Airtable. If the live read is truncated, say the total is not proven and do not present it as final.
- For Menhood live order-count reconciliation, first resolve the live base/table/field IDs and select-choice IDs, then filter the Orders table and read \`metadata.totalRecordCount\`. The cleanup shape is the product identity + \`Order Sub Status\` = Regular Order + \`Order Status (Team)\` isNoneOf Duplicate/TEST/Testing, bounded by the member's exact requested dates. A named month is two exactDate comparisons in Asia/Kolkata — for July 2026, \`Order Date\` >= 2026-07-01 and < 2026-08-01 — never \`pastMonth\`.
- The Orders table is order-line grain. Call what totalRecordCount returns "order lines" or "records", not orders, and do not state distinct order numbers, units, or amount from this lane, because it cannot aggregate them. A status or payment split is allowed only as one filtered count per bucket, never read off the preview rows.
- For Menhood product identity, filter on the field the member's wording names: a product-name prompt resolves against \`Product Name\`, and \`SKU\` is for when the member gave a SKU or the name maps to exactly one SKU. Resolve the exact select option with get_table_schema and filter on that option ID; never use \`contains\` on free text. For "Trimmer 1.0" take only the exact Trimmer 1.0 product option; do not include charging cable or replacement blade unless the member asks for accessories/replacements too.
- For non-Menhood Airtable analysis, use MCP only when the member gave a narrow bounded scope; otherwise ask for a smaller preview or a backend-replayable export source.
- Each Airtable row arrives with its fields nested. Flatten once when writing the file, then read plain column names; deciding row-by-row whether to reach for row.fields or row.cellValuesByFieldId is where these scripts go wrong.
- Never estimate a number you did not compute, and never present a partial page as a complete total.

EXPORTS:
- A plain complete export from one Airtable table belongs to secure-data-export only when the backend has an exact replayable Airtable source, not this skill's pagination loop or the Python workflow.
- If a bounded Airtable preview is useful but no backend-replayable export source or \`exportCandidate\` exists, do not offer a full export. If an exact replayable source exists and the member has not asked for a file yet, you may ask one soft follow-up about exporting to Google Sheets, Excel, or CSV, unless the member explicitly said not to export, not now, or chat-only.
- Use Python only when the request also needs calculation, transformation, joins, more than one connected product, or related destination writes.
- Keep backend-returned export job IDs for status and safe resume only; never expose connection IDs, provider IDs, or bulk rows in the final answer.

OUTPUT:
- Answer in business language: what the records say, which ones matter, and the concrete next step.
- Include Airtable record or base links when the member will need to open them.
- Do not expose internal tool IDs, connection IDs, gateway plumbing, or raw API dumps unless the member asks how it works.`,
};

export const airtableSchemaOpsSkill: Skill = {
  id: 'airtable-schema-ops',
  name: 'Airtable Schema Operations',
  description: 'Create and modify the structure of Airtable bases: new bases, tables, and fields, renames and descriptions, and table deletion with confirmation.',
  toolIds: ['airtableSchema', 'airtableRecords'],
  instructions: `${airtableConnectionMethod('airtableSchema')}

ROLE:
- Use this only when the member is changing the STRUCTURE of a base: creating a base or table, adding or changing fields, renaming, or deleting a table.
- Record-level work belongs to skill airtable-core. Interfaces and automations belong to skill airtable-automation-ops.
- This capability is restricted by default. If the tool reports the action is not allowed, tell the member an administrator must grant Airtable schema access — do not attempt a workaround through record tools.

${AIRTABLE_ID_DISCIPLINE}

SCHEMA CHANGES ARE ADDITIVE FIRST:
- Always read the current schema with get_table_schema or list_tables_for_base before proposing a change.
- Prefer adding a new field over changing an existing field's type. A type change can destroy or reinterpret existing values.
- Never delete a field or table to "fix" a type problem. Add the corrected field, migrate values with airtableRecords, and only then propose removing the old one as a separate, explicitly confirmed step.
- When creating fields, choose the Airtable field type deliberately and state why. Select options, linked-record targets, and formulas must be specified, not defaulted.
- Creating a base or table is not reversible through Divo. Confirm the name, location, and structure first.

DELETION:
- delete_table is destructive and removes every record in that table. State the table name, its row count, and get an explicit confirmation before calling it.
- If the member's intent could be satisfied without deleting, propose that alternative first.
- Divo's revert capability does not cover schema changes. Never imply a schema change can be undone.

VERIFICATION:
- After any change, re-read the schema and report the actual resulting structure rather than the structure you intended.

OUTPUT:
- Report exactly what was created, changed, or deleted, with names and IDs, and what was left untouched.
- If something was blocked by permissions or by a confirmation you did not receive, say so plainly.`,
};

export const airtableAutomationOpsSkill: Skill = {
  id: 'airtable-automation-ops',
  name: 'Airtable Interfaces & Automations',
  description: 'Inspect and build Airtable interfaces, pages, and forms, and create or modify base automations, which are saved as drafts for manual activation.',
  toolIds: ['airtableAutomation', 'airtableRecords'],
  instructions: `${airtableConnectionMethod('airtableAutomation')}

ROLE:
- Use this for Airtable interfaces, interface pages, forms, and base automations.
- Record work belongs to skill airtable-core; base structure belongs to skill airtable-schema-ops.
- This capability is restricted by default. If the tool reports the action is not allowed, tell the member an administrator must grant Airtable automation access.

${AIRTABLE_ID_DISCIPLINE}

AUTOMATIONS:
- Call get_create_automation_instructions before building your first automation in a run. It carries the current authoring contract; do not invent trigger or node shapes.
- Use list_automations and get_automation to inspect what already exists before adding anything. Prefer updating an existing automation over creating a near-duplicate.
- Automations created or modified through Divo are saved as DRAFTS. They do not run until someone activates them in Airtable. Always say this in the final answer; never report an automation as live.
- fetch_automation_input_data and list_external_accounts resolve real option values for automation inputs. Use them instead of guessing configuration values.
- delete_automation is destructive and not revertible. Confirm before calling it.

INTERFACES, PAGES, AND FORMS:
- describe_page_type and describe_page_element are read-only contracts for what a page or element accepts. Consult them before create_page.
- Editing an existing interface page is not supported through this lane. If the member asks for that, say so and offer to create a new page or hand off the change in Airtable.
- publish_interface makes an interface visible to its audience. Treat it as an outward-facing action: confirm before publishing.
- submit_form submits real data through a form. Only use it when the member explicitly asked to submit, and echo the values first.

VERIFICATION:
- After any change, re-read with list_automations, get_automation, or list_pages_for_base and report the actual state.

OUTPUT:
- State what was created or changed, whether it is a draft or live, and the exact remaining manual step the member must take in Airtable.
- Never claim an automation is running or an interface is published unless the tool confirmed it.`,
};

export const airtableSkills: readonly Skill[] = [
  airtableCoreSkill,
  airtableSchemaOpsSkill,
  airtableAutomationOpsSkill,
];
