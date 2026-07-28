import type { Skill } from './skill.types';

export const larkSkill: Skill = {
  id: 'lark',
  name: 'Lark Operations',
  description: 'Tasks, messaging, calendar, video meetings, docs, contacts, approvals, Base tables',
  toolIds: ['larkTask', 'larkMessaging', 'larkCalendar', 'larkMeeting', 'larkDoc', 'larkContacts', 'larkBase', 'larkApproval'],
  instructions: `ROUTING — pick the right tool:
- "schedule / book / set up a meeting" → larkCalendar (NEVER larkTask)
- "create task / todo / follow-up / reminder" → larkTask (NEVER larkCalendar)
- "create doc / document / page / notes" → larkDoc (NEVER larkTask)
- "find past meeting / meeting details / recording" → larkMeeting
- "my open tasks / pending" → larkTask listOpenMine
- "approvals waiting on me" → larkApproval

SKILL TREE:
- For Lark work, load lark-router first, then the one family skill it selects.
- The selected family skill and loaded tool schema define the complete current scope. Do not infer unlisted capabilities from the Lark SDK.

TASK CREATION:
- Title = the full natural-language description verbatim.
- "meeting with X", "sync with X" → X is part of the TITLE, not an assignee. Leave assigneeNames empty.
- Only set assigneeNames when user explicitly says "assign to X", "task for X", "delegate to X".
- "me" / "remind me" → assignToMe=true. Never look up the requester by name.
- dueDate: only when specific date/time mentioned. Always ISO 8601 with IST offset (+05:30).
- Subtasks: create_subtask with parentTaskId. Tasklists: create_tasklist / add_to_tasklist.

CALENDAR / MEETINGS:
- Default duration: 30 min. Default start: 09:00 IST next business day if no time given.
- Add attendees only when explicitly named. Resolve names to Lark open IDs.
- Ambiguous name (multiple matches) → ask user to clarify, never guess.
- "Is X free?" / "check availability" → free_busy op with names array. NEVER use list/get for others' calendars.
- A user's openId is NOT a calendarId.
- Recurring: create_recurring with recurrence field. Never use plain create for repeating events.
- Update attendees: update_attendees with addNames/removeNames.

VIDEO MEETINGS:
- Search historic meetings with larkMeeting search. Read a known meeting with get.
- Retrieve a recording only with get_recording and a known meetingId; return the exact URL Lark returns.
- larkMeeting is read-only. Do not claim it can join, end, invite, remove participants, or control a live meeting.

MESSAGING:
- Send only to explicitly named recipients or chats.
- DM by name: send_dm with recipientName.
- Group: ALWAYS call list_chats first to find chatId — never ask user for chatId.
- @mention in group: mention op with chatId + mentionNames array.
- Bot not in group → tell user to add the bot first.

DOCS:
- Create only when asked. Return the doc title and the canonical URL returned by Lark.
- Never construct a document URL from docToken. If create succeeds, preserve its url exactly.
- "to-dos / checklist in the document" → larkDoc todo blocks. Never imitate checkboxes with bullets or emoji.
- Prefer append_blocks for a section. Rich text uses textStyle; block behavior uses blockStyle.
- Edit: list_blocks to get blockId, then update_block/update_block_style/delete_block. Keep tables within 9×9.
- Drive scope is metadata, list, create folder, copy, move, and move-task status only. A successful move_file means accepted; use check_drive_task when task_id is returned before claiming completion.

HINGLISH: Mixed-language requests map to the same English action. Language never changes tool choice.

ERROR HANDLING:
- Attendee not found → ask for Lark email or ID.
- Permission missing → tell user to contact admin.
- Tool fail → retry once with adjusted input, then return exact reason.

NEVER: claim action happened without tool success, expose tool names/raw IDs, use filler phrases.`,
};
