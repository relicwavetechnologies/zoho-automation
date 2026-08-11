import type { Prisma, PrismaClient } from '../../generated/prisma';
import {
  provisionDivoProductivitySkillForExistingCompanies,
  provisionDivoProductivitySystemSkill,
  type DivoProductivitySystemSkillDefinition,
} from './divo-productivity-system-skills';
import {
  GOVERNED_DIRECT_ACTION_CRITERION,
  GOVERNED_LOCAL_WORKFLOW_CRITERION,
} from './governed-local-routing';

/**
 * Keep the original slug so provisioning updates the already-published system
 * skill in place instead of leaving an active legacy recipe beside this one.
 */
export const DIVO_LOCAL_PYTHON_SKILL_SLUG = 'divo-python-automation';

export const DIVO_LOCAL_PYTHON_MARKDOWN = `# Divo Local Python Workflows

Use this recipe when one coherent workflow materially benefits from Python for
bounded pagination, parsing, transformation, grouping, deduplication, joining,
or several related destination writes.

Use this path for a complete artifact when the source skill exposes real page or
continuation fields. The container is a real machine with a real terminal:
write the file, run it, read the error, edit that same file, and run it again.

Opaque resource references are not Python data input. Resolve them through the
specialist that owns the resource, then keep bulk rows in local result files.

Python is ordinary local execution. The agent creates a persistent source file,
runs it through Bash, edits that same file after an error, and reruns the same
command. Connected company calls go through the credential-free
\`divo-local\` client, so backend RBAC, connection policy, approvals, schemas,
audit, credentials, and rate limits remain authoritative.

## Data too large to hold

Never carry a record set through model context to inspect it, and never print
rows. Keep raw governed result envelopes in \`DIVO_RUN_DIR\`, which is one-turn
scratch. When \`DIVO_THREAD_WORK_DIR\` is set, keep resumable scripts,
checkpoints, normalized JSONL/Parquet, and manifests under its \`workflows/\`
directory. Transform with Python/DuckDB and print only counts, aggregates,
validation failures, and required resource IDs.

## Choose the right path

- For ${GOVERNED_DIRECT_ACTION_CRITERION}, use the Divo gateway directly.
- Use one persistent Python file only when the work has
  ${GOVERNED_LOCAL_WORKFLOW_CRITERION}. Gmail/CRM →
  Sheets is always this local-workflow path.
- Durable or recurring work: schedule Divo work; its future run may use this
  same file-based workflow when appropriate.

The retired \`divo_python_automation\` tool is unavailable. Never call it,
including when an older conversation or cached recipe mentions it.

## Required file lifecycle

1. Read the native source and destination skills relevant to the request if
   they have not been read yet. Use their governed tool contracts; never mutate
   data merely to discover a response shape.
2. Choose the working directory before the first connected call. If
   \`DIVO_THREAD_WORK_DIR\` is set, use
   \`$DIVO_THREAD_WORK_DIR/workflows/<descriptive-workflow>-<shortid>/\`.
   Otherwise use \`DIVO_RUN_DIR\` and do not pause expecting files to survive the
   next turn. Use the \`write\` tool once to create the Python file there. Put
   non-secret normalized input, output, and \`checkpoint.json\` beside it; raw
   protected \`divo-local\` result envelopes remain in \`DIVO_RUN_DIR\`.
   In Lark, return the complete user-facing result in chat and never claim a
   local path was delivered; use a governed connected destination when the user
   needs a file. In Jan desktop, finished files may go to
   \`DIVO_ARTIFACTS_DIR\`. \`DIVO_RUN_DIR\` is never delivered.
3. Write \`.divo-workflow.json\` beside the script with \`status\`, \`task\`,
   \`source\`, \`destination\`, \`resumeStep\`, \`createdAt\`, and \`updatedAt\`.
   Never resume merely because files exist; resume only when the current user
   explicitly asks to continue or the manifest is \`awaiting_user\` for the same
   task, source, and destination.
4. Use Bash to run the file with
   \`python3 <absolute-workflow-dir>/<descriptive-workflow>.py\`.
5. When Python or a provider contract fails, inspect the structured response,
   use \`edit\` on that exact file, and rerun the exact Bash command.
6. Do not resend the complete source in a tool argument, rewrite the entire
   file for a small correction, or create a second retry script.
7. Keep successful mutation IDs in \`checkpoint.json\` before proceeding. A
   resumed run must reuse or verify an existing resource and must never repeat
   a successful create or send. Set the manifest to \`awaiting_user\` before
   asking the user mid-workflow, \`completed\` only after verification, or
   \`failed\` with the safe resume step.
8. Read important destination records back and reconcile counts before
   reporting completion.
9. Once this path is selected, keep all connected reads, writes, and
   verification for this workflow inside that file through \`divo-local\`.
   Direct gateway calls before the file are only for a genuinely unknown
   account or schema; never manually carry a record set through model context.

## Calling Divo from Python

Use \`subprocess\` with \`divo-local\`. It exposes no member token or SaaS
credential. For native MCP-style provider operations, write only the native
\`input\` object to an adjacent JSON file and call
\`divo-local call <toolId>.<nativeTool> --input-file <path>\`. The command name
carries the tool and operation; do not put \`op\`, \`nativeTool\`, \`toolId\`,
\`args\`, or \`skillId\` inside that input file. Use
\`divo-local describe <toolId>.<nativeTool>\` only when a genuinely required
native operation schema was not already loaded. Use legacy
\`divo-local invoke --tool <toolId> --args-file <path>\` only for non-native or
special operations with no \`<toolId>.<nativeTool>\` call surface.

Every native \`divo-local call\` or legacy \`invoke\` automatically writes its
successful governed response to a new protected JSON file inside \`DIVO_RUN_DIR\`
and prints only a small path/byte-count/trace summary. Read the returned path in
Python, then copy only normalized rows/checkpoints you truly need into the
workflow directory. Never print or \`cat\` the saved response; print only counts,
aggregates, validation errors, and IDs the user needs. A failed call creates no
result file.

The saved JSON is \`{ ok, status, data, meta, ... }\`; \`data\` is the provider
result, not necessarily a row array. Never use \`len(data)\` as a record count.
Use the source skill's exact row, reported-count, and pagination fields.

Omit an optional \`connectionId\` unless the user selected an account or the
previous tool result returned eligible choices. The governed executor selects
the sole account eligible for the exact action and scopes before approvals and
rate limits. When the source schema requires an ID, use an exact current-run ID;
never guess, copy an old ID, or retry several IDs.

The source skill and current work bootstrap already provide the backend
\`toolId\`, native operation name, input contract, and continuation fields. Use
those exact values.
Do not call \`tools.list\`, run \`divo-local --help\`, or probe the tool merely to
rediscover a loaded contract. If an exact contract is genuinely missing, stop
and report that contract gap instead of inventing a second discovery workflow.
For Zoho Books a page read requires \`op\`, \`connectionId\`, and its document/page
fields.

Read the native skill that owns a tool before the script calls it. Never pass a
skill ID on the command line: skills provide workflow guidance, while the
backend independently enforces identity, RBAC, approvals, schemas, and audit.

~~~python
import json
import os
import subprocess
from pathlib import Path

RUN_DIR = Path(os.environ["DIVO_RUN_DIR"]).resolve()
WORKFLOW_DIR = Path(__file__).resolve().parent


class DivoCallError(RuntimeError):
    def __init__(self, response):
        self.response = response
        status = response.get("status", "broker_error")
        detail = response.get("error") or response.get("approval") or {}
        message = detail.get("message", "Divo rejected the operation.")
        super().__init__(f"{status}: {message}")


def divo_call(operation, input_obj, label, input_name, connection_id=None):
    input_path = WORKFLOW_DIR / input_name
    input_path.write_text(json.dumps(input_obj, ensure_ascii=False), encoding="utf-8")
    command = [
        "divo-local",
        "call",
        operation,
        "--input-file",
        str(input_path),
        "--label",
        label,
    ]
    if connection_id:
        command.extend(["--connection-id", connection_id])
    completed = subprocess.run(
        command,
        capture_output=True,
        text=True,
        check=False,
    )
    try:
        summary = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"divo-local returned invalid JSON: {completed.stderr.strip()}"
        ) from exc
    if completed.returncode != 0 or not summary.get("ok"):
        raise DivoCallError(summary)
    output_path = Path(summary["output"])
    try:
        output_path.resolve().relative_to(RUN_DIR)
    except ValueError:
        raise RuntimeError("divo-local returned a result outside DIVO_RUN_DIR")
    response = json.loads(output_path.read_text(encoding="utf-8"))
    if not response.get("ok"):
        raise DivoCallError(response)
    return response["data"]
~~~

When account discovery is genuinely necessary, use:

~~~text
divo-local request --op connections.list --payload-file <path>
~~~

\`divo-local\` writes machine-readable JSON to stdout and progress or diagnostics
to stderr. Parse stdout only; never merge stderr into it with \`2>&1\`.

Do not use curl, raw backend URLs, local SaaS SDK credentials, member tokens,
OAuth tokens, or copied tool secrets.

The helper returns only \`response["data"]\` inside Python. Read field names,
page tokens, write limits, and verification shapes from the loaded provider
skill; do not duplicate or guess them here.

## Stop and completion rules

- Validate all source pages before the first mutation. Persist the validated
  rows to JSONL/Parquet plus a checkpoint containing the source count and last
  continuation. If a later write, format, or verification step fails, patch and
  rerun from that saved source instead of refetching unchanged provider pages.
  Reconcile \`returned == parsed + skipped\`; every skip needs a reason.
- Validate destination scalars, write in bounded batches, checkpoint every
  successful mutation ID, then read back important ranges.
- Stop on permission, approval, or invalid arguments. \`divo-local\` owns the
  one safe exact retry for a short connection-budget rejection. Never add
  sleeps or retry \`rate_limited\` yourself; if the client still returns it,
  preserve the checkpoint and report the incomplete step.
- Minimize governed destination calls: combine values into bounded writes and
  apply each distinct format or dimension change once. Do not repeat reads or
  formatting calls merely to pace the connection.
- Use the largest page size explicitly allowed by the loaded source skill for
  complete file-backed paging. Small chat-preview defaults do not belong in a
  terminal workflow.
- Write \`result.json\` with status, source/transformation/write/verified counts,
  destination IDs/URLs, issues, and the safe resume step.
- Claim completed only when counts reconcile and read-back succeeds in the same
  workflow. Make the script raise on a mismatched, incomplete, rate-limited, or
  missing verification response, and write \`status: completed\` only afterward.
  An earlier write acknowledgement or read from a failed attempt is not proof.
  Otherwise report partial or failed; process exit zero alone proves nothing.`;

export const DIVO_LOCAL_PYTHON_SYSTEM_SKILL: DivoProductivitySystemSkillDefinition = {
  slug: DIVO_LOCAL_PYTHON_SKILL_SLUG,
  name: 'Divo Local Python Workflows',
  summary: 'Build, run, patch, and rerun one persistent local Python workflow while Divo continues to govern connected company actions.',
  markdown: DIVO_LOCAL_PYTHON_MARKDOWN,
  toolIds: [],
  tags: ['divo', 'python', 'local-execution', 'data-transform', 'data-transfer', 'google-sheets', 'export'],
  aliases: ['python workflow', 'transform data', 'combine connected data', 'gmail to sheets', 'gmail export google sheets', 'email operations analysis', 'bulk gmail sheet', 'batch update', 'cross-tool data transfer'],
  sortOrder: 24,
};

export async function provisionDivoLocalPythonSystemSkill(
  db: Pick<Prisma.TransactionClient, 'skillFolder' | 'skill' | 'skillVersion' | 'skillRegistryRevision' | 'skillAccessGrant' | 'skillAlias'>,
  companyId: string,
) {
  return provisionDivoProductivitySystemSkill(db, companyId, DIVO_LOCAL_PYTHON_SYSTEM_SKILL);
}

export async function provisionDivoLocalPythonForExistingCompanies(
  db: Pick<PrismaClient, 'company' | 'skillFolder' | 'skill' | 'skillVersion' | 'skillRegistryRevision' | 'skillAccessGrant' | 'skillAlias'>,
) {
  return provisionDivoProductivitySkillForExistingCompanies(db, DIVO_LOCAL_PYTHON_SYSTEM_SKILL);
}
