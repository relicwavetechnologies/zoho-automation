import type { SkillDocument, SkillMetadata } from './types';

const HARD_CODED_SKILLS: SkillDocument[] = [
  {
    id: 'lark-ops',
    name: 'lark-ops',
    description: 'A focused workflow guide for choosing the right Lark surface, asking for the right identifiers, handling RBAC/defaults safely, and sequencing multi-step Lark work across tasks, calendar, meetings, approvals, docs, and base.',
    whenToUse: [
      'when the request spans multiple Lark products or needs a Lark-specific workflow',
      'when the user wants task, calendar, meeting, approval, docs, or base work and the routing is not obvious',
      'when access control, defaults, identifiers, or read-before-write behavior matter for Lark work',
    ],
    tags: ['lark', 'tasks', 'calendar', 'meetings', 'approvals', 'docs', 'base', 'rbac', 'workflow'],
    toolHints: ['larkTask', 'larkCalendar', 'larkMeeting', 'larkApproval', 'larkDoc', 'larkBase'],
    content: `---
name: lark-ops
description: A focused workflow guide for Lark operations across tasks, calendar, meetings, approvals, docs, and base.
when_to_use:
  - when the request spans multiple Lark products
  - when the request is about how to use Lark tools correctly
  - when identifiers, defaults, access control, or read-before-write behavior matter
allowed_tools:
  optional:
    - larkTask
    - larkCalendar
    - larkMeeting
    - larkApproval
    - larkDoc
    - larkBase
  action:
    - larkDoc
required_inputs:
  - objective
optional_inputs:
  - date_scope
  - identifiers
  - target_people
  - calendar_name
  - approval_code
success_criteria:
  - the correct Lark surface is chosen
  - missing identifiers are asked only when truly needed
  - read-before-write sequencing is followed where appropriate
  - the response is grounded in actual Lark results
blocking_rules:
  - do not claim a Lark object exists unless the corresponding tool returned it
  - if access is denied or a default is missing, report that clearly
  - if a Lark surface cannot answer a request, route to the correct surface instead of guessing
---

# Purpose

Use this skill to choose the right Lark worker, decide the likely next read or write step, and ask only for the smallest missing identifier. This skill is guidance only. Loading it does not mean every listed tool should be called.

# Core Rules

- Start from the user outcome, not from the product name.
- Prefer the narrowest correct Lark surface.
- Read before write when a write depends on finding an existing object first.
- Use conversation-scoped memory when the tool supports "current task", "latest event", or "latest doc".
- Ask for a human-friendly identifier first, not a raw system ID, unless the API truly requires the raw ID.
- Treat skill loading as knowledge gathering. Build an execution plan only after checking the exact request.

# Access, Defaults, And RBAC

- Lark tools run under role permissions. A user may be allowed to call a parent Lark agent but still hit access or account limitations inside the underlying API.
- Many Lark reads and writes fall back to company defaults. Try those before asking for raw IDs.
- If no default exists and discovery is supported, discover first and ask the user to choose by name.
- If the available API surface does not support a lookup style, say that plainly and route to the nearest supported surface instead of guessing.

# Top-Level Routing

## Lark Tasks

Use \`larkTask\` for task review and task mutation.

Use it for:
- listing tasks
- reading one task
- working with the current task from this conversation
- listing tasklists
- listing assignable teammates
- creating, updating, or deleting a task

Read actions commonly available:
- \`listTasks\`
- \`getTask\`
- \`currentTask\`
- \`listTasklists\`
- \`listAssignableUsers\`

Write actions commonly available:
- \`create\`
- \`update\`
- \`delete\`

Parameter guidance:
- use \`taskId\` when known
- use \`tasklistId\` only when needed; otherwise let defaults work first
- use \`query\`, \`summary\`, \`completed\`, \`dueAfter\`, and \`dueBefore\` for reads
- use \`assigneeNames\` or \`assignToMe\` for creation when assignment is needed
- do not promise reassignment on update unless the write route supports it

Routing rule:
- when assigning, resolve people first through the task specialist's people lookup path, then write

## Lark Calendar

Use \`larkCalendar\` for day-based discovery and calendar event scheduling.

Use it for:
- events for a date or time range
- reading one event
- listing available calendars
- creating, updating, or deleting an event

Read actions commonly available:
- \`list\`
- \`getEvent\`

Write actions commonly available:
- \`create\`
- \`update\`
- \`delete\`

Parameter guidance:
- prefer \`startTime\` and \`endTime\` for time windows
- use \`calendarId\` only when known or when defaults and calendar discovery fail
- use \`summary\`, \`description\`, and attendees only for explicit event changes

Routing rule:
- if the user asks "what do I have today", calendar is usually the first Lark source

## Lark Meetings

Use \`larkMeeting\` for meeting inspection and minute retrieval, not scheduling.

Use it for:
- reading a known meeting
- fetching a minute
- listing meetings only when the API supports the exact identifier or time-range lookup you need

Read actions commonly available:
- \`list\`
- \`getMeeting\`
- \`getMinute\`

Parameter guidance:
- use \`meetingId\` or \`meetingIdOrUrl\` for meeting inspection
- use \`minuteTokenOrUrl\` for minute lookup
- use time-range listing only when the meeting surface truly supports it

Routing rules:
- do not send scheduling requests to \`larkMeeting\`
- do not use \`larkMeeting\` for generic day-based discovery if calendar events can answer the question better
- if the user only gives a date and asks about meetings, start with calendar

## Lark Approvals

Use \`larkApproval\` for approval definitions and approval instances.

Use it for:
- listing approval definitions
- reading one definition
- listing instances
- reading one instance
- creating a new approval instance

Read actions commonly available:
- \`listDefinitions\`
- \`getDefinition\`
- \`list\`
- \`get\`

Write actions commonly available:
- approval instance creation with \`approvalCode\` plus \`form\` or \`formValues\`

Parameter guidance:
- discover definitions first when the user does not know the right template
- use \`approvalCode\` when known or when a company default exists
- use \`instanceCode\` for one existing approval
- do not attempt creation until the target template and payload are clear

## Lark Docs

Use \`larkDoc\` for document inspection, reading, creation, and edits.

Use it for:
- reading a known or latest conversation doc
- checking whether a doc is available
- creating a doc from already grounded markdown
- editing an existing doc

Rules:
- docs are an output surface, not the primary research surface
- do not create or edit a doc unless the user asked for a doc or artifact
- prefer read or inspect before editing "that doc"
- create only after the content is already grounded elsewhere

Parameter guidance:
- read path uses \`action: read\` or \`inspect\`
- creation needs title plus markdown
- edits need strategy, instruction, and either a document ID or a latest-doc context

## Lark Base

Use \`larkBase\` for Base or Bitable structure and records.

Use it for:
- listing apps, tables, views, or fields
- listing records
- getting one record
- creating, updating, or deleting records

Read actions commonly available:
- \`listApps\`
- \`listTables\`
- \`listViews\`
- \`listFields\`
- \`listRecords\`
- \`getRecord\`

Parameter guidance:
- start with \`appToken\` discovery when unknown
- then resolve \`tableId\`
- then resolve optional \`viewId\`
- use \`recordId\` only when reading or mutating one known record
- use \`query\`, \`filter\`, \`sort\`, and \`fieldNames\` to narrow results

# Internal Helper Paths

- Task assignment may use a people-lookup helper under the task specialist. Use names or emails first, not raw IDs, when possible.
- Calendar resolution may use calendar listing or primary-calendar lookup before asking for a raw calendar ID.
- Approval flows may need definition discovery before instance creation.
- Doc creation and editing are separate operations under the docs specialist even though the top-level worker is \`larkDoc\`.

# Read-Before-Write Rules

- Tasks: read first before updating, deleting, or assigning unless the task is already unambiguous.
- Calendar: read or list first before updating or deleting unless the event ID is already known.
- Meetings: inspect only; do not use for scheduling.
- Approvals: read definitions first when the correct template is unclear.
- Docs: inspect or read first when editing "that doc".
- Base: discover app, table, view, or field context before mutating records.

# Asking For Inputs

Ask only for the narrowest missing thing:

- task name or task ID when changing an existing task
- calendar name before raw calendar ID
- event time when creating or rescheduling and the time is missing
- meeting ID or minute token when the user wants meeting inspection
- approval code only if definition discovery cannot solve it
- app token or table ID only after Base discovery and defaults fail

Do not ask for optional formatting preferences unless the next step truly depends on them.

# Bad Routes To Avoid

- Do not use \`larkDoc\` as the first step for factual discovery.
- Do not use \`larkMeeting\` to answer generic day-based "what meetings do I have" if calendar events can answer it.
- Do not mutate tasks, events, approvals, docs, or base records unless the user clearly asked for that change.
- Do not pretend a missing default or RBAC failure is a user mistake; say clearly what was unavailable.

# Delivery

- Keep the response operational and grounded.
- If work spans multiple Lark surfaces, summarize by surface.
- If a Lark surface failed because of missing defaults, permissions, or unsupported lookup style, say that plainly.
`,
  },
  {
    id: 'daily-stuff',
    name: 'daily-stuff',
    description: 'A structured operating workflow for recurring operational work that may involve internal systems, external research, documents, follow-up tasks, and scheduling.',
    whenToUse: [
      'when the user explicitly mentions "daily-stuff"',
      'when the request sounds like a recurring operational workflow with multiple steps',
      'when the user needs a protocol-heavy process rather than a one-step answer',
    ],
    tags: ['workflow', 'operations', 'daily', 'zoho', 'outreach', 'search', 'lark'],
    toolHints: ['zoho', 'outreach', 'search', 'larkDoc', 'larkTask', 'larkCalendar', 'larkMeeting'],
    content: `---
name: daily-stuff
description: A structured operating workflow for recurring daily work that may require internal systems, external research, documents, follow-ups, and scheduling.
when_to_use:
  - when the user explicitly mentions "daily-stuff"
  - when the request sounds like recurring operational work
allowed_tools:
  required:
    - zoho
    - outreach
    - larkTask
    - larkCalendar
    - larkMeeting
  optional:
    - search
  action:
    - larkDoc
required_inputs:
  - objective
optional_inputs:
  - date_scope
  - stakeholders
  - delivery_style
success_criteria:
  - requested information gathered
  - requested outputs delivered
  - follow-up artifacts created only if requested or clearly needed
blocking_rules:
  - ask only for information that is necessary to proceed
  - if a system is unavailable, complete the supported parts and report the gap clearly
---

# Purpose

Use this skill for structured daily operating work. The goal is not to force a fixed domain route. The goal is to help the controller decide how to gather evidence, ask for missing inputs, complete the work, and deliver a concise grounded result.

# Operating Rules

- Start from the user outcome, not from a tool.
- Use the tools that best fit the current step.
- Prefer first-party internal systems for internal data.
- Use external search only when public or current external information is actually needed.
- After every tool result, reconsider what is still missing.
- Ask focused questions only when the missing input blocks the next real step.
- Do not claim that a document, task, meeting, or update exists unless the corresponding tool actually succeeded.

# Tool Guidance

- Zoho and Outreach are for internal business context.
- Search is for external web context or current documentation.
- Lark Docs are for writing out grounded results after the factual work is done.
- Lark Tasks are for explicit follow-up actions.
- Lark Calendar and Meetings are for scheduling or reviewing meetings only when the user asks for them or the workflow clearly requires them.

# Delivery Rules

- Keep the final response concise and completion-oriented.
- Mention blockers clearly.
- If work is partial, say exactly what was completed and what remains blocked.
`,
  },
];

const scoreSkill = (query: string, skill: SkillMetadata): number => {
  const normalized = query.toLowerCase();
  let score = 0;
  if (normalized.includes(skill.name.toLowerCase())) score += 20;
  for (const tag of skill.tags) {
    if (normalized.includes(tag.toLowerCase())) score += 4;
  }
  for (const phrase of skill.whenToUse) {
    const words = phrase.toLowerCase().split(/\W+/).filter(Boolean);
    if (words.some((word) => normalized.includes(word))) score += 2;
  }
  for (const hint of skill.toolHints) {
    if (normalized.includes(hint.toLowerCase())) score += 3;
  }
  return score;
};

export const listSkillMetadata = (): SkillMetadata[] =>
  HARD_CODED_SKILLS.map(({ id, name, description, whenToUse, tags, toolHints }) => ({
    id,
    name,
    description,
    whenToUse,
    tags,
    toolHints,
  }));

export const searchSkillMetadata = (query: string): SkillMetadata[] =>
  listSkillMetadata()
    .map((skill) => ({ skill, score: scoreSkill(query, skill) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.skill);

export const getSkillDocument = (skillId: string): SkillDocument | null =>
  HARD_CODED_SKILLS.find((skill) => skill.id === skillId) ?? null;
