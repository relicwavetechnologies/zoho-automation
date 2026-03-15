# Orchestration Learnings

Date: 2026-03-14
Updated: 2026-03-15

## Scope

This document captures research and codebase analysis on how to make the current orchestration system much stronger, especially for "do the work until it is done" behavior across Zoho, Lark, search, and desktop/local actions.

The analysis is based on:

- Current repo code and prompt contracts
- Official product docs for frontier coding agents
- A small set of strong open-source agent repos/frameworks

## Executive Summary

The current system already has useful building blocks:

- strong domain tools for Zoho/Lark/search
- a Mastra workflow path
- a LangGraph orchestration path
- checkpointing, HITL, tool RBAC, activity streaming, and desktop local-action support

But it is not yet architected like a true high-agency agent.

The main issue is not just model quality. It is that the runtime is split across multiple partial orchestration styles:

- Mastra workflow: fixed `planner -> execution -> verifier -> result`
- LangGraph runtime: closer to a loop, but still mostly "pick one next agent or finish"
- Desktop local-action loop: can request terminal/filesystem actions, but is separate from the main shared workflow

This creates a gap between what the system appears to support and what it can actually do in one unified loop.

The single strongest hypothesis behind vague or weak responses is correct:

> Tool results are not consistently fed back into durable reasoning state in a rich enough form.

In several places, the system keeps only thin summaries, activity events, or final text instead of maintaining a structured world state that the next decision step can reason over.

## What The System Does Today

### 1. Mastra workflow is fixed, not "do until done"

The main Mastra workflow is a fixed sequence:

- planner step
- execution step
- outcome verifier
- final result step

Code:

- `backend/src/company/integrations/mastra/workflows/company.workflow.ts`

Important implication:

- this is not an explicit observe-plan-act-repeat loop
- there is no architecture-level replan node after each tool result
- there is no architecture-level "ask user for clarification" node
- there is no architecture-level "recover from failure and continue" loop beyond what an individual agent may do internally

### 2. Execution relies on one streaming agent run

The workflow execution step constructs a plan context and then runs one agent stream:

- `backend/src/company/integrations/mastra/steps/execution.step.ts`

Important implication:

- the runtime is not iterating plan tasks as first-class state transitions
- it is hoping the chosen agent will follow the plan correctly inside one run
- completed tasks are inferred from activity events, not from a stronger state machine

### 3. Completed-task tracking is inferred from activity summaries

The execution step listens to `activity_done` events and tries to map them back to plan tasks by task id or tool-owner heuristics:

- `backend/src/company/integrations/mastra/steps/execution.step.ts`

This is useful for UI progress, but brittle for core orchestration correctness.

Why it is brittle:

- task completion is inferred from emitted summaries
- matching can fall back to owner-agent name only
- there is no stronger "task completed because state condition X became true" contract

### 4. Write verification exists, but only for a subset of owners

The outcome verifier directly verifies:

- `larkDoc`
- `zoho`

It does not directly verify:

- `outreach`
- `larkBase`
- `larkTask`
- `larkCalendar`
- `larkMeeting`
- `larkApproval`
- `workspace`
- `terminal`

Code:

- `backend/src/company/integrations/mastra/steps/outcome-verifier.step.ts`

Important implication:

- many successful-looking tasks are effectively unverifiable in the current runtime
- this weakens trust and makes "done" semantics fuzzy

### 5. Desktop local actions are not part of the shared Mastra workflow

Desktop local workspace access is exposed through a separate action protocol:

- `list_files`
- `read_file`
- `write_file`
- `mkdir`
- `delete_path`
- `run_command`

Code:

- `backend/src/modules/desktop-chat/desktop-chat.controller.ts`

Important implication:

- desktop `send` uses `companyWorkflow`
- desktop `act` uses a separate local-action prompt loop
- local terminal/filesystem capability is not a first-class shared orchestration tool in the main workflow

This is likely a major reason for failures like:

- "I gave it env and terminal/web access, but it still could not fetch my Lark task"

The capability exists, but it exists in a different control path than the shared orchestration workflow.

### 6. Planner vocabulary is ahead of runtime reality

The planner and capability manifest allow:

- `workspace`
- `terminal`

as plan owner types.

Code:

- `backend/src/company/integrations/mastra/agents/planner.agent.ts`
- `backend/src/company/integrations/mastra/agents/capability-manifest.ts`
- `backend/src/modules/desktop-chat/desktop-plan.ts`

But in the current Mastra workflow:

- there is no shared Mastra `workspaceAgent`
- there is no shared Mastra `terminalAgent`
- outcome verification for `workspace` and `terminal` explicitly says no adapter exists

This creates a capability gap between planning language and executable runtime.

### 7. LangGraph is closer to a real orchestration loop, but still limited

LangGraph has:

- route classification
- supervisor decisions
- HITL gate
- agent dispatch
- bounded retry
- synthesis

Code:

- `backend/src/company/orchestration/engine/langgraph-orchestration.engine.ts`
- `backend/src/company/orchestration/langgraph/supervisor-contract.ts`
- `backend/src/company/orchestration/langgraph/agent-bridge.ts`

This is directionally stronger than the fixed Mastra workflow.

But the current supervisor decision contract only supports:

- choose next agent
- finish

It does not support a first-class:

- ask user
- ask for missing credential
- ask for missing identifier
- request tool capability upgrade
- defer and resume later

That matters if you want the system to behave like Cursor / Claude Code / Codex and ask focused questions only when necessary.

## Likely Causes Of Vague Responses

### 1. Tool results are not consistently fed back as rich state

This is very likely.

What the code shows:

- LangGraph passes prior outputs into later invocations, which is good:
  - `backend/src/company/orchestration/langgraph/agent-bridge.ts`
- But it also creates compact summaries like `success (fields: ...)`, which can discard important semantics.
- Mastra execution tracks task completion mostly from activity events and `resultSummary` text:
  - `backend/src/company/integrations/mastra/steps/execution.step.ts`

This means the system often knows:

- that a tool ran
- a short label
- a short summary string

but not necessarily:

- what exact entities were fetched
- which facts were established
- which unresolved questions remain
- what arguments failed
- what evidence should be cited in the final answer

### 2. Some tools preserve structure, others collapse to text

Example:

- `search-agent` makes an effort to extract structured sources and citations:
  - `backend/src/company/integrations/mastra/tools/search-agent.tool.ts`
- `lark-task-agent` often returns only `answer: result.text` and emits only text summaries:
  - `backend/src/company/integrations/mastra/tools/lark-task-agent.tool.ts`

This inconsistency makes final synthesis uneven.

### 3. The system lacks a durable "world state"

Frontier agents usually keep some explicit representation of:

- current objective
- open subgoals
- facts learned so far
- artifacts created
- blockers
- next best action

Your current system has:

- plan text
- some activity events
- some tool results
- some memory

But it does not yet have a strong normalized execution state that is updated after every tool call.

### 4. The runtime split causes capability confusion

The desktop local-action loop knows about terminal/filesystem execution, but the shared orchestration workflow does not.

So the model can be "right in principle" and still fail because:

- it is operating inside the wrong runtime path
- the prompt surface does not expose the capability in that path
- the planner can mention a capability that the shared runtime cannot execute directly

### 5. There is no first-class clarification state

Current strong agents behave well partly because they can stop and ask:

- "Which workspace should I use?"
- "Do you want me to use the production env or staging env?"
- "I found two matching Lark tasks. Which one should I update?"

Your current architecture has HITL for write approval, but not a general clarification state.

## Frontier Agent Patterns Worth Copying

### Common pattern across Cursor, Claude Code, and Codex

The best current coding agents tend to share these ideas:

1. One strong model is allowed to run a tool loop.
2. Tool results come back into the next reasoning step immediately.
3. The system has strong permission / approval controls.
4. The system can ask focused clarifying questions when blocked.
5. The system maintains some persistent memory/rules/context.
6. The system tracks progress explicitly with plans or todos.
7. The system can continue after failures instead of stopping at first error.

### Cursor

Relevant signals from official docs:

- foreground agent can run commands
- background agent exists
- there are rules and memories
- approval modes and tool governance are core product concepts

Why it matters here:

- Cursor-style strength is not only "better model"
- it is the combination of tools, loop, permissions, and persistent guidance

### Claude Code

Relevant official concepts:

- permissions
- hooks
- memory
- subagents

Why it matters here:

- hooks let you normalize or guard tool execution
- memory reduces repeated failures and repeated explanations
- subagents allow specialization without losing a unified top-level harness

### OpenAI Codex

Relevant official concepts:

- coding agent runs with terminal and file access
- MCP/server tools
- todo tracking
- approval modes
- sandboxed execution

Why it matters here:

- Codex-style behavior is exactly the direction of "work until done, ask only when needed, keep going through tools"

## Comparison To Current Architecture

### Where current architecture is already strong

- domain-specific tool coverage for Zoho/Lark/search is real
- RBAC is already present
- checkpointing and HITL already exist
- desktop event streaming and plan UI already exist
- LangGraph path already gives a better base for a stronger loop than starting from zero

### Where current architecture is materially weaker than frontier agents

1. No unified top-level loop across all capabilities.
2. No consistent structured tool-result feedback into state.
3. No first-class clarification / question-asking state.
4. Local actions are split from the main workflow.
5. Planner can name capabilities that workflow cannot execute directly.
6. Completion is inferred from summaries more than verified state transitions.
7. Verification coverage is incomplete for many important actions.

## The Most Important Architectural Recommendation

Do not try to "prompt engineer" your way out of this.

The highest-leverage change is:

> Unify orchestration around one explicit observe-decide-act-review loop with structured state updates after every tool call.

That can still use:

- your existing Mastra specialists
- your existing LangGraph runtime
- your existing RBAC / checkpoint / HITL systems

But the top-level harness should become more like:

1. Read current state.
2. Decide next action from a small action vocabulary.
3. Execute exactly one action.
4. Normalize tool result into structured state.
5. Check stop conditions.
6. Repeat.

Suggested top-level decision vocabulary:

- `RUN_TOOL`
- `ASK_USER`
- `REQUEST_APPROVAL`
- `REPLAN`
- `DONE`
- `FAIL`

## Recommended Runtime State Model

After each step, persist structured fields such as:

- `goal`
- `user_request`
- `plan`
- `open_tasks`
- `completed_tasks`
- `facts`
- `artifacts`
- `pending_questions`
- `tool_history`
- `last_observation`
- `blockers`
- `needs_user_input`
- `needs_approval`
- `done_reason`

This is much stronger than relying mostly on:

- free-text summaries
- activity labels
- inferred owner-agent completions

## Tool Contract Changes To Make

Every tool should return a normalized structure, for example:

```json
{
  "ok": true,
  "action_type": "lark_task_read",
  "entities": [
    { "type": "lark_task", "id": "task-guid", "title": "Prepare CRM handoff" }
  ],
  "facts": [
    "Found 3 matching open tasks",
    "Latest matching task is assigned to Anish"
  ],
  "artifacts": [],
  "citations": [],
  "next_hints": [
    "If user wants update, use task-guid ..."
  ],
  "raw_summary": "Found 3 Lark tasks..."
}
```

Then:

- the orchestrator stores this in runtime state
- the next reasoning step sees the normalized result
- final synthesis uses normalized state, not just loose text

## Specific Fixes For The "Lark Task With Env" Failure Mode

### Root causes likely include

1. The runtime path did not actually expose terminal execution in the active orchestration path.
2. The system did not have a runbook for how to use env plus terminal to fetch Lark data.
3. The model had no explicit state saying "tool failed because auth/env/identifier was missing".
4. The system lacked a focused clarification branch.

### Concrete improvements

1. Make terminal/filesystem first-class orchestration tools, not only desktop action-loop capabilities.
2. Inject operational runbooks into context for common tasks:
   - where env lives
   - safe scripts to use
   - preferred validation commands
   - expected success output
3. Add a `MISSING_INPUT` / `ASK_USER` decision branch.
4. Preserve stderr/stdout and structured command result state, not just one-line summaries.
5. Allow bounded retry after command failure with explicit failure analysis.

## Prompt-Level Breakpoints

### 1. Supervisor prompt is stricter than the runtime needs

The Mastra supervisor says:

- call at most one tool per turn

That helps reduce chaos, but it also suppresses momentum.

For a high-agency system, the orchestrator should be allowed to keep stepping as long as:

- the next step is safe
- the tool result is grounded
- stop conditions are not yet met

### 2. Planner language implies capabilities that are not shared runtime capabilities

The planner can emit `workspace` and `terminal`, but the main workflow does not natively execute those as first-class shared orchestration tools.

This should be fixed either by:

- exposing them as real tools, or
- removing them from the planner in paths where they are not executable

### 3. Supervisor finish contract is too binary

The LangGraph supervisor effectively supports:

- next agent
- finish

It should also support:

- ask user
- request credential
- request environment selection
- request approval
- cannot proceed because tool/runtime missing

## Recommended Roadmap

### P0: Fix the architecture mismatch

1. Choose one top-level orchestrator path for long-running tasks.
2. Use LangGraph as the main explicit loop for orchestration.
3. Keep Mastra specialists as callable specialists/tools inside that loop.
4. Expose desktop local actions as first-class tools if you want terminal/filesystem behavior in the same agent family.

Why LangGraph is the best fit:

- you already have it
- it already has checkpointing concepts
- it already has retry/HITL structure
- it is much closer to the state-machine shape needed for "until done"

### P1: Normalize tool outputs

1. Define a shared tool result schema.
2. Update all specialist tools to emit normalized structured results.
3. Persist normalized results into orchestration state.
4. Make synthesis read from normalized state, not only final text summaries.

### P1: Add a real clarification branch

Introduce a state/node for:

- missing identifier
- multiple matching records
- missing credential or env selection
- insufficient permissions

This branch should send a short question and pause execution cleanly.

### P1: Add failure-aware retries

For terminal and web tasks:

- store full command result
- classify failure
- retry when the fix is obvious
- ask user only when the missing piece is external

### P2: Strengthen verification

Add direct verification adapters for:

- `larkTask`
- `larkBase`
- `larkCalendar`
- `larkApproval`
- `workspace`
- `terminal`

For terminal/workspace:

- verification can be file existence
- diff presence
- command exit status
- JSON schema validation of output

### P2: Add operational memory and runbooks

Persist "how this repo works" knowledge, such as:

- safe commands
- location of env
- known validation scripts
- how to query Lark task data
- how Zoho auth works in this codebase

This is one of the easiest ways to reduce repeated failures.

## GitHub Repos / Frameworks Worth Studying

### 1. LangGraph

Best fit for this repo.

Why:

- you already use it
- state-machine model fits your needs
- checkpoints, interrupts, and orchestration semantics are aligned with what you want

Use it as the primary orchestration harness, not just as an alternate engine.

### 2. OpenHands

Best as a reference architecture, not a drop-in dependency.

Why:

- strong agent-computer interaction patterns
- good reference for long-running autonomous behavior

Caution:

- heavier than what you need
- more coding/computer-use oriented than Zoho/Lark orchestration

### 3. Aider

Best as a source of tactical ideas, not as your core orchestrator.

Why:

- strong edit/command loop
- practical repo-aware behavior
- good lessons on narrow, high-signal tool use

### 4. SWE-agent / Open SWE

Useful for:

- evaluation
- long-running agent task lifecycle
- issue/task oriented agent workflows

But not a direct fit for a Zoho/Lark-first general-purpose assistant.

## Recommended Strategic Direction

If the goal is:

> "A general-purpose assistant for Zoho, Lark, MCP, search, and local actions that is as persistent and reliable as Cursor-like agents"

then the right direction is:

- keep your domain specialists
- keep RBAC/HITL/checkpoints
- move to one explicit LangGraph-style loop as the top-level controller
- normalize tool outputs
- unify desktop/local actions into the same orchestration vocabulary
- add first-class clarification states

That is much more important than swapping models again.

## Best Immediate Next Steps

1. Decide whether LangGraph becomes the single top-level orchestrator.
2. Define a shared normalized tool result schema.
3. Add `ASK_USER` as a first-class supervisor outcome.
4. Make terminal/filesystem actions first-class shared tools or remove them from non-executable planner paths.
5. Add repo-specific operational memory for env/scripts/Lark/Zoho runbooks.
6. Build evals for:
   - fetch a Lark task from env
   - resolve ambiguous Lark task references
   - use search/doc tools before claiming synthesis complete
   - recover from failed terminal command and continue

## Sources

Official / primary sources:

- Cursor docs: https://docs.cursor.com/
- Claude Code docs: https://docs.claude.com/en/docs/claude-code/overview
- OpenAI Codex docs / launch materials: https://openai.com/codex/
- OpenAI developers docs: https://platform.openai.com/docs/codex
- LangGraph docs: https://langchain-ai.github.io/langgraph/
- Mastra docs: https://mastra.ai/docs

Open-source repos:

- LangGraph: https://github.com/langchain-ai/langgraph
- OpenHands: https://github.com/All-Hands-AI/OpenHands
- Aider: https://github.com/Aider-AI/aider
- SWE-agent: https://github.com/princeton-nlp/SWE-agent
- Open SWE: https://github.com/langchain-ai/open-swe

Note on Antigravity:

- I did not find a strong enough official/public technical source set to use it as a primary reference in these recommendations, so it is intentionally not weighted heavily here.

## Addendum: 2026-03-15 Research Update

### Core correction

The target architecture should not be:

- one raw single-agent prompt
- or many semi-autonomous agents all deciding for themselves

It should be:

- one controller model
- one controller runtime loop
- many subordinate workers/specialists

In other words:

> single runtime brain, multi-agent workforce

This is the most important correction to the earlier framing.

### What was still wrong in the first revamp

The first desktop LangGraph revamp improved routing and toggleability, but it did not fully solve the core issue because it still behaved too much like a patched capability tree.

The deeper problem is:

- the system still classifies too early into narrow task shapes
- it still binds itself to one strategy too soon
- it still lacks generic progress detection
- it still lacks generic strategy switching
- it still lacks generic artifact verification before completion

That means even a cleaner `repo fetch` path can still be "a patch" if it only solves one prompt family.

### The right intelligence layer

The system becomes generally smarter when the controller can reason in universal action types like:

- `discover_candidates`
- `inspect_candidate`
- `retrieve_artifact`
- `modify_workspace`
- `execute_command`
- `verify_artifact`
- `ask_for_clarification`

These are better than prompt-specific handlers like:

- README fetch flow
- prompt.ts flow
- open-source IDE flow

The controller should operate on progress and artifacts, not on bespoke prompt families.

### New architectural rule

Workers must not decide orchestration.

Workers may:

- execute assigned subwork
- return structured observations
- report blockers
- suggest retry hints

Workers may not:

- decide completion
- ask the user directly as a top-level behavior
- create top-level plans
- choose the next worker

Only the controller may:

- route
- plan
- dispatch
- retry
- switch strategy
- ask user
- request approval
- verify
- declare done

### Why the repo/prompt.ts failure matters

The failure case:

- "search some open source coding ides and get their prompt.ts file fetch and store it in this workspace"

showed that the controller still lacked generic decomposition. It treated the whole English request like a single repo lookup instead of:

1. discover candidate IDE repos
2. inspect them for matching files
3. choose a valid candidate
4. fetch the file
5. store it
6. verify the saved artifact

That is not mainly a model weakness. It is a missing controller capability:

- no discovery stage
- no cross-candidate evaluation
- no no-progress guard
- no forced strategy switch after repeated identical failure

### Strong external references that support this direction

Anthropic's current agent guidance strongly supports using the simplest agent architecture that works, and only adding multi-agent complexity when truly necessary:

- https://www.anthropic.com/research/building-effective-agents

Anthropic's agent SDK writeup also reinforces the strong loop pattern:

- gather context
- take action
- verify
- repeat

Source:

- https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk/

Anthropic's multi-agent research post is also useful because it makes clear that multi-agent systems are helpful for some workloads, but come with coordination and reliability costs:

- https://www.anthropic.com/engineering/built-multi-agent-research-system

This supports the design conclusion:

- keep specialists
- centralize orchestration authority

### Open-source reference takeaways

Aider is valuable as a reference for:

- one strong operator
- repo-aware actions
- high-signal tool use

Source:

- https://github.com/Aider-AI/aider

OpenHands is valuable as a reference for:

- persistent agent/computer interaction
- explicit tool/computer surfaces
- long-running execution behavior

Source:

- https://github.com/All-Hands-AI/OpenHands-aci

### Updated final recommendation

The best direction for this codebase is now clearer:

1. Keep the specialist ecosystem.
2. Make one controller model the only orchestrator.
3. Make all workers subordinate executors.
4. Move from prompt-family patches to universal action types.
5. Track progress explicitly.
6. Switch strategy when no progress is made.
7. Verify artifacts before saying done.

### Practical litmus test

If a proposed change mainly answers:

- "How do we support this exact prompt?"

then it is probably still a patch.

If a proposed change answers:

- "How does the controller generally discover, retrieve, modify, verify, and recover?"

then it is probably moving the system in the right direction.
