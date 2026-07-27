import type { Skill } from './skill.types';

/**
 * AITable is a different product from Airtable, and the two skills sit beside
 * each other in the catalogue. Every instruction here names AITable's own
 * vocabulary — spaces, nodes, datasheets, fields, records — so a model that has
 * both available cannot drift between them.
 */

const AITABLE_CONNECTION_METHOD = `DIVO-GOVERNED AITABLE CONNECTION:
- Invoke AITable only through the Divo tool surface available in the current runtime: server channels use call_tool; desktop uses divo_gateway. Never call AITable directly and never handle an API key.
- AITable authenticates with an API key held by the backend. It is never part of tool input, and you must never ask a member to paste one into chat — connecting happens in Divo's own settings.
- Reuse an exact connectionId already supplied by the current run. Only list_spaces may be called without one.
- If Divo returns aitable_connection_selection_required, ask one short account-choice question using the returned labels, then retry with the selected exact ID. Do not guess.
- If Divo returns aitable_key_needs_replacing, the stored key was revoked in AITable. Say so plainly and tell the member to re-enter the key for that connection in Divo. Do not retry; it will fail identically every time.
- Never use a workspace name, datasheet name, or label as a connectionId.`;

const AITABLE_ID_DISCIPLINE = `IDENTIFIER DISCIPLINE:
- AITable IDs have fixed prefixes: spaces are spc..., nodes and datasheets dst..., views viw..., fields fld..., records rec....
- Resolve IDs before using them: list_spaces for a workspace, search_nodes for a datasheet inside it, get_fields for fields.
- search_nodes needs both a spaceId and a node type ("Datasheet", "Folder", "Form", "Dashboard", "Mirror"). Pass a query to narrow by name.
- Never invent an ID or pass a display name where an ID is required.`;

const AITABLE_READ_CRAFT = `READING AND FILTERING:
- Resolve record IDs with list_records before acting on specific records. Never assume a record ID from earlier context.
- list_records takes filterByFormula, a formula STRING in AITable's own syntax — for example {Stage}="Open", or AND({Stage}="Open", {Owner}="Ana"). This is unlike Airtable's structured filter tree; do not send an object.
- Ask for only the fields the answer needs via the fields parameter. Pulling every column of a wide datasheet wastes the run's context.
- Paginate with pageNum and pageSize. pageSize is capped at 1000; the response carries total, so say plainly when you have not read everything.
- Records come back keyed by field NAME, which is what get_fields reports.
- Prefer a sort plus a small page over reading everything when the member asked for a top-N answer.`;

const AITABLE_WRITE_SAFETY = `WRITE SAFETY:
- Call get_fields before the first write to a datasheet in this run. It reports which fields are writable and exactly what each one accepts; a write composed from assumption will be rejected.
- get_fields also returns readOnly, listing fields you cannot write and why. Formula, lookup, auto-number, created/modified time and created/modified by are calculated by AITable — never try to set them, and never tell a member you have.
- Divo refuses a write it cannot encode rather than dropping the field, so a rejected write means nothing was changed. Fix the value and retry; do not work around it by removing the field.
- update_records merges: fields you omit keep their current values. Send only what should change, and always include recordId.
- Writes are sent in batches of 10 records. If a later batch fails you will receive aitable_partial_write listing what already landed — report those records and do NOT blindly retry the whole set, or you will duplicate rows.
- Select fields accept only their declared options. Adding a new option is a schema change, not a record write.
- Attachments must come from AITable's upload step. A URL or file path is not an attachment and will be refused.
- Member fields take AITable unit IDs, not names. If you only have a name, say so rather than guessing which person was meant.
- Confirm before delete_records. Say exactly how many records will be removed and from which datasheet. Deletion is permanent.
- Let backend RBAC and approval handle authorisation. Never claim a change is complete until the tool confirms success.`;

const AITABLE_SCHEMA_SAFETY = `SCHEMA SAFETY:
- create_field and delete_field change the shape of a datasheet for everyone using it, and both need a spaceId as well as a datasheetId.
- delete_field destroys every value stored in that column. It cannot be undone. Name the field and say what will be lost, and only proceed on an explicit yes.
- AITable has no endpoint for editing an existing field, so a field cannot be renamed or retyped through Divo. Say that plainly instead of deleting and recreating, which would discard the data.
- Read get_fields first so a new field does not duplicate one that already exists under a different name.`;

export const aitableDatasheetsSkill: Skill = {
  id: 'aitable-datasheets',
  name: 'AITable Datasheets',
  description:
    'Browse AITable workspaces and datasheets, and read, create, update or delete records, with schema-aware writes and safe batching.',
  toolIds: ['aitableDatasheets', 'dataProcessor'],
  instructions: `${AITABLE_CONNECTION_METHOD}

${AITABLE_ID_DISCIPLINE}

${AITABLE_READ_CRAFT}

${AITABLE_WRITE_SAFETY}`,
};

export const aitableFieldsSkill: Skill = {
  id: 'aitable-fields',
  name: 'AITable Fields',
  description:
    'Inspect the field schema of an AITable datasheet and add or remove fields, with explicit confirmation before destructive schema changes.',
  toolIds: ['aitableFields'],
  instructions: `${AITABLE_CONNECTION_METHOD}

${AITABLE_ID_DISCIPLINE}

${AITABLE_SCHEMA_SAFETY}`,
};

export const aitableSkills: Skill[] = [aitableDatasheetsSkill, aitableFieldsSkill];
