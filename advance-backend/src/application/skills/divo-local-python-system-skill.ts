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
continuation fields. Use a provider's temporary \`exportCandidate\` →
\`dataExport\` compatibility path only when that provider skill explicitly says
it has no terminal-safe paging contract. The container is a real machine with a
real terminal: write the file, run it, read the error, edit that same file, and
run it again.

Never use \`exportCandidate\`, \`preview.exportOfferId\`,
\`destinationReferenceId\`, or \`resourceRef\` as Python data input. Those
opaque handles stay with \`secure-data-export\` or \`google-sheets\`. A returned
export job ID is only a status/checkpoint handle; it is not a dataset and must
never be expanded into rows.

Python is ordinary local execution. The agent creates a persistent source file,
runs it through Bash, edits that same file after an error, and reruns the same
command. Connected company calls go through the credential-free
\`divo-local\` client, so backend RBAC, connection policy, approvals, schemas,
audit, credentials, and rate limits remain authoritative.

## Data too large to hold

Never carry a record set through model context to inspect it, and never print
rows. Keep each page in \`DIVO_RUN_DIR\`, transform it with Python/DuckDB, and
print only counts, aggregates, validation failures, and required resource IDs.

## Choose the right path

- For ${GOVERNED_DIRECT_ACTION_CRITERION}, use the Divo gateway directly.
- Use one persistent Python file under \`DIVO_RUN_DIR\` only when the work has
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
2. Use the \`write\` tool once to create
   \`<DIVO_RUN_DIR>/<descriptive-workflow>.py\`. Put non-secret input, output,
   and \`checkpoint.json\` beside it. In Lark, return the complete user-facing
   result in chat and never claim a local path was delivered; use a governed
   connected destination when the user needs a file. In Jan desktop, finished
   files may go to \`DIVO_ARTIFACTS_DIR\`. \`DIVO_RUN_DIR\` is never delivered.
3. Use Bash to run the file with
   \`python3 <absolute-DIVO_RUN_DIR>/<descriptive-workflow>.py\`.
4. When Python or a provider contract fails, inspect the structured response,
   use \`edit\` on that exact file, and rerun the exact Bash command.
5. Do not resend the complete source in a tool argument, rewrite the entire
   file for a small correction, or create a second retry script.
6. Keep successful mutation IDs in \`checkpoint.json\` before proceeding. A
   resumed run must reuse or verify an existing resource and must never repeat
   a successful create or send.
7. Read important destination records back and reconcile counts before
   reporting completion.
8. Once this path is selected, keep all connected reads, writes, and
   verification for this workflow inside that file through \`divo-local\`.
   Direct gateway calls before the file are only for a genuinely unknown
   account or schema; never manually carry a record set through model context.

## Calling Divo from Python

Use \`subprocess\` with \`divo-local\`. It exposes no member token or SaaS
credential. For generated or substantial arguments, write an adjacent JSON
file and pass \`--args-file\`.

For a record page, always add \`--output <new-file-inside-DIVO_RUN_DIR>\`.
The CLI writes the full governed response only to that file and prints a small
path/byte-count/trace summary. Never print or \`cat\` the saved response. Parse
it in Python and print only counts, aggregates, validation errors, and IDs the
user needs. A failed call does not create the output file, so correct the same
script and rerun it with the same path.

Use the exact \`connectionId\` already present in the current run bootstrap.
Only when the required provider is absent may the script call
\`connections.list\` once with exactly one provider. Never guess, copy an old
ID, or retry several IDs. Provider args must match the loaded source skill
exactly; for Zoho Books a page read requires \`op\`, \`connectionId\`, and its
document/page fields.

Read the native skill that owns a tool before the script calls it. Never pass a
skill ID on the command line: skills provide workflow guidance, while the
backend independently enforces identity, RBAC, approvals, schemas, and audit.

~~~python
import json
import subprocess
from pathlib import Path

RUN_DIR = Path(__file__).resolve().parent


class DivoCallError(RuntimeError):
    def __init__(self, response):
        self.response = response
        status = response.get("status", "broker_error")
        detail = response.get("error") or response.get("approval") or {}
        message = detail.get("message", "Divo rejected the operation.")
        super().__init__(f"{status}: {message}")


def divo_invoke_to_file(tool_id, args, label, args_name, output_name):
    args_path = RUN_DIR / args_name
    output_path = RUN_DIR / output_name
    if output_path.exists():
        raise RuntimeError(f"Refusing to overwrite existing result: {output_path.name}")
    args_path.write_text(json.dumps(args, ensure_ascii=False), encoding="utf-8")
    completed = subprocess.run(
        [
            "divo-local",
            "invoke",
            "--tool",
            tool_id,
            "--args-file",
            str(args_path),
            "--output",
            str(output_path),
            "--label",
            label,
        ],
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
    response = json.loads(output_path.read_text(encoding="utf-8"))
    if not response.get("ok"):
        raise DivoCallError(response)
    return response["data"]
~~~

For discovery that is genuinely necessary, use:

~~~text
divo-local request --op connections.list --payload-file <path>
divo-local request --op tools.list --payload-file <path>
~~~

Do not use curl, raw backend URLs, local SaaS SDK credentials, member tokens,
OAuth tokens, or copied tool secrets.

The helper returns only \`response["data"]\` inside Python. Read field names,
page tokens, write limits, and verification shapes from the loaded provider
skill; do not duplicate or guess them here.

## Stop and completion rules

- Validate all source pages before the first mutation. Reconcile
  \`returned == parsed + skipped\`; every skip needs a reason.
- Validate destination scalars, write in bounded batches, checkpoint every
  successful mutation ID, then read back important ranges.
- Stop on permission, approval, invalid arguments, or rate limits. Retry only a
  clearly transient upstream failure once.
- Write \`result.json\` with status, source/transformation/write/verified counts,
  destination IDs/URLs, issues, and the safe resume step.
- Claim completed only when counts reconcile and read-back succeeds. Otherwise
  report partial or failed; process exit zero alone proves nothing.`;

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
