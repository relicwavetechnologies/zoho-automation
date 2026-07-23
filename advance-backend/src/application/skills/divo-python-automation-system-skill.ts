import type { Prisma, PrismaClient } from '../../generated/prisma';
import {
  provisionDivoProductivitySkillForExistingCompanies,
  provisionDivoProductivitySystemSkill,
  type DivoProductivitySystemSkillDefinition,
} from './divo-productivity-system-skills';

export const DIVO_PYTHON_AUTOMATION_SKILL_SLUG = 'divo-python-automation';

export const DIVO_PYTHON_AUTOMATION_MARKDOWN = `# Divo Python Automation

Use this skill when one multi-step data workflow is materially easier to complete in Python: fetching bounded pages, transforming records, grouping, deduplicating, joining, or writing several related results. Python calls company tools only through the supplied Divo client. Every call still passes through backend RBAC, connection policy, approval, audit, native-schema validation, and rate limits.

## Choose the right path

- One straightforward read, create, update, send, or delete: call the Divo gateway directly. Python adds no value.
- A coherent read-transform-write workflow: use one **divo_python_automation** call.
- Durable or recurring work: schedule Divo work; the scheduled run may use this workflow when appropriate.

## One outcome, one Python run

Do not launch separate Python runs for each page, record, domain, tab, destination call, or small phase. Put the whole coherent workflow in **run(input_data, divo)** and loop inside Python. Split only when the current run must stop for material user clarification or an external approval, or when the user requested genuinely independent workflows.

## Program contract

Call **divo_python_automation** with a specific worklog title, a one-sentence workflow summary, optional non-secret JSON input, and Python defining:

~~~python
def run(input_data, divo):
    connections = divo.connections("google_workspace")
    # Select the exact intended connection from the returned data.
    # Use divo.tool("toolId") when an unfamiliar tool contract is needed.
    source_response = divo.invoke("sourceToolId", {
        "connectionId": "exact-uuid",
        "...": "...",
    })
    source = source_response["result"]["data"]

    # Transform, filter, group, join, and deduplicate in memory.
    rows = []
    for item in source.get("items", []):
        rows.append({"...": "..."})

    destination_response = divo.invoke("destinationToolId", {
        "connectionId": "exact-uuid",
        "rows": rows,
    })
    destination = destination_response["result"]["data"]

    # Read the written destination back and compare exact records/counts.
    verification = divo.invoke("destinationToolId", {
        "connectionId": "exact-uuid",
        "operation": "read",
        "resourceId": destination["id"],
    })
    verified_rows = verification["result"]["data"].get("rows", [])
    return {
        "status": "completed",
        "reconciliation": {
            "source": {
                "provider_returned": len(source.get("items", [])),
                "structured": len(source.get("items", [])),
                "parsed": len(source.get("items", [])),
                "skipped": 0,
            },
            "transformation": {
                "input": len(source.get("items", [])),
                "filtered_out": 0,
                "duplicates_removed": 0,
                "prepared": len(rows),
                "skipped": 0,
            },
            "destination": {
                "attempted": len(rows),
                "written": len(rows),
                "verified": len(verified_rows),
                "skipped": 0,
            },
        },
        "destination": {
            "resource_ids": [destination["id"]],
            "urls": [destination["url"]] if destination.get("url") else [],
            "ranges": [],
        },
        "verification": {
            "status": "verified",
            "checks": [{
                "name": "written rows read back",
                "passed": len(verified_rows) == len(rows),
                "expected": len(rows),
                "actual": len(verified_rows),
            }],
        },
        "issues": [],
        "safe_retry": {
            "mode": "none",
            "reason": "All destination rows were read back and reconciled.",
        },
    }
~~~

The supplied client has six methods:

- **divo.connections(provider)** — list accessible connections; returns response data or raises an exact gateway error.
- **divo.tool(tool_id)** — load one tool contract; returns response data or raises.
- **divo.invoke(tool_id, args)** — execute a governed company-tool call; returns \`{ toolId, action, result }\` or raises. Native operation data is always under \`response["result"]["data"]\`.
- **divo.require(op, payload)** — call another gateway operation and require success.
- **divo.gateway(op, payload)** — return the full structured response when the program deliberately needs to branch on status.
- **divo.normalize_email_date(value, timezone_name)** — parse RFC email dates, ISO timestamps, or epoch seconds/milliseconds into deterministic **iso_utc**, **local_iso**, and **local_date** fields. Invalid values return **ok: false** with the raw value and exact error.

## Required workflow result contract

Process exit is not proof of completion. Every run must return the contract shown above. Counts are non-negative integers and must reconcile exactly:

- **source.parsed + source.skipped = source.structured**
- **transformation.input = source.parsed**
- **filtered_out + duplicates_removed + prepared + transformation.skipped = transformation.input**
- **destination.attempted = transformation.prepared**
- **destination.written + destination.skipped = destination.attempted**
- **destination.verified <= destination.written**

A run may use **status: completed** only when every attempted write was written and verified and **verification.status** is **verified**. A read-only run may use **verification.status: not_required**. A **partial** or **failed** result must set **safe_retry.mode** to **resume_existing**, **retry_read_only**, or **manual_review**. If anything was written, return its ID in **destination.resource_ids** so the next run cannot create a duplicate.

The supported retry modes are:

- **none** — completed; nothing should be retried.
- **resume_existing** — continue using the returned resource ID; do not create again.
- **retry_read_only** — repeat verification or source reads without repeating mutations.
- **manual_review** — do not retry automatically; user or manager action is required.

## Execution discipline

1. Ask one concise question before running only when account, destination, destructive scope, or a material transformation rule is unclear.
2. Read and validate all source data first.
3. Transform in memory.
4. Perform related writes last. This reduces partial completion if a later call is rejected.
5. Read back the important destination range or records after writing. Report success only after verification.
6. Return the required workflow result contract. The runtime—not the model—uses it to decide whether the trace says completed, partial, or failed.
7. Use bounded pagination. Fetch only fields needed for the outcome.

## Strict boundaries

- Python runs as a normal local process. Standard imports, installed packages, print, local files, subprocesses, and networking are available.
- Python receives no Divo member token, OAuth token, or SaaS credential. Do not request, invent, scrape, or search local files for them.
- Use the supplied Divo client for connected company tools. Do not call a raw Divo gateway URL or attempt to bypass its policy checks.
- Every connection-backed call must use an exact **connectionId** obtained from **divo.connections**. Never guess an account.
- Backend rejection is authoritative. Do not blindly retry **permission_denied**, **approval_required**, **approval_rejected**, local approval denial, **invalid_args**, or **rate_limited**. Surface the exact reason. Retry only an unmistakably transient upstream/network failure, at most once.
- Never run a create, update, delete, or send merely to inspect its response shape. Use **divo.tool** or a read/describe call first. After a mutation succeeds, keep its returned identifier and do not repeat the mutation because later parsing or code failed; verify or report partial completion using that identifier.
- A direct run can partially complete if earlier writes succeeded before a later call failed. Prefer idempotent operations when available, keep writes last, and accurately report completed work.

## Google workflow notes

- Exact Divo tool IDs are **googleGmail** and **googleSheets**. Do not invent snake_case aliases.
- Gmail search data includes structured **messageIds** and **messages** when the provider returned them. Gmail batch metadata includes a structured **messages** list. Spreadsheet creation includes **spreadsheetId** and **spreadsheetUrl**. Prefer these fields over parsing prose.
- Normalize every Gmail **Date** header or **internalDate** with **divo.normalize_email_date(value, timezone_name)** before sorting or grouping. Sort on **iso_utc** and group daily results on **local_date** in the user's explicit IANA timezone, such as **Asia/Kolkata**. Never compare or group display strings. Preserve invalid raw dates and include them in skipped counts/issues.
- When the user asks for a company domain, normalize a sender subdomain such as **email.openai.com** to its registrable organization domain such as **openai.com** when that is unambiguous; retain the original sender address in the output.

## Worklog wording

Use clear outcome titles such as:

- Organizing Gmail leads in Google Sheets
- Consolidating 240 CRM records
- Building a weekly finance summary
- Exporting qualified vendors to Sheets

Never use generic titles such as "Run Python", "Execute script", or "Process data".`;

export const DIVO_PYTHON_AUTOMATION_SYSTEM_SKILL: DivoProductivitySystemSkillDefinition = {
  slug: DIVO_PYTHON_AUTOMATION_SKILL_SLUG,
  name: 'Divo Python Automation',
  summary: 'Run one coherent Python read-transform-write workflow through Divo gateway while the backend continues to enforce RBAC, approvals, audit, schemas, and rate limits.',
  markdown: DIVO_PYTHON_AUTOMATION_MARKDOWN,
  // divo_python_automation is a Pi extension, not a backend ToolRegistry id.
  toolIds: [],
  tags: ['divo', 'python', 'automation', 'data-transform', 'data-transfer', 'google-sheets', 'export'],
  aliases: ['python automation', 'transform data', 'export data', 'move data to google sheets', 'batch update', 'data transfer'],
  sortOrder: 24,
};

export async function provisionDivoPythonAutomationSystemSkill(
  db: Pick<Prisma.TransactionClient, 'skillFolder' | 'skill' | 'skillVersion' | 'skillRegistryRevision' | 'skillAccessGrant' | 'skillAlias'>,
  companyId: string,
) {
  return provisionDivoProductivitySystemSkill(db, companyId, DIVO_PYTHON_AUTOMATION_SYSTEM_SKILL);
}

export async function provisionDivoPythonAutomationForExistingCompanies(
  db: Pick<PrismaClient, 'company' | 'skillFolder' | 'skill' | 'skillVersion' | 'skillRegistryRevision' | 'skillAccessGrant' | 'skillAlias'>,
) {
  return provisionDivoProductivitySkillForExistingCompanies(db, DIVO_PYTHON_AUTOMATION_SYSTEM_SKILL);
}
