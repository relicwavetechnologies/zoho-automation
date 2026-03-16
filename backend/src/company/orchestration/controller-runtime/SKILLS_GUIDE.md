# SKILL.md Guide

A `SKILL.md` is workflow configuration for the orchestration system.

It is not general documentation. The controller loads it to gain workflow knowledge, then uses that knowledge to decide whether more skills are needed, which work items to plan, and how to generate better worker parameters.

## What Makes A Skill Useful

A skill is useful when it changes real behavior:

- it helps the controller choose the right workers
- it helps the planner build the right todo list
- it improves worker parameter generation
- it reduces unnecessary user questions
- it prevents wrong side effects

If removing a line would not change runtime behavior or model output, that line should not be there.

## Recommended Structure

Use this frontmatter shape:

```yaml
---
name: skill-name
description: one sentence explaining what the skill is for
when_to_use:
  - clear trigger phrase
  - another clear trigger phrase
tools:
  required:
    - workerKey
  optional:
    - workerKey
  action:
    - workerKey
inputs:
  - name: objective
    infer: true
  - name: date_scope
    infer: true
  - name: stakeholder
    infer: false
success_criteria:
  - concrete outcome
blocking_rules:
  - one real blocker rule
---
```

Then add short sections like:

- `# Purpose`
- `# Operating Rules`
- `# Tool Guidance`
- `# Delivery`

## Tool Categories

`required`

- only tools that genuinely need to run every time for this workflow
- if you cannot name at least 2 tools that should always run, the request probably does not need a skill

`optional`

- tools that sometimes add value but should not always run
- use this for things like external search or secondary surfaces

`action`

- write, create, or mutate tools
- these should run only when the user explicitly asked for the side effect

## Inputs

Use `infer: true` whenever the controller can reasonably infer the value from the request.

Examples:

- `objective`
- `date_scope`
- `time_range`
- `focus_area`

Use `infer: false` only when the system really cannot proceed usefully without asking.

Examples:

- a missing raw identifier that the API truly requires
- a missing approval template choice after discovery failed

Do not mark everything as non-inferable. That makes the workflow feel broken.

## Guidance Lines

Guidance should be specific enough to improve parameter generation.

Bad:

- `Use larkTask for tasks`

Good:

- `Query larkTask for tasks due on date_scope. Return titles, assignees, due times, and completion state.`

Good guidance tells the controller:

- what the tool should do in this workflow
- which parameters matter
- what shape of result is useful
- what to avoid

## What Makes A Skill Useless

- every tool is marked `required`, including write tools
- guidance is vague or missing
- inputs that can be inferred are marked as required asks
- the skill only wraps one worker call
- `when_to_use` is too vague to match reliably

## Architecture Note

In this system:

- loading a skill gives the controller knowledge
- loading a skill does not automatically create todos
- the supervisor may read more than one skill before planning
- todo planning is a separate decision after the controller has enough context

So a good skill should guide planning, not hard-force execution.

## Example Heuristic

When authoring a new skill:

1. name the 2-5 workers that are genuinely central
2. separate read/query tools from write/action tools
3. mark inferable inputs correctly
4. add short, directive guidance for each important tool
5. delete any line that would not change planning or parameter generation
