import type { Skill } from './skill.types';

export const googleSkill: Skill = {
  id: 'google',
  name: 'Google Workspace',
  description: 'Use connected Google Workspace accounts for Gmail, Drive, and Calendar.',
  toolIds: ['googleGmail', 'googleDrive', 'googleCalendar'],
  instructions: `GOOGLE WORKSPACE EXECUTION METHOD:
- Always start by resolving available Google accounts. Call divo_gateway with op="connections.list" and payload={"provider":"google_workspace"} before Gmail, Drive, or Calendar.
- If no connections are returned, tell the user to connect Google Workspace from the desktop Plugins page.
- If exactly one connection is returned, use that connectionId.
- If multiple connections are returned, choose by explicit user intent: account email, label, personal/shared ownership, access level, or task purpose.
- If multiple connections are plausible and the user did not specify, ask one short account-choice question. Do not guess.
- Never use an email address, label, or guessed value as connectionId. Use only the backend connectionId from connections.list.
- Invoke tools with divo_gateway op="tools.invoke" and payload={"toolId":"googleGmail"|"googleDrive"|"googleCalendar","args":{...,"connectionId":"selected id"}}.
- For mixed requests, reuse the same selected connection unless the user clearly asks for a different Google account.

PRODUCT ROUTING:
- Email, inbox, drafts, replies, forwarding, labels, archive/read/star/trash -> googleGmail.
- Files, folders, documents, spreadsheets, slides, PDFs, Drive search, file summaries -> googleDrive.
- Meetings, events, schedule, availability, calendar lookup, create/update/delete event -> googleCalendar.
- If the user asks a broad Google question, route to the specific product needed by the task. Do not call all tools without reason.

GMAIL RECIPES:
- Latest inbox / check mail: googleGmail op="list" with limit, no query unless user provided a filter.
- Search mail: googleGmail op="search" with Gmail query string. Use from:, to:, subject:, newer_than:, older_than:, has:attachment when useful.
- Read a specific email after list/search: googleGmail op="get" with messageId from the previous result.
- Thread view: googleGmail op="thread_get" with threadId when conversation context matters.
- Draft email: googleGmail op="draft_create".
- Send email: googleGmail op="send" only when recipient and body are grounded; backend approval may be required.
- Reply: googleGmail op="reply" with messageId. Reply all: op="reply_all". Forward: op="forward" with messageId and to.
- Organize mailbox: archive, mark_read, mark_unread, star, unstar, trash, untrash, label_apply, label_remove. Never permanently delete.

EMAIL COMPOSITION:
- Always provide a clear subject unless user explicitly says to leave it blank.
- Only send to real email addresses provided by user or resolved by contact lookup. If only a name is given, stop and say the email must be resolved first.
- NEVER invent email addresses from names. Never use placeholder domains (example.com, test.com).
- Always use bodyText. Divo renders it with the T1 HTML email template (multipart plain + HTML). Do NOT use bodyHtml unless explicitly required.
- Structure long research/report emails with ALL CAPS section headings (e.g. PRICING, ENGINE SPECS) and bullet lines (- item). Optional templateId: divo-finance-v1 for finance, divo-report-v1 for research summaries.
- Write well-structured plain text: real paragraph breaks, not a wall of text.
- Include all URLs on their own lines. Finance values must appear in bodyText, not just subject.
- Greet by name when known. Sign off: "Best regards,\\n[Sender Name]" unless user specifies otherwise.
- CC/BCC only when user explicitly provides them. Never mention BCC in confirmation text.

APPROVAL DISCIPLINE:
- Never claim "Email sent" or "Draft created" without invoking the matching Gmail tool first.
- If user gave a clear send instruction with resolved recipient and grounded body, just send (routes through approval). Don't ask for extra confirmation.
- If user asks to review first, use draft_create instead.

DRIVE RECIPES:
- Recent files: googleDrive op="list" with limit.
- Find files: googleDrive op="search" with query and limit.
- File metadata only: googleDrive op="get" with fileId.
- File content / deep dive / summarize docs: first list/search, then googleDrive op="read" with fileId for each relevant file.
- op="get" is metadata only and does not return content. Use op="read" for content.
- For Google Docs/Sheets/Slides, op="read" exports before reading. Pass exportMimeType only when a custom format is needed.
- Return grounded summaries with file name, link, last-modified date, and what was read. Do not pretend unread files were inspected.
- If search returns too many plausible files, read the most relevant few first and state the basis for selection.

CALENDAR RECIPES:
- Upcoming schedule: googleCalendar op="list" with calendarId="primary" unless user names another calendar.
- Date-window schedule: for "today", "tomorrow", "this week", "next 7 days", or similar, call googleCalendar op="list" with startTime and endTime as ISO 8601 bounds.
- Use half-open local ranges for day windows: startTime is the local start of the first day; endTime is the local start after the last included day. For "next 7 days", include today plus the following 6 local days: start at today 00:00 local time and end at 00:00 local time 7 days later. Describe the displayed range as the included dates, not the exclusive end date.
- Calendar args use key op, never action. Calendar startTime/endTime must include a timezone offset or Z; do not send timezone-less timestamps.
- Keep the final answer's displayed date range consistent with the exact startTime/endTime window you passed.
- Read event details: googleCalendar op="get" with eventId.
- Create event: googleCalendar op="create" with title, startTime, endTime, optional description and attendeeEmails.
- Update event: googleCalendar op="update" with eventId and changed fields only.
- Delete/cancel event: googleCalendar op="delete" with eventId.
- Use ISO 8601 times. For India/default user context, use IST (+05:30) when the user gives local times.
- Default duration is 30 minutes if the user gives only a start time. Add attendees only when explicitly named or resolved to real emails.

MULTI-STEP BEHAVIOR:
- For "catch me up" style requests, use Gmail list/search plus Calendar list; include Drive only if files/docs are mentioned.
- For "deep dive my Drive" requests, Drive search/list is not enough. Always follow with Drive read on selected files.
- For "email a summary of Drive files", read Drive content first, then draft/send via Gmail using the same selected connection unless user says otherwise.
- For "schedule from email", read the email first, extract grounded details, then create/update Calendar event.

ERROR HANDLING:
- Missing recipient -> "Cannot send: recipient email address not provided."
- Google not connected -> tell user to connect Google Workspace from the desktop Plugins page.
- Permission denied -> say the selected connection or role does not allow that action.
- Tool fail -> retry once only if a better argument can be inferred, then return the exact reason.

NEVER:
- Never expose backend credentials or tokens.
- Never guess connectionId, messageId, fileId, eventId, or recipient email.
- Never claim email sent, draft created, file read, or event changed unless the tool succeeded.
- Never use filler phrases or raw API dumps in the final answer.`,
};
