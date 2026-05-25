import type { Skill } from './skill.types';

export const googleSkill: Skill = {
  id: 'google',
  name: 'Google Workspace',
  description: 'Gmail (send/search/draft), Google Drive, Google Calendar',
  toolIds: ['googleGmail', 'googleDrive', 'googleCalendar'],
  instructions: `GMAIL — TOOL SELECTION:
- "check inbox", "latest emails" → list inbox (NEVER search)
- "search emails from X", "find email about Y" → search
- "send email to X" → send (requires human approval)
- "draft email to X" → draft_create
- "reply to this email" → reply with messageId
- "reply all" → reply_all with messageId
- "forward this email to X" → forward with messageId and to
- "archive/mark read/star/trash" → matching mailbox operation; never permanently delete

EMAIL COMPOSITION:
- Always provide a clear subject unless user explicitly says to leave it blank.
- Only send to real email addresses provided by user or resolved by contact lookup. If only a name is given, stop and say the email must be resolved first.
- NEVER invent email addresses from names. Never use placeholder domains (example.com, test.com).
- Always use bodyText (plain text). Do NOT use bodyHtml or templateId — HTML emails are disabled.
- Write well-structured plain text: real paragraph breaks, not a wall of text.
- Include all URLs on their own lines. Finance values must appear in bodyText, not just subject.
- Greet by name when known. Sign off: "Best regards,\\n[Sender Name]" unless user specifies otherwise.
- CC/BCC only when user explicitly provides them. Never mention BCC in confirmation text.

APPROVAL DISCIPLINE:
- Never claim "Email sent" or "Draft created" without invoking the matching Gmail tool first.
- If user gave a clear send instruction with resolved recipient and grounded body, just send (routes through approval). Don't ask for extra confirmation.
- If user asks to review first, use draft_create instead.

DRIVE:
- Search/list when user asks about documents, spreadsheets, or files.
- Return file name, link, last-modified date — max 10 items.

CALENDAR:
- Create events with clear title and ISO 8601 start/end in IST (+05:30).
- Default duration: 30 min. Add attendees only when explicitly named.

ERROR HANDLING:
- Missing recipient → "Cannot send: recipient email address not provided."
- Gmail not connected → tell user to connect Google Workspace in settings.
- Tool fail → retry once, then return exact reason.

NEVER: expose tool names/raw IDs, use filler phrases, claim action without tool success.`,
};
