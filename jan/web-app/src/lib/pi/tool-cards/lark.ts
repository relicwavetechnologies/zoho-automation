import { argString } from './invoke-args'
import type { DescriptorTable } from './google/types'

/**
 * Lark / Feishu descriptor tables, one per canonical Lark toolId.
 *
 * Lark calls are flat — the operation is `args.op` (surfaced as
 * `identity.action`) and the params sit beside it. Op keys below match the zod
 * enums in the backend family files exactly; anything unmapped still gets an
 * inferred verb, a generic subject, and a generically-summarized result.
 */

// op: send | list | reply | send_dm | list_chats | search | mention
const messaging: DescriptorTable = {
  send: { verb: { present: 'Sending message', past: 'Sent message' }, action: 'send', subject: (a) => argString(a, 'text', 'content', 'chatId', 'receiveId') },
  send_dm: { verb: { present: 'Sending DM', past: 'Sent DM' }, action: 'send', subject: (a) => argString(a, 'text', 'content', 'userId') },
  reply: { verb: { present: 'Replying', past: 'Replied' }, action: 'send', subject: (a) => argString(a, 'text', 'content') },
  mention: { verb: { present: 'Mentioning', past: 'Mentioned' }, action: 'send', subject: (a) => argString(a, 'text', 'content') },
  list: { verb: { present: 'Reading messages', past: 'Read messages' }, countNoun: 'message' },
  list_chats: { verb: { present: 'Listing chats', past: 'Listed chats' }, countNoun: 'chat' },
  search: { countNoun: 'message', subject: (a) => argString(a, 'query', 'text') },
}

// op: lookup | list_department
const contacts: DescriptorTable = {
  lookup: { verb: { present: 'Looking up', past: 'Looked up' }, subject: (a) => argString(a, 'query', 'name', 'email', 'userId') },
  list_department: { verb: { present: 'Listing department', past: 'Listed department' }, countNoun: 'person', subject: (a) => argString(a, 'departmentId', 'name') },
}

// op: create | update | complete | delete | list | listMine | listOpenMine | get | list_tasklists | create_tasklist | ...
const task: DescriptorTable = {
  create: { verb: { present: 'Creating task', past: 'Created task' }, action: 'create', subject: (a) => argString(a, 'summary', 'title') },
  update: { verb: { present: 'Updating task', past: 'Updated task' }, action: 'update', subject: (a) => argString(a, 'summary', 'title', 'taskGuid') },
  complete: { verb: { present: 'Completing task', past: 'Completed task' }, action: 'update', subject: (a) => argString(a, 'summary', 'taskGuid') },
  delete: { verb: { present: 'Deleting task', past: 'Deleted task' }, action: 'delete', subject: (a) => argString(a, 'summary', 'taskGuid') },
  get: { verb: { present: 'Reading task', past: 'Read task' }, subject: (a) => argString(a, 'summary', 'taskGuid') },
  list: { countNoun: 'task' },
  listMine: { verb: { present: 'Checking my tasks', past: 'Checked my tasks' }, countNoun: 'task' },
  listOpenMine: { verb: { present: 'Checking open tasks', past: 'Checked open tasks' }, countNoun: 'task' },
  list_tasklists: { countNoun: 'list' },
  create_tasklist: { verb: { present: 'Creating list', past: 'Created list' }, action: 'create', subject: (a) => argString(a, 'name') },
  list_subtasks: { countNoun: 'subtask' },
  create_subtask: { verb: { present: 'Adding subtask', past: 'Added subtask' }, action: 'create', subject: (a) => argString(a, 'summary', 'title') },
}

// op: list | get | create | update | delete | free_busy | list_attendees | create_recurring | update_attendees
const calendar: DescriptorTable = {
  list: { verb: { present: 'Checking calendar', past: 'Checked calendar' }, countNoun: 'event' },
  get: { verb: { present: 'Reading event', past: 'Read event' }, subject: (a) => argString(a, 'summary', 'title', 'eventId') },
  create: { verb: { present: 'Creating event', past: 'Created event' }, action: 'create', subject: (a) => argString(a, 'summary', 'title') },
  update: { verb: { present: 'Updating event', past: 'Updated event' }, action: 'update', subject: (a) => argString(a, 'summary', 'title', 'eventId') },
  delete: { verb: { present: 'Deleting event', past: 'Deleted event' }, action: 'delete', subject: (a) => argString(a, 'summary', 'eventId') },
  free_busy: { verb: { present: 'Checking availability', past: 'Checked availability' } },
  list_attendees: { countNoun: 'attendee' },
  create_recurring: { verb: { present: 'Creating series', past: 'Created series' }, action: 'create', subject: (a) => argString(a, 'summary', 'title') },
  update_attendees: { verb: { present: 'Updating attendees', past: 'Updated attendees' }, action: 'update' },
}

// op: search | get | get_recording
const meeting: DescriptorTable = {
  search: { countNoun: 'meeting', subject: (a) => argString(a, 'query') },
  get: { verb: { present: 'Reading meeting', past: 'Read meeting' }, subject: (a) => argString(a, 'meetingId', 'title') },
  get_recording: { verb: { present: 'Fetching recording', past: 'Fetched recording' }, subject: (a) => argString(a, 'meetingId') },
}

// op: get | create | list_blocks | append_block | update_block | delete_block | insert_table | share
const doc: DescriptorTable = {
  get: { verb: { present: 'Opening', past: 'Read' }, subject: (a) => argString(a, 'title', 'documentId', 'docToken') },
  create: { verb: { present: 'Creating doc', past: 'Created doc' }, action: 'create', subject: (a) => argString(a, 'title') },
  list_blocks: { verb: { present: 'Reading', past: 'Read' }, countNoun: 'block' },
  append_block: { verb: { present: 'Editing', past: 'Edited' }, action: 'update', subject: (a) => argString(a, 'content', 'text') },
  update_block: { verb: { present: 'Editing', past: 'Edited' }, action: 'update' },
  delete_block: { verb: { present: 'Removing block', past: 'Removed block' }, action: 'delete' },
  insert_table: { verb: { present: 'Inserting table', past: 'Inserted table' }, action: 'create' },
  share: { verb: { present: 'Sharing', past: 'Shared' }, action: 'update' },
}

// op: list_records | get_record | create_record | update_record | delete_record | search_records
const base: DescriptorTable = {
  list_records: { countNoun: 'record', subject: (a) => argString(a, 'tableId', 'tableName') },
  search_records: { countNoun: 'record', subject: (a) => argString(a, 'query', 'tableId') },
  get_record: { verb: { present: 'Reading record', past: 'Read record' }, subject: (a) => argString(a, 'recordId', 'tableId') },
  create_record: { verb: { present: 'Adding record', past: 'Added record' }, action: 'create', subject: (a) => argString(a, 'tableId', 'tableName') },
  update_record: { verb: { present: 'Updating record', past: 'Updated record' }, action: 'update', subject: (a) => argString(a, 'recordId', 'tableId') },
  delete_record: { verb: { present: 'Deleting record', past: 'Deleted record' }, action: 'delete', subject: (a) => argString(a, 'recordId', 'tableId') },
}

// op: list | get | get_definition | create
const approval: DescriptorTable = {
  list: { countNoun: 'approval' },
  get: { verb: { present: 'Reading approval', past: 'Read approval' }, subject: (a) => argString(a, 'instanceId', 'approvalCode') },
  get_definition: { verb: { present: 'Reading definition', past: 'Read definition' }, subject: (a) => argString(a, 'approvalCode', 'approvalName') },
  create: { verb: { present: 'Submitting approval', past: 'Submitted approval' }, action: 'create', subject: (a) => argString(a, 'approvalName', 'approvalCode') },
}

export const LARK_DESCRIPTORS = {
  messaging,
  contacts,
  task,
  calendar,
  meeting,
  doc,
  base,
  approval,
}
