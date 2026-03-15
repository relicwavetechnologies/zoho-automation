import type { SkillDocument, SkillMetadata } from './types';

const HARD_CODED_SKILLS: SkillDocument[] = [
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
