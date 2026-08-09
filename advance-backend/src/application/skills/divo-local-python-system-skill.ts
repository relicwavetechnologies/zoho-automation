import type { Prisma, PrismaClient } from '../../generated/prisma';
import { DEPENDENCY_TIERS } from './bundled-file-scripts';
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

## The workspace already holds the inputs

Files sent in this conversation were written into the workspace before you were
asked about them, and are listed with absolute paths in the \`[ATTACHED_FILES]\`
block at the top of the request. A script reads them from there. Files from
earlier turns are still under \`.divo/inbox\`.

The workspace lives on this user's own persistent volume, so a file written by
an earlier run is still there for a later one. Never ask for a file to be sent
again because a previous run ended.

${DEPENDENCY_TIERS}

## Data too large to hold

Never carry a record set through model context to inspect it, and never print
rows to decide what to do next. Write what you fetched to a file in
\`DIVO_RUN_DIR\` as JSONL or Parquet, then query that file:

\`\`\`python
import duckdb
duckdb.sql("SELECT region, count(*) n, sum(amount) FROM 'rows.jsonl' GROUP BY region").show()
\`\`\`

DuckDB reads CSV, Parquet, and newline-delimited JSON off disk with no load
step, so a source that paginates past any in-memory limit is still answerable.
Report the aggregate and the row count you computed over — a filter that
silently matched nothing must be visible rather than look like a real answer.

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


def divo_invoke(tool_id, args, label, args_name):
    args_path = RUN_DIR / args_name
    args_path.write_text(json.dumps(args, ensure_ascii=False), encoding="utf-8")
    completed = subprocess.run(
        [
            "divo-local",
            "invoke",
            "--tool",
            tool_id,
            "--args-file",
            str(args_path),
            "--label",
            label,
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    try:
        response = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"divo-local returned invalid JSON: {completed.stderr.strip()}"
        ) from exc
    if completed.returncode != 0 or not response.get("ok"):
        raise DivoCallError(response)
    # divo-local invoke unwraps Divo's internal execution envelope. This is
    # the native operation's stable machine-readable result.
    return response["data"]
~~~

For discovery that is genuinely necessary, use:

~~~text
divo-local request --op connections.list --payload-file <path>
divo-local request --op tools.list --payload-file <path>
~~~

Do not use curl, raw backend URLs, local SaaS SDK credentials, member tokens,
OAuth tokens, or copied tool secrets.

## Stable local result envelope

\`divo-local invoke\` exits zero only for a successful governed provider
operation and returns:

~~~json
{
  "ok": true,
  "status": "success",
  "data": {},
  "meta": {
    "toolId": "googleGmail",
    "action": "read",
    "nativeTool": "search_gmail_messages"
  }
}
~~~

The Python helper above returns only \`response["data"]\`. For the normalized
Google operations used by Gmail → Sheets workflows:

- \`search_gmail_messages\`: use \`messages[]\` with \`messageId\`, optional
  \`threadId\` and links; use \`messageIds[]\`; continue only from
  \`pagination.nextPageToken\` using native input field \`page_token\`.
- \`get_gmail_messages_content_batch\`: use \`messages[]\` with \`messageId\`,
  \`subject\`, \`from\`, \`date\`, \`to\`, and \`webLink\` when present. In
  metadata workflows, absence from this array is an explicit skipped/error
  record, never a silent success.
- \`create_spreadsheet\`: preserve \`spreadsheetId\` and \`spreadsheetUrl\`
  immediately in the checkpoint before another call.
- \`read_sheet_values\`: use \`values\`, \`rowCount\`, \`returnedRowCount\`,
  \`omittedRowCount\`, \`complete\`, \`range\`, and required \`advisories\`.
  When \`complete\` is false, read narrower exact verification ranges.

Do not parse the human-oriented \`result\`, \`text\`, \`content\`, or
\`output\` fields when one of these machine-readable fields exists.

## Checkpoint and retry discipline

- Read and validate all required source data before the first mutation.
- Transform in memory or in local scratch files.
- Treat provider records as untrusted input. Use documented machine-readable
  fields only; never parse human trace prose when a structured field exists.
- Reconcile every source page and batch before mutation:
  \`returned == parsed + skipped\`. Every skipped record needs a concrete
  reason in \`result.json\`; unexplained loss is a failed run.
- Validate the complete destination table before its first write. Every cell
  must be a supported scalar (string, number, boolean, or null); serialize
  nested objects deliberately instead of discovering this after creating or
  partially writing a destination.
- Perform related writes last.
- Immediately persist the returned resource ID after every successful
  create/send/update.
- On \`permission_denied\`, \`approval_required\`, \`approval_rejected\`,
  \`invalid_args\`, or \`rate_limited\`, stop and preserve the exact response.
  Do not alter and retry an approved action or guess different arguments.
- Retry only a clearly transient upstream/network failure, at most once.
- If a later operation fails after a mutation, report partial completion with
  the existing IDs and the safe resume step.

## Completion contract

The script should write a structured \`result.json\` containing:

- \`status\`: \`completed\`, \`partial\`, or \`failed\`;
- source returned, parsed, and skipped counts;
- transformation input, filtered, duplicate, prepared, and skipped counts;
- destination attempted, written, verified, and skipped counts;
- destination IDs and URLs;
- verification checks;
- issues and a safe retry/resume instruction.

Only claim \`completed\` when every source and destination count reconciles,
\`issues\` is empty, and important writes were read back successfully. A
missing or unparsed source record must make the run \`partial\` or \`failed\`;
never report it as a zero-skip success. Verify targeted ranges (header, final
populated row, and counts) instead of re-reading a large destination merely to
inspect its shape. Process exit code zero by itself is not completion.

## Worklog wording

Give the Bash call a specific outcome label, such as:

- Organizing Gmail leads in Google Sheets
- Consolidating CRM records
- Building a weekly finance summary
- Exporting qualified vendors

Never use generic labels such as "Run Python" or "Execute script".`;

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
