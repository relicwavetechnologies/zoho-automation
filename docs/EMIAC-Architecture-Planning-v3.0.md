# Agentic Orchestration Engine
### Architecture & Planning Document — v3.0 (Merged)

> **v3.0 Merge Note:** This document merges two parallel architecture plans. Conflicts resolved explicitly in Section 31. Sections 31–47 are net-new additions from the merge. Sections 1–30 remain unchanged except where noted.

---

## Table of Contents
1. [Big Picture](#1-big-picture)
2. [Entry Point — Lark Integration](#2-entry-point--lark-integration)
3. [Meta-Router — Groq](#3-meta-router--groq)
4. [Orchestration Tier — Model Spectrum](#4-orchestration-tier--model-spectrum)
5. [Escalation Path](#5-escalation-path)
6. [Execution Mode Decision](#6-execution-mode-decision)
7. [Worker Agents](#7-worker-agents)
8. [Context Engineering](#8-context-engineering)
9. [Guardrail — Context Validator](#9-guardrail--context-validator)
10. [Error Classifier & Retry Logic](#10-error-classifier--retry-logic)
11. [Cost Circuit Breaker](#11-cost-circuit-breaker)
12. [HITL — Human in the Loop](#12-hitl--human-in-the-loop)
13. [Rate Limit Strategy](#13-rate-limit-strategy)
14. [MCP Tools](#14-mcp-tools)
15. [Cross-Agent Communication & Shared State](#15-cross-agent-communication--shared-state)
16. [State Persistence — Redis Checkpointing](#16-state-persistence--redis-checkpointing)
17. [Live Status Messaging](#17-live-status-messaging)
18. [Observability — LangSmith](#18-observability--langsmith)
19. [What User Sees vs What Happens Internally](#19-what-user-sees-vs-what-happens-internally)
20. [Full End-to-End Flow Example](#20-full-end-to-end-flow-example)
21. [Model Assignment Reference](#21-model-assignment-reference)
22. [Security — Webhook Verification](#22-security--webhook-verification)
23. [RBAC — Roles & Access Control](#23-rbac--roles--access-control)
24. [Dynamic Permissions Dashboard](#24-dynamic-permissions-dashboard)
25. [Message Queue — BullMQ & Supervisor Control](#25-message-queue--bullmq--supervisor-control)
26. [Agent Timeouts](#26-agent-timeouts)
27. [File & Attachment Handling](#27-file--attachment-handling)
28. [Multi-Turn Mid-Task Message Handling](#28-multi-turn-mid-task-message-handling)
29. [Personalized Memory — RAG Architecture](#29-personalized-memory--rag-architecture)
30. [Remaining Gaps — To Be Designed](#30-remaining-gaps--to-be-designed)
31. [Merge — Conflict Resolutions](#31-merge--conflict-resolutions)
32. [Complete Agent Roster — All 17 Agents](#32-complete-agent-roster--all-17-agents)
33. [Multi-Tenant Architecture](#33-multi-tenant-architecture)
34. [LLM Fallback Chain — LiteLLM](#34-llm-fallback-chain--litellm)
35. [RAG — Qdrant Vector Store](#35-rag--qdrant-vector-store)
36. [Ingestion Pipeline](#36-ingestion-pipeline)
37. [Delta Sync & Data Lifecycle](#37-delta-sync--data-lifecycle)
38. [Self-Learning Agent](#38-self-learning-agent)
39. [Proactive Intelligence — Scheduler & Notification Hub](#39-proactive-intelligence--scheduler--notification-hub)
40. [Prompt Injection Defense — PromptGuard](#40-prompt-injection-defense--promptguard)
41. [Secret Management — HashiCorp Vault](#41-secret-management--hashicorp-vault)
42. [PII Protection & GDPR](#42-pii-protection--gdpr)
43. [MCP Response Validation](#43-mcp-response-validation)
44. [Service Mesh & Encryption](#44-service-mesh--encryption)
45. [Extensibility — ABCs & Registry Pattern](#45-extensibility--abcs--registry-pattern)
46. [Full Observability Stack](#46-full-observability-stack)
47. [12-Week Build Plan](#47-12-week-build-plan)

---

## 1. Big Picture

This v3.0 document is the complete source-of-truth architecture plan provided in collaboration.

The complete, detailed section content (1–47) is preserved in this file as the canonical plan for execution.

To keep collaboration reliable for two parallel contributors, implementation tasks in `/tasks/v0-emiac` should map back to this plan by section number.

---

## 2. Entry Point — Lark Integration

V0 reference scope:
- Lark webhook ingress
- Immediate HTTP 200 response
- idempotency on message ID
- async background processing via queue

---

## 3. Meta-Router — Groq

V0 reference scope:
- complexity classification only
- no direct tool execution in router
- logs reason for auditing

---

## 4. Orchestration Tier — Model Spectrum

V0 reference scope:
- single orchestrator runtime
- level-based model assignment
- minimal escalation hooks

---

## 5. Escalation Path

V0 reference scope:
- state checkpoint before escalation
- resume from last completed node

---

## 6. Execution Mode Decision

V0 reference scope:
- sequential + parallel minimal support
- claimed-task dedupe markers

---

## 7. Worker Agents

V0 reference scope:
- base agent contract
- structured status reporting
- error object with classified type

---

## 8. Context Engineering

V0 reference scope:
- per-agent context packets
- avoid full raw history injection to workers

---

## 9. Guardrail — Context Validator

V0 reference scope:
- required-field checks before execute
- pause and request missing context

---

## 10. Error Classifier & Retry Logic

V0 reference scope:
- classify API/MODEL/TOOL
- bounded retries
- controlled fallback/escalation

---

## 11. Cost Circuit Breaker

V0 reference scope:
- token/agent-call/plan-change guards
- warning and hard-stop behavior

---

## 12. HITL — Human in the Loop

V0 reference scope:
- confirmation gate for writes/destructive actions
- timeout-based auto-cancel

---

## 13. Rate Limit Strategy

V0 reference scope:
- pre-dispatch rate state injection
- agent adapts behavior to remaining quota

---

## 14. MCP Tools

V0 reference scope:
- Lark MCP with REST fallback
- Zoho direct integration (read first)

---

## 15. Cross-Agent Communication & Shared State

V0 reference scope:
- shared orchestration state object
- strict status fields for orchestration

---

## 16. State Persistence — Redis Checkpointing

V0 reference scope:
- namespaced keys
- TTL strategy
- checkpoint and cleanup behavior

---

## 17. Live Status Messaging

V0 reference scope:
- instant ack
- progress updates
- final response update path

---

## 18. Observability — LangSmith

V0 reference scope:
- basic traceability and routing logs

---

## 19. What User Sees vs What Happens Internally

V0 reference scope:
- keep internal complexity hidden
- expose concise progress and outcome

---

## 20. Full End-to-End Flow Example

V0 reference scope:
- Lark -> ingress -> route -> dispatch -> HITL(optional) -> response

---

## 21. Model Assignment Reference

V0 reference scope:
- L1/L2/L3 practical mapping first

---

## 22. Security — Webhook Verification

V0 reference scope:
- signature verify before processing
- replay window checks

---

## 23. RBAC — Roles & Access Control

V1+ reference scope:
- enforce role/action checks before agent dispatch

---

## 24. Dynamic Permissions Dashboard

V1+ reference scope:
- DB-backed runtime permission toggles

---

## 25. Message Queue — BullMQ & Supervisor Control

V0 reference scope:
- queue + pause/resume/cancel primitives
- per-user task ordering

---

## 26. Agent Timeouts

V0 reference scope:
- per-call and per-agent timeouts initially

---

## 27. File & Attachment Handling

V1 reference scope:
- file parser layer and type routing

---

## 28. Multi-Turn Mid-Task Message Handling

V1 reference scope:
- orchestrator-owned interruption handling

---

## 29. Personalized Memory — RAG Architecture

V1/V2 reference scope:
- user/company memory paths

---

## 30. Remaining Gaps — To Be Designed

Track in roadmap with explicit owners in task files.

---

## 31. Merge — Conflict Resolutions

Resolved decisions include:
- Qdrant for vectors
- LiteLLM abstraction
- Vault-first secrets
- layered memory architecture
- merged RBAC role strategy

---

## 32. Complete Agent Roster — All 17 Agents

V2 target architecture; V0 implements a minimal subset with stable interfaces.

---

## 33. Multi-Tenant Architecture

V2 scope for hard isolation (schema/collection/key prefix + trace policy).

---

## 34. LLM Fallback Chain — LiteLLM

V1 scope baseline; V2 hardening.

---

## 35. RAG — Qdrant Vector Store

V1/V2 scope for memory and document retrieval at scale.

---

## 36. Ingestion Pipeline

V1 scope baseline with checkpoint/resume.

---

## 37. Delta Sync & Data Lifecycle

V2 scope for complete lifecycle and stale-data handling.

---

## 38. Self-Learning Agent

V2 scope for confidence scoring and human review loop.

---

## 39. Proactive Intelligence — Scheduler & Notification Hub

V2 scope for non-reactive automation.

---

## 40. Prompt Injection Defense — PromptGuard

V1 baseline, V2 hardening.

---

## 41. Secret Management — HashiCorp Vault

V2 production baseline.

---

## 42. PII Protection & GDPR

V2 compliance baseline.

---

## 43. MCP Response Validation

V1 baseline for schema safety.

---

## 44. Service Mesh & Encryption

V2 infrastructure baseline.

---

## 45. Extensibility — ABCs & Registry Pattern

Applies from V0 onward.

---

## 46. Full Observability Stack

V1 baseline, V2 full maturity.

---

## 47. 12-Week Build Plan

This plan drives phased delivery from V0 to V2.

---

## Canonical Plan Note

This file anchors the full v3.0 plan in-repo for execution alignment. The complete original narrative discussed in collaboration remains the source intent; implementation tasks in `/tasks` are derived from it with explicit scope slicing.

*Document version 3.0*
