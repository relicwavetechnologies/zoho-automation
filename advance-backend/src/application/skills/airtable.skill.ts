import type { Skill } from './skill.types';

type AirtableToolId = 'airtableRecords' | 'airtableSchema' | 'airtableAutomation';

/*
 * The wrapper this used to teach — root `op: "tools.invoke"` with a
 * `payload: { toolId, args }` envelope — was the divo_gateway mega-tool, which
 * has been deleted. Each family is a registered typed tool now, so the envelope
 * is not merely unnecessary, it is rejected. What a tool definition cannot say
 * is which of the three Airtable tools owns a given job, and what to do when
 * the run offers no connection or several.
 */
const airtableConnectionMethod = (toolId: AirtableToolId) => `GOVERNED AIRTABLE ACCESS:
- Reach Airtable only through Divo's registered Airtable tools. This skill's own work goes through \`${toolId}\`; records and comments use \`airtableRecords\`, base shape uses \`airtableSchema\`, and interfaces and automations use \`airtableAutomation\`. Never call Airtable directly and never use a personal access token.
- Omit \`connectionId\` unless the member selected an account or the last Airtable result returned eligible choices. Divo selects the sole account eligible for the exact action and scopes.
- If a result supplies several connections, ask one short account-choice question using their labels, then use the selected exact ID. If none is eligible, report the returned access or connection problem.
- Never guess a connection, and never pass a base, workspace, or label name where a backend-provided \`connectionId\` belongs.`;

const AIRTABLE_ID_DISCIPLINE = `IDENTIFIER DISCIPLINE:
- Airtable IDs have fixed prefixes: bases are app..., tables tbl..., fields fld..., records rec..., views viw....
- Never invent, guess, or reconstruct an ID, and never pass a user-facing name where an ID is required.
- Resolve IDs first: search_bases or list_bases for a base, list_tables_for_base for tables, list_fields_for_table for the complete field ID/name index of one table, get_table_schema for detailed selected-field schemas, and list_records_for_table or search_records for records.
- Resolve field IDs with list_fields_for_table before asking get_table_schema for detail. Divo synthesizes list_fields_for_table rather than Airtable serving it, so no contract is ever bound for that one.
- Direct schema discovery keeps small select lists inline but replaces large choice catalogues with \`choiceCount\` and \`choicesOmittedFromPreview\`. When an exact choice ID is needed from an omitted catalogue, run that same selected-field get_table_schema call through divo-local and search the protected JSON file locally; do not load the catalogue into chat context.
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

/*
 * The `filters` tree and the date VALUE/RANGE objects used to be written out
 * here in full. `AirtableContractBootstrapService` binds
 * `list_records_for_table` before inference for every record run, and its own
 * comment gives the reason: the filter tree is a deeply nested union that no
 * model reconstructs correctly from prose, and each failed guess costs a larger
 * validation dump than the schema itself. Prose was the losing copy.
 *
 * What stays is what the schema cannot encode: which operator suits which field
 * type, why a choice ID beats a choice name, and — the one that changes an
 * answer rather than a call — that a named calendar month is not a rolling
 * window. `list_fields_for_table` guidance also stays: Divo synthesizes that
 * operation, so no contract is ever bound for it.
 */
const AIRTABLE_READ_CRAFT = `READING AND FILTERING:
- Build the \`filters\` tree from the bound \`list_records_for_table\` contract. Never hand-write or URL-encode an Airtable formula string, and never send \`filter\` singular.
- Match the operator to the field type: single select and single collaborator use =, !=, isAnyOf, isNoneOf; multiple selects and multiple collaborators use hasAnyOf, hasAllOf, =, doesNotContain; linked records use hasAnyOf, hasAllOf, =, isNoneOf, contains, doesNotContain.
- For single-select and multiple-select operands, prefer the choice ID from get_table_schema (\`sel...\`) over the choice name. The contract is the ID; a renamed or near-duplicate option makes a name silently wrong.
- \`search_records\` and \`list_records_for_table\` take different inputs and are not interchangeable. Prefer \`list_records_for_table\` whenever you already hold exact table and field IDs.
- Always pass fieldIds with only the fields the answer needs. Pulling every field on a wide table wastes the run's context for no benefit.
- Prefer sort plus a small page over fetching everything when the member asked for a top-N answer.

DATE WINDOWS:
- A date operand is never a bare date string, and \`timeZone\` is always required. Take the exact value and range shapes from the bound contract.
- When the member named a specific month, quarter, year, or date range, express it as two exactDate comparisons — \`>=\` the first day and \`<\` the first day of the NEXT period — and never substitute a relative mode. \`pastMonth\` is a rolling window ending today, not a calendar month, and \`thisCalendarMonth\` is the current month, not the one the member named. Filtering July with pastMonth answers a different question and returns a different number.
- Use the time zone the business keeps its dates in, not UTC. Menhood order dates are Asia/Kolkata.

DIRECT PREVIEWS AND FILE-BACKED READS:
- Ordinary direct \`op: "call"\` record reads return a byte-safe preview and hide continuation cursors.
- For a complete artifact or calculation, make the same native operation through \`divo-local call airtableRecords.<nativeTool> --input-file <path>\`. The JSON file contains only the native \`input\`; the client constructs \`op\`, \`nativeTool\`, and result-file transport internally. Its raw page and cursor are written to a protected local file instead of model context.
- Filter at Airtable first with the native structured \`filters\`, request only required \`fieldIds\`, and preserve any sort. Pass each returned cursor into the next call and stop only when the provider reports no page remains.
- Estimate the scope before an unfiltered scan. If it will be materially large or slow, ask the member before starting it.
- The response still carries \`metadata.totalRecordCount\`, which is the server's exact count of every record matching the filter, not the number of rows previewed. When the member asked how many, that number IS the answer: filter precisely, read totalRecordCount, and report it. Send \`pageSize: 1\` when only the count is wanted.
- To break a count down by category, run one more filtered read per bucket and read each totalRecordCount. Resolve the buckets from the field's real options, and show the leftover between the buckets and the total rather than dropping it.
- When \`hasMore\` is true the returned rows are a preview, not a sample. Never derive a distribution, share, percentage, average, minimum, maximum, date range, or sum from them, and never call them representative. Present them as examples or not at all.
- Sums — units, quantity, amount — cannot be computed from the direct preview. For a complete non-Menhood calculation, use file-backed calls and compute over the reconciled local rows. For settled Menhood history, use \`menhood-data\` instead.
- If a preview says more rows exist, do not treat it as a complete dataset. For settled synced Menhood analytics use \`menhood-data\`; for live/recent Menhood order counts or Airtable-view filters that the sync does not carry, use the live Orders table here and answer from totalRecordCount. For another complete Airtable artifact or calculation, use file-backed calls rather than widening model context.
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
- Use \`menhood-data\` for settled historical joins, cohorts, and aggregates. Use live Airtable for current/latest Menhood facts and Airtable-only semantics such as Regular Order and Team Duplicate/TEST/Testing.
- For a named Menhood product, resolve the catalog entry with \`menhood-data\` first and carry its one canonical \`product_sku\` into Airtable's SKU filter. Product Name is a display label with aliases and duplicate choices, so never treat a literal product-name choice as canonical identity. Ask only when the catalog maps the request to multiple distinct SKUs.
- For an ordinary Menhood product "sales" request, filter the exact date window and canonical SKU, require \`Order Sub Status\` = Regular Order, and exclude \`Order Status (Team)\` Duplicate/TEST/Testing unless the member explicitly asks to include those operational rows.
- \`metadata.totalRecordCount\` proves matching Airtable records/order lines. Orders require distinct order numbers; units require summing quantity; amount requires summing the selected value field. Compute those over complete protected local-file pages, not a direct preview. Label \`final_amount\` as final-amount/gross order value unless the member defines another meaning.
- Hosted MCP records carry values under \`cellValuesByFieldId\`, not \`fields\`. Flatten that map once in the local script. Reconcile every complete calculation or artifact against the filtered source count, and never present a partial page as a complete answer.

ARTIFACTS:
- Never claim a complete Airtable artifact from an ordinary direct preview. Completeness requires file-backed calls to exhaust the provider cursor, followed by source/written/read-back count reconciliation.
- Use the persistent Python workflow for paging, calculation, transformation, joins, more than one connected product, or related destination writes.
- Never expose connection IDs, provider IDs, or bulk rows in the final answer.

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
