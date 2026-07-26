import type { Skill } from './skill.types';

const AIRTABLE_CONNECTION_METHOD = `DIVO-GOVERNED AIRTABLE CONNECTION:
- Invoke Airtable only through the Divo tool surface available in the current runtime: server channels use call_tool; desktop uses divo_gateway. Never call Airtable directly, never use a personal access token, and never switch to an unavailable tool surface.
- Reuse an exact connectionId already supplied by the current run. Otherwise omit it: the backend selects an account only when exactly one accessible account qualifies.
- If Divo returns structured connection choices, ask one short account-choice question using those labels, then retry with the selected exact ID. Do not guess.
- If no connection is accessible, tell the member to connect Airtable or request access to an existing connection.
- Never use a base name, workspace name, or label as connectionId. Use only a backend-provided connectionId.`;

const AIRTABLE_ID_DISCIPLINE = `IDENTIFIER DISCIPLINE:
- Airtable IDs have fixed prefixes: bases are app..., tables tbl..., fields fld..., records rec..., views viw....
- Never invent, guess, or reconstruct an ID, and never pass a user-facing name where an ID is required.
- Resolve IDs first: search_bases or list_bases for a base, list_tables_for_base or get_table_schema for tables and fields, list_records_for_table or search_records for records.
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
- list_records_for_table takes a structured filter object, not a formula string: an operator ("and"/"or") plus operands, each with its own comparison operator (=, !=, <, >, <=, >=, contains, doesNotContain, isAnyOf, isNoneOf, hasAnyOf, hasAllOf, isWithin, isEmpty, isNotEmpty). Build the filter tree; never hand-write or URL-encode a formula.
- Match the operator to the field type: single select and single collaborator use =, !=, isAnyOf, isNoneOf; multiple selects and multiple collaborators use hasAnyOf, hasAllOf, =, doesNotContain; linked records use hasAnyOf, hasAllOf, =, isNoneOf, contains, doesNotContain.
- Always pass fieldIds with only the fields the answer needs. Pulling every field on a wide table wastes the run's context for no benefit.
- Paginate with cursor: pass the previous response's nextCursor until it is absent. Do not claim a total until pagination is exhausted, and say so plainly when you stopped early.
- Prefer sort plus a small page over fetching everything when the member asked for a top-N answer.`;

export const airtableCoreSkill: Skill = {
  id: 'airtable-core',
  name: 'Airtable Core',
  description: 'Read, search, create, update, upsert, and delete Airtable records and comments across bases and tables, with schema-aware filtering and safe batch writes.',
  toolIds: ['airtableRecords', 'dataProcessor'],
  instructions: `${AIRTABLE_CONNECTION_METHOD}

ROLE:
- This is the Airtable data router and the default Airtable skill.
- Use it for reading, searching, reporting on, and editing records and record comments.
- If the member asks to change the SHAPE of a base — new table, new field, field type change, deleting a table — fetch and follow skill airtable-schema-ops instead.
- If the member asks about interfaces, pages, forms, or automations, fetch and follow skill airtable-automation-ops.

${AIRTABLE_ID_DISCIPLINE}

${AIRTABLE_READ_CRAFT}

${AIRTABLE_WRITE_SAFETY}

ANALYSIS:
- Airtable returns raw rows; it does not aggregate. For totals, grouping, ratios, or cross-table joins, pull the needed rows with narrow fieldIds and compute with dataProcessor.
- Never estimate a number you did not compute, and never present a partial page as a complete total.

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
  instructions: `${AIRTABLE_CONNECTION_METHOD}

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
  instructions: `${AIRTABLE_CONNECTION_METHOD}

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
