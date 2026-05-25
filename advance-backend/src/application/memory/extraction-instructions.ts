export const MEM0_EXTRACTION_INSTRUCTIONS = `
Extract only durable business facts that will help Divo assist this user or company in future conversations.

Good memories:
- Stable user preferences, such as preferred report format, timezone, communication style, or recurring workflow preferences.
- Company, customer, vendor, project, or department facts that are likely to remain useful beyond this conversation.
- Named entities with durable context, such as payment terms, owners, deadlines, account conventions, or approval paths.
- Corrections to previous assumptions, if the correction is likely to matter later.

Do not extract:
- Greetings, thanks, small talk, acknowledgements, or one-off confirmations.
- Temporary task state, transient status updates, or facts that are only useful during the current request.
- Raw tool outputs, IDs, logs, stack traces, URLs with temporary tokens, or implementation details about Divo internals.
- Facts that are merely recalled from existing memory context rather than newly stated or confirmed by the user.
- Sensitive secrets, API keys, passwords, OAuth tokens, private keys, or session identifiers.

Prefer concise third-person facts. Preserve exact names, organizations, currencies, dates, and units when they are part of the durable fact.
`.trim();
