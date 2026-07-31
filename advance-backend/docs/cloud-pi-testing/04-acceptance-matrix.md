# Cloud Pi acceptance matrix

Run the smallest cases needed for the changed behavior. For a broad release
smoke test, use the sequence below. Keep paths under `testing/cloud-pi-smoke/`
and use non-sensitive fixtures.

## 1. Plain model response and lifecycle

```text
Reply with exactly: DIVO CLOUD PI LIVE
Do not call any tools.
```

Pass when the intended Lark chat receives the exact answer, status updates are
visible, the trace completes, and controller health returns to zero active
runs.

## 2. Workspace CRUD and terminal execution

```text
Inside only your workspace, create testing/cloud-pi-smoke/state.txt containing
"phase-one". Read it back, replace it with "phase-two", read it again, and
report the final absolute workspace path plus the commands/tools used. Do not
touch any other file.
```

Pass when create, read, update, and final read all agree. Use a later test for
deletion so persistence can be checked first.

## 3. Internet download and baseline dependencies

```text
Run python3 --version and pdftotext -v. Then download https://example.com into
testing/cloud-pi-smoke/example.html, report the HTTP status and page title, and
leave the file in the workspace. Do not install anything for this test.
```

Pass when terminal execution, outbound internet, download, and baseline Python
plus Poppler are confirmed. A failure should remain visible; do not fall back
to a backend-only agent.

## 4. Governed Divo Gateway reads

Tailor connected systems to the named test user:

```text
Using only the governed Divo Gateway, perform read-only checks for my connected
Lark tasks, Google Drive, Gmail, and one available Zoho service. Return a table
with connector, exact operation, PASS/FAIL/SKIPPED, item count, and the exact
error code for failures. Do not create, update, send, or delete anything.
```

Pass when Pi calls backend-governed tools under the intended identity and
department. Missing connection/scope/permission is a truthful FAIL or SKIPPED,
not proof that the container is broken.

## 5. Planning, todos, and subagents

```text
Plan this as three todos. Ask two subagents independently to inspect
testing/cloud-pi-smoke/example.html: one should identify the title and one
should count visible-text words. Reconcile their results, mark every todo
complete, and report which subagent produced which result. Do not access files
outside testing/cloud-pi-smoke/.
```

Pass when the run exposes planning/todo progression, launches distinct
subagents, reconciles both outputs, and completes without workspace collision.

## 6. Stop/start persistence

Run this as a separate later request, after the earlier container has stopped:

```text
Without recreating it, read testing/cloud-pi-smoke/state.txt and
testing/cloud-pi-smoke/example.html. Report the saved state value and HTML
title. Then delete only testing/cloud-pi-smoke/ and confirm it no longer
exists.
```

Pass when the new Pi run sees files from the prior run, proving the container
can stop while its volume persists, and the explicitly scoped cleanup succeeds.

## 7. Media/OCR

Use the live webhook path, attach a known small PDF or image, and send:

```text
Read the attached fixture from your workspace. State its filename, extract the
known test phrase and one table/value, say whether you used OCR or embedded
text, and save a short Markdown summary under testing/cloud-pi-smoke/. Do not
send the document to any external business system.
```

Pass when the file is staged into the correct user's volume, Pi reads it,
extracts the known ground truth, and creates the summary. The direct harness
does not prove inbound media.

## 8. Concurrency and capacity

With explicit permission from two named testers, start one long read-only task
for each user. While both run:

```bash
curl -fsS http://127.0.0.1:4317/health | jq .
```

Expected state is `activeRuns: 2`, `maxActiveRuns: 2`.

- A second concurrent request from either active user should return
  `409 user_busy`.
- A third user's request should return `429 capacity_full` with friendly retry
  guidance.
- After one run finishes, a retry should be admitted.
- A rejected request must not start or mutate a user container/workspace.

## Result template

```text
Environment:
Commit:
Tester:
Lark chat:
Started:
Finished:
Case:
Prompt/fixture:
Request or correlation ID:
Lark final message ID:
Controller activeRuns before/during/after:
Container status after:
Result: PASS | FAIL | SKIPPED
First exact error code:
Notes:
```

Never paste tokens, session cookies, OAuth codes, passwords, full private
documents, or unredacted customer data into this result.

