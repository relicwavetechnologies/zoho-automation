import type { SkillDocument, SkillMetadata } from './types';

const HARD_CODED_SKILLS: SkillDocument[] = [
  {
    id: 'coding-ops',
    name: 'coding-ops',
    description: 'A focused workflow guide for coding tasks that use local workspace edits, terminal commands, reusable scripts, tests, and optional research without guessing or unsafe mutations.',
    whenToUse: [
      'when the request is about coding, fixing, refactoring, debugging, testing, scripting, or running local commands',
      'when the user wants to read code, change files, run scripts, run builds, run tests, or use curl in the local workspace',
      'when safe local execution, verification, and reusable script workflows matter',
    ],
    tags: ['coding', 'code', 'workspace', 'terminal', 'scripts', 'tests', 'debugging', 'refactor', 'patch', 'curl'],
    toolHints: ['repo', 'workspace', 'terminal', 'search'],
    content: `---
name: coding-ops
description: A focused workflow guide for coding work that may require code inspection, local file edits, terminal commands, reusable scripts, tests, and optional external docs.
when_to_use:
  - when the request is about coding, debugging, scripting, testing, or refactoring
  - when the user wants local workspace edits or terminal execution
  - when safe command order and verification matter
tools:
  optional:
    - repo
    - search
  action:
    - workspace
    - terminal
inputs:
  - name: objective
    infer: true
  - name: target_paths
    infer: true
  - name: command_goal
    infer: true
  - name: external_reference
    infer: false
success_criteria:
  - code changes are grounded in inspected files or explicit user direction
  - terminal commands are verified by exit status and useful output
  - reusable scripts are written to stable workspace paths when that improves repeatability
  - the final answer reports what changed, what ran, and what remains risky
blocking_rules:
  - do not claim a command succeeded unless terminal output or exit status confirms it
  - do not claim a file changed unless the workspace action or command actually changed it
  - do not mutate the workspace when a read, inspect, or dry-run step should happen first
---

# Purpose

Use this skill for real coding work in the local workspace. This skill is guidance only. Loading it does not automatically run commands or edit files. It helps the controller choose when to inspect code, when to edit files directly, when to run terminal commands, and how to verify the result.

# Core Rules

- Start from the coding outcome, not from a tool.
- Inspect before mutating when the current state of code or files matters.
- Prefer the narrowest safe action that moves the task forward.
- Use direct workspace writes when the exact file content is already known.
- Use terminal commands when execution, tests, builds, scripts, package managers, git inspection, curl requests, or search utilities are needed.
- After every change, verify with a concrete follow-up step whenever possible.
- Reusable scripts are good. One-off shell hacks are not, unless the task is truly one-off.

# Tool Routing

## Repo

Use \`repo\` for grounded code and repository inspection when the task needs file content, file paths, or repository context as evidence.

Use it for:
- locating files
- retrieving existing code or config content
- grounding a patch or refactor in actual files

Rules:
- prefer reading or inspecting before writing when the codebase shape is unclear
- use repo evidence to decide which file should change

## Workspace

Use \`workspace\` for explicit local file mutations.

Use it for:
- writing a new file with known content
- replacing a file with prepared content
- creating directories
- deleting paths only when the user clearly asked or cleanup is obviously required

Rules:
- prefer \`workspace\` over shell redirection when you already know the exact file content
- use stable paths for reusable scripts, such as \`scripts/\`, \`tools/\`, or task-specific utility files in the repo
- when creating a reusable script, make the filename descriptive and reusable, not a random scratch name

## Terminal

Use \`terminal\` for command execution.

Use it for:
- \`rg\`, \`ls\`, \`cat\`, and other local inspection commands
- package manager commands such as \`pnpm\`, \`npm\`, \`node\`, \`python\`, \`python3\`
- tests, builds, linting, migrations, and script execution
- git inspection commands
- curl or HTTP debugging when the user wants real network verification

Rules:
- use read-only inspection commands first when the workspace state is unclear
- prefer deterministic commands with clear output
- if the exact command is likely to be reused, write a script file first and run that script instead of repeating long inline commands
- after running a command, verify success from exit status and output, not from intention
- if a command fails, summarize the real failure and choose the next step from evidence

## Search

Use \`search\` only when the task needs external docs, package references, API behavior, or current public information.

Rules:
- do not use search when the answer is already in the codebase or command output
- use search for docs, API contracts, version-specific behavior, and debugging external tools

# Coding Patterns

## Debugging

- inspect the relevant file or failure output first
- reproduce with the smallest useful command
- fix the smallest real cause
- rerun the relevant verification command

## Refactor

- inspect all touched files first
- make the code change
- run the narrowest validation command that proves the refactor did not break behavior

## Reusable Script Workflow

- if the task needs repeated data manipulation, repeated API checks, or a long multi-step shell command, create a reusable script in the workspace
- keep the script focused and name it for the job it performs
- run the script through \`terminal\`
- report where the script was written and how it was verified

## Curl And External Calls

- use \`curl\` through \`terminal\` when the user wants a real local request or API verification
- include only the headers and payload actually needed
- summarize the important status code and response facts

# Bad Routes To Avoid

- do not use terminal for blind destructive changes when workspace writes are more precise
- do not write files before understanding the target path
- do not claim tests passed if you did not run them
- do not treat a failed command as success just because the intended file exists
- do not create throwaway scripts when a simple verified command is enough

# Tool Guidance

- \`repo\`: inspect grounded files, code, and repository structure before deciding what to edit.
- \`workspace\`: write or update known file content, create reusable scripts, and make precise local mutations.
- \`terminal\`: run inspection commands, scripts, tests, builds, curl requests, and verification commands. Always ground claims in exit status and output.
- \`search\`: use only for external docs or current public references that are not already available locally.

# Delivery

- report what you inspected, what you changed, what you ran, and what actually succeeded
- if a script was created, mention its path and purpose
- if verification was partial, say exactly what was and was not checked
`,
  },
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
tools:
  required:
    - larkTask
    - larkCalendar
  optional:
    - larkMeeting
    - larkApproval
    - larkBase
  action:
    - larkDoc
inputs:
  - name: objective
    infer: true
  - name: date_scope
    infer: true
  - name: identifiers
    infer: false
  - name: target_people
    infer: false
  - name: calendar_name
    infer: false
  - name: approval_code
    infer: false
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
- scheduling a meeting when the user says "create a meeting", "book a meeting", or "schedule a meeting"

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
- if the user wants to create or schedule a meeting, route to \`larkCalendar\` because meetings are created as calendar events in this system

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
- if the user says "create a meeting", "schedule a meeting", or "book a meeting", do not route to \`larkMeeting\`; route to \`larkCalendar\`

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

# Tool Guidance

- \`larkTask\`: query tasks for the resolved date_scope and return titles, assignees, due times, and completion state.
- \`larkCalendar\`: query events for the resolved date_scope and return titles, times, status, and attendees when available.
- \`larkMeeting\`: inspect a known meeting or minute. Do not use this for generic day-based discovery when calendar can answer the question, and do not use it to schedule meetings.
- \`larkApproval\`: discover definitions or inspect approval instances only when the request is about approvals.
- \`larkBase\`: use only when the request is actually about Base records, tables, apps, or views.
- \`larkDoc\`: create or edit a doc only when the user explicitly asked for a document or artifact.

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
tools:
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
inputs:
  - name: objective
    infer: true
  - name: date_scope
    infer: true
  - name: stakeholders
    infer: false
  - name: delivery_style
    infer: false
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

- \`zoho\`: query active deals, leads, and key CRM context for the resolved date_scope. Return deal name, stage, value, and contact.
- \`outreach\`: query outreach activity or publisher matches for the resolved date_scope. Return campaign or recipient counts and useful names when available.
- \`larkTask\`: query tasks due on the resolved date_scope. Return titles, assignees, due times, and completion state.
- \`larkCalendar\`: query events scheduled on the resolved date_scope. Return titles, times, statuses, and attendees when available.
- \`larkMeeting\`: inspect meetings only when meeting-specific detail is actually needed. Do not use it as the first source for generic day-based scheduling questions.
- \`search\`: use only if the user asked for external research or current public context.
- \`larkDoc\`: create a document only if the user explicitly asked for one or an artifact is clearly required.

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
