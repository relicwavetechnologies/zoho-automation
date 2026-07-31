# Explicit manager Teach — implementation validation

Validated on 2026-07-18 from `advance-backend` on macOS.

## Implemented path

```text
authenticated manager upload
  -> durable BullMQ ingestion job
  -> Peepshow frame/audio extraction
  -> Qwen vision OCR through OpenRouter
  -> gpt-4o-mini-transcribe through OpenAI
  -> bounded evidence manifest
  -> DeepSeek V4 Pro max-thinking structured persona patch
  -> backend evidence/safety/scope validation
  -> atomic manager persona update
  -> raw/evidence cleanup
  -> one of two bounded Undo snapshots
```

This pipeline updates only the manager persona. It does not write memory, executable skills, RBAC, approvals, or integration authority.

## Evaluation evidence

The Divo-owned Phase 5 evaluation suite passed 8/8 live cases with DeepSeek V4 Pro:

- add a durable workflow;
- add a narrowly scoped preference;
- replace an exact active rule;
- retire an exact active rule;
- reject screen-only inference;
- reject approval-bypass prompt injection;
- reject one-off sensitive task data;
- reject an explicitly situational/non-rule behavior.

The suite also reported 100% scope accuracy, clean proposals, no-learning accuracy, and critical-safety pass rate in that run.

## End-to-end smoke evidence

The isolated Phase 6 smoke harness starts temporary PostgreSQL and Redis services, generates a narrated screen-recording, and uses the real authenticated HTTP and queue path. The live run proved:

- Peepshow extracted a usable frame and audio track;
- `qwen/qwen3-vl-32b-instruct` performed screenshot OCR through OpenRouter;
- `gpt-4o-mini-transcribe` returned the narrated manager instruction;
- DeepSeek proposed one persona change and the backend applied one change;
- raw video and evidence artifacts were deleted after synthesis;
- Undo restored the empty pre-Teach persona and consumed its snapshot;
- all temporary database, Redis, media, and upload data was removed.

Run it manually with:

```bash
cd advance-backend
pnpm smoke:manager-teach
```

The command requires local `postgres`, `redis-server`, `ffmpeg`, macOS `say`/`sips`, and configured OpenAI, OpenRouter, and DeepSeek keys. It never uses the configured development database or Redis instance.

## Findings from the live run

1. The former OCR default, `qwen/qwen2.5-vl-32b-instruct`, returned `404 No endpoints found` from OpenRouter. The active default is now `qwen/qwen3-vl-32b-instruct`, which passed the real OCR stage. OpenRouter lists it as a current multimodal model with OCR support.
2. The repository's 18 migrations cannot bootstrap a blank PostgreSQL database because the first available migration alters tables that are not created in the checked-in history. The disposable harness uses `prisma db push --skip-generate` to install the current schema. This is suitable only for its empty temporary database.

## Remaining work

- Create or document a trustworthy production database baseline before claiming fresh-environment migration deployment.
- Run a small set of real manager recordings with different screen density, accents, duration, and app workflows.
- Record stage latency, external-model cost, OCR/STT failure rates, and end-to-end persona precision on those recordings.
- Decide deployment defaults for worker concurrency and recording limits from real load rather than the synthetic smoke case.
