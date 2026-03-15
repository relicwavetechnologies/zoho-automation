# Skill-First Agent Direction

## Goal

Build one controller-led agent runtime that stays general-purpose.

The controller should:

- know it is the single controller
- know which tools and workers exist
- solve simple requests directly when possible
- check the skills registry for complex or protocol-heavy work
- inspect skill metadata before loading full `SKILL.md`
- fetch full `SKILL.md` only when it looks relevant
- use skills as workflow guidance, not as a substitute for tool reality
- ask focused questions only when missing inputs actually block progress
- reconsider the next step after every tool or worker result
- continue until done or genuinely blocked

## Core Principles

### 1. No hardcoded domain routing

Do not encode rules like:

- if Lark then do X
- if Zoho then do Y
- if repo task then do Z

The controller model should reason over:

- the user request
- available worker metadata
- available skill metadata
- current structured observations
- current blocking state

Code may provide generic runtime rails, but not domain-specific routes.

### 2. Skills guide process, not capability

Tools and workers define what the system can do.

Skills define:

- when a workflow is relevant
- what kind of process should be followed
- what inputs are usually required
- how to deliver work
- what quality bar to use
- when to escalate or ask questions

Skills should not be treated as raw prompt dumps for every turn.

### 3. Structured observations are durable state

Tool and worker results must not disappear into final prose.

They should be persisted as structured observations containing:

- worker key
- action kind
- summary
- facts
- entities
- artifacts
- citations
- blocking reason

Those observations should be available to future controller turns in compact form.

### 4. Tight context boundaries

The controller should prefer:

- current thread history
- structured observations from the same thread
- conversation-specific refs

Avoid injecting broad cross-thread memory into the controller by default, because that can leak irrelevant context and mislead the next step.

## Runtime Loop

1. User request arrives.
2. Controller bootstraps an internal profile:
   - ambient / simple / structured
   - whether skills should be consulted
   - likely deliverables
   - blocking missing inputs
3. If structured and skill-relevant:
   - inspect skill metadata
   - load the most relevant full `SKILL.md`
4. Choose exactly one next action:
   - answer directly
   - call one worker
   - request one local action
   - ask one focused question
   - complete
   - fail precisely
5. Feed the result back into structured observation memory.
6. Reconsider the next step.
7. Stop only when done or genuinely blocked.

## What Counts As Misleading

These are anti-goals:

- hardcoded objective routing that pre-decides the worker
- flattening worker results into vague assistant prose
- losing tool evidence across turns
- loading every skill blindly
- using search when first-party tools are more appropriate
- claiming a side effect happened without tool evidence

## Current Branch Direction

This branch should move toward:

- a skill-first controller prompt
- a `skills` worker for metadata lookup and full skill fetch
- durable structured observation persistence
- no personal-memory injection into controller prompts by default
- simpler generic runtime guards instead of domain-specific fallback logic

## Implementation Guidance

When changing the runtime:

- prefer generic controller behavior over domain branches
- keep workers honest about what they actually returned
- keep skill metadata small and cheap to inspect
- only load full skill content when relevant
- keep UI events tied to real controller stages

## Audit Checklist

When auditing the branch later, check:

- Is the controller still the only decision-maker?
- Are skills discovered by the controller, not routed by code?
- Are tool and worker results persisted structurally?
- Is current-thread context prioritized over broad memory?
- Can the controller recover after a failed worker without looping blindly?
- Are local actions resumed as the same execution, not a second system?
