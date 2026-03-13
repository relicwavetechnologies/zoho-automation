# Prompt Audit - 2026-03-13

This audit records the active prompt-bearing surfaces that shape production behavior after the Odin AI prompt upgrade.

## Contract Types

| Contract type | Purpose | Default output style |
| --- | --- | --- |
| `router` | Choose next agent, plan, or finish state | JSON only or concise control response |
| `specialist` | Do grounded domain work | Short answer plus minimal evidence |
| `action/status` | Create or update an artifact | One-line status result |
| `formatter/synthesis` | Turn grounded facts into final answer | Compact polished response |

## Prompt Inventory

| Surface | Runtime / call path | Role | Tools / downstream actions | Output shape | Verbosity budget | Common failure modes | Contract type |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `backend/src/company/integrations/mastra/agents/supervisor.agent.ts` | Mastra desktop + orchestrator | Odin top-level manager | planner, zoho, outreach, search, lark-doc | concise final answer | short operational answer | over-routing, fake completion, skipping planning | `router` |
| `backend/src/company/integrations/mastra/agents/planner.agent.ts` | Mastra planning path | Odin planner | none | strict JSON plan | JSON only | malformed JSON, over-detailed tasks | `router` |
| `backend/src/company/integrations/mastra/agents/search.agent.ts` | Mastra web research | Odin Search | `search-read` | short grounded answer | 2 short paragraphs or 3-5 bullets | generic results, snippet dumping | `specialist` |
| `backend/src/company/integrations/mastra/agents/zoho-specialist.agent.ts` | Mastra CRM path | Odin CRM | `read-zoho-records`, fallback `search-zoho-context` | concise CRM answer | 3-5 bullets or 2 short paragraphs | record dumping, fabricated metrics | `specialist` |
| `backend/src/company/integrations/mastra/agents/outreach-specialist.agent.ts` | Mastra outreach path | Odin Outreach | `read-outreach-publishers` | ranked publisher list or no-match guidance | top few results only | dataset dumping, vague filter advice | `specialist` |
| `backend/src/company/integrations/mastra/agents/lark-doc-specialist.agent.ts` | Mastra doc creation/edit path | Odin Docs | `create-lark-doc`, `edit-lark-doc` | one-line status result | one line | verbose post-tool chatter, pretending docs were saved | `action/status` |
| `backend/src/company/integrations/mastra/agents/ack.agent.ts` | Mastra progress placeholder | Odin acknowledgement | none | plain text | under 12 words | over-explaining, claiming work finished | `action/status` |
| `backend/src/company/integrations/mastra/agents/synthesis.agent.ts` | Mastra post-processing | Odin Synthesis | none | concise polished answer | short summary plus bullets | decorative verbosity, speculative synthesis | `formatter/synthesis` |
| `backend/src/company/orchestration/langgraph/supervisor-contract.ts` `buildTier1Prompt` | LangGraph fast path | Odin fast triage | tier-1 LLM | JSON only | tiny JSON | fast-pathing tasks that need work | `router` |
| `backend/src/company/orchestration/langgraph/supervisor-contract.ts` `buildSupervisorPrompt` | LangGraph supervisor loop | Odin LangGraph supervisor | listed manifest agents | JSON decision | JSON only | unknown agent keys, premature finish | `router` |
| `backend/src/company/orchestration/langgraph/route-contract.ts` `buildRoutePrompt` | LangGraph route classify | Odin route classifier | router LLM | JSON only | JSON only | invalid enums, prose instead of JSON | `router` |
| `backend/src/company/orchestration/langgraph/plan-contract.ts` `buildPlanPrompt` | LangGraph planning contract | Odin plan contract | planner LLM | JSON only | JSON only | invalid step names, missing start/end | `router` |
| `backend/src/company/orchestration/langgraph/synthesis-contract.ts` `buildSynthesisPrompt` | LangGraph final synthesis | Odin final synthesis | synthesis LLM | JSON only | short text | non-JSON output, overlong prose | `formatter/synthesis` |
| `backend/src/company/agents/implementations/search-read.agent.ts` | Legacy/internal search tool path | deterministic web result formatter | search service | short text summary | compact result list | excessive snippets | `specialist` |
| `backend/src/company/agents/implementations/outreach-read.agent.ts` | Legacy/internal outreach tool path | deterministic outreach formatter | outreach client | ranked short list | top 5 lines | too many records | `specialist` |
| `backend/src/company/agents/implementations/zoho-read.agent.ts` synthesis prompt | Legacy/internal Zoho synthesis | Odin CRM synthesis | Mastra synthesis | concise grounded answer | short answer | verbose synthesis, hidden-reference language | `formatter/synthesis` |
| `backend/src/company/agents/implementations/lark-doc.agent.ts` | Legacy/internal Lark doc action | deterministic doc status | Lark Docs service | one-line status | one line | verbose success/failure text | `action/status` |
| `backend/src/company/agents/implementations/response.agent.ts` | Legacy/internal general fallback | Odin capability/greeting reply | none | plain text | one sentence | generic assistant tone | `action/status` |

## Failure Taxonomy

- Premature completion: prompt says the work is done before the tool actually ran.
- Verbosity waste: specialist or status agent emits unnecessary narration.
- Wrong tool order: document/export tool called before retrieval or analysis.
- Weak routing: router chooses a generic path when a domain specialist is obvious.
- Schema drift: JSON contract returns prose, wrong enum, or invalid shape.
- Grounding drift: answer mixes in unsupported facts, stale memory, or implied UI state.
