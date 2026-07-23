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
    return {
        "source_count": len(source.get("items", [])),
        "written_count": len(rows),
        "destination": destination,
    }
~~~

The supplied client has five methods:

- **divo.connections(provider)** — list accessible connections; returns response data or raises an exact gateway error.
- **divo.tool(tool_id)** — load one tool contract; returns response data or raises.
- **divo.invoke(tool_id, args)** — execute a governed company-tool call; returns \`{ toolId, action, result }\` or raises. Native operation data is always under \`response["result"]["data"]\`.
- **divo.require(op, payload)** — call another gateway operation and require success.
- **divo.gateway(op, payload)** — return the full structured response when the program deliberately needs to branch on status.

## Execution discipline

1. Ask one concise question before running only when account, destination, destructive scope, or a material transformation rule is unclear.
2. Read and validate all source data first.
3. Transform in memory.
4. Perform related writes last. This reduces partial completion if a later call is rejected.
5. Read back the important destination range or records after writing. Report success only after verification.
6. Return compact JSON with source count, affected count, destination, created identifiers, verification status, and any skipped records.
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
