import assert from "node:assert/strict";
import { describe, it } from "node:test";
import extension, {
	assessDivoPythonWorkflow,
	runDivoPythonProgram,
	type DivoPythonProgramResult,
} from "./index.ts";

describe("Divo Python workflow tool", () => {
	it("teaches one coherent Python run instead of fragmented executions", () => {
		const tools: Array<{
			name?: string;
			description?: string;
			promptSnippet?: string;
			promptGuidelines?: string[];
		}> = [];
		extension({
			registerTool(tool: (typeof tools)[number]) {
				tools.push(tool);
			},
			on() {},
		} as never);

		assert.equal(tools[0]?.name, "divo_python_automation");
		assert.match(tools[0]?.description ?? "", /RBAC.*rate-limit/i);
		assert.match(tools[0]?.promptSnippet ?? "", /one Python run/i);
		assert.ok(tools[0]?.promptGuidelines?.some(line => /never start separate Python runs per page, row, tab/i.test(line)));
		assert.ok(tools[0]?.promptGuidelines?.some(line => /one straightforward read/i.test(line)));
		assert.ok(tools[0]?.promptGuidelines?.some(line => /response\['result'\]\['data'\]/i.test(line)));
		assert.ok(tools[0]?.promptGuidelines?.some(line => /never repeat it because downstream parsing failed/i.test(line)));
		assert.ok(tools[0]?.promptGuidelines?.some(line => /read back the important destination/i.test(line)));
		assert.ok(tools[0]?.promptGuidelines?.some(line => /reconciliation equations are exact/i.test(line)));
		assert.ok(tools[0]?.promptGuidelines?.some(line => /normalize_email_date/i.test(line)));
	});

	it("fetches, transforms, and writes through multiple gateway calls in one process", async () => {
		const requests: Array<{ op: string; payload: unknown }> = [];
		const result = await runDivoPythonProgram({
			title: "Move qualified records",
			summary: "Read records, filter them, and write one destination batch.",
			input: { minimum: 10 },
			code: `def qualified(items, minimum):
    return [item for item in items if item['score'] >= minimum]

def run(input_data, divo):
    source = divo.invoke('sourceTool', {'operation': 'list'})
    selected = qualified(source['items'], input_data['minimum'])
    written = divo.invoke('destinationTool', {'operation': 'create', 'rows': selected})
    return {'selected': len(selected), 'destination': written['id']}
`,
		}, new AbortController().signal, async (request, callIndex) => {
			requests.push({ op: request.op, payload: request.payload });
			return callIndex === 1
				? {
					ok: true,
					status: "success",
					data: { items: [{ score: 3 }, { score: 12 }, { score: 18 }] },
				}
				: { ok: true, status: "success", data: { id: "sheet-1" } };
		});

		assert.equal(result.gatewayCallCount, 2);
		assert.deepEqual(result.result, { selected: 2, destination: "sheet-1" });
		assert.deepEqual(requests, [
			{
				op: "tools.invoke",
				payload: { toolId: "sourceTool", args: { operation: "list" } },
			},
			{
				op: "tools.invoke",
				payload: {
					toolId: "destinationTool",
					args: { operation: "create", rows: [{ score: 12 }, { score: 18 }] },
				},
			},
		]);
		assert.deepEqual(result.calls.map(call => call.status), ["success", "success"]);
	});

	it("runs ordinary Python imports, print, files, and subprocesses", async () => {
		const result = await runDivoPythonProgram({
			title: "Run normal local Python",
			summary: "Exercise normal Python capabilities in one local process.",
			input: { values: ["alpha", "alpha", "beta"] },
			code: `from collections import Counter
from pathlib import Path
import subprocess
import sys

def run(input_data, divo):
    counts = Counter(input_data['values'])
    Path('result.txt').write_text('ready', encoding='utf-8')
    command_output = subprocess.check_output([sys.executable, '-c', "print('subprocess-ok', end='')"], text=True)
    print('normal-python-ok')
    return {
        'counts': dict(counts),
        'file': Path('result.txt').read_text(encoding='utf-8'),
        'command': command_output,
    }
`,
		}, new AbortController().signal, async () => {
			throw new Error("This test does not make gateway calls.");
		});

		assert.deepEqual(result.result, {
			counts: { alpha: 2, beta: 1 },
			file: "ready",
			command: "subprocess-ok",
		});
		assert.equal(result.stdout, "normal-python-ok");
		assert.equal(result.gatewayCallCount, 0);
	});

	it("surfaces an exact backend rejection without retrying it", async () => {
		let calls = 0;
		await assert.rejects(
			runDivoPythonProgram({
				title: "Read bounded records",
				summary: "Read a governed source once.",
				input: {},
				code: `def run(input_data, divo):
    return divo.invoke('sourceTool', {'operation': 'list'})
`,
			}, new AbortController().signal, async () => {
				calls += 1;
				return {
					ok: false,
					status: "rate_limited",
					error: { code: "rate_limited", message: "Read budget exhausted for this connection." },
				};
			}),
			/rate_limited: Read budget exhausted for this connection/,
		);
		assert.equal(calls, 1);
	});

	it("allows completion only when stage counts and verification reconcile", () => {
		const program = programWithResult(completedWorkflowResult());
		const assessment = assessDivoPythonWorkflow(program);

		assert.equal(assessment.valid, true);
		assert.equal(assessment.status, "completed");
		assert.equal(assessment.phase, "Completed");
		assert.match(assessment.message, /2 prepared, 2 written, and 2 verified/i);
	});

	it("downgrades an inconsistent completion claim to unverified partial work", () => {
		const result = completedWorkflowResult();
		result.reconciliation.destination.verified = 1;
		result.verification.status = "partial";
		const assessment = assessDivoPythonWorkflow(programWithResult(result));

		assert.equal(assessment.valid, false);
		assert.equal(assessment.status, "partial");
		assert.equal(assessment.phase, "Partial");
		assert.ok(assessment.errors.some(error => /attempted = written = verified/i.test(error)));
		assert.ok(assessment.errors.some(error => /verification\.status = verified/i.test(error)));
	});

	it("requires partial writes to retain a destination ID for safe resume", () => {
		const result = completedWorkflowResult();
		result.status = "partial";
		result.reconciliation.destination.written = 1;
		result.reconciliation.destination.verified = 0;
		result.reconciliation.destination.skipped = 1;
		result.destination.resource_ids = [];
		result.verification.status = "partial";
		result.safe_retry = {
			mode: "resume_existing",
			reason: "Continue writing into the existing spreadsheet.",
		};
		const assessment = assessDivoPythonWorkflow(programWithResult(result));

		assert.equal(assessment.valid, false);
		assert.ok(assessment.errors.some(error => /destination\.resource_ids/i.test(error)));
	});

	it("normalizes Gmail dates before timezone-aware sorting and daily grouping", async () => {
		const result = await runDivoPythonProgram({
			title: "Normalize Gmail dates",
			summary: "Normalize RFC, ISO, and invalid Gmail dates for an IST daily report.",
			input: {},
			code: `def run(input_data, divo):
    return {
        'rfc': divo.normalize_email_date('Wed, 22 Jul 2026 23:45:00 -0400', 'Asia/Kolkata'),
        'iso': divo.normalize_email_date('2026-07-22T20:00:00Z', 'Asia/Kolkata'),
        'invalid': divo.normalize_email_date('not-a-date', 'Asia/Kolkata'),
    }
`,
		}, new AbortController().signal, async () => {
			throw new Error("This test does not make gateway calls.");
		});

		assert.deepEqual(result.result, {
			rfc: {
				ok: true,
				raw: "Wed, 22 Jul 2026 23:45:00 -0400",
				iso_utc: "2026-07-23T03:45:00Z",
				local_iso: "2026-07-23T09:15:00+05:30",
				local_date: "2026-07-23",
				timezone: "Asia/Kolkata",
				assumed_utc: false,
			},
			iso: {
				ok: true,
				raw: "2026-07-22T20:00:00Z",
				iso_utc: "2026-07-22T20:00:00Z",
				local_iso: "2026-07-23T01:30:00+05:30",
				local_date: "2026-07-23",
				timezone: "Asia/Kolkata",
				assumed_utc: false,
			},
			invalid: {
				ok: false,
				raw: "not-a-date",
				timezone: "Asia/Kolkata",
				error: "ValueError: Invalid isoformat string: 'not-a-date'",
			},
		});
	});
});

function completedWorkflowResult() {
	return {
		status: "completed",
		reconciliation: {
			source: { provider_returned: 3, structured: 3, parsed: 3, skipped: 0 },
			transformation: { input: 3, filtered_out: 1, duplicates_removed: 0, prepared: 2, skipped: 0 },
			destination: { attempted: 2, written: 2, verified: 2, skipped: 0 },
		},
		destination: {
			resource_ids: ["sheet-1"],
			urls: ["https://docs.google.com/spreadsheets/d/sheet-1"],
			ranges: ["Records!A1:C3"],
		},
		verification: {
			status: "verified",
			checks: [{ name: "row count", passed: true, expected: 2, actual: 2 }],
		},
		issues: [],
		safe_retry: { mode: "none", reason: "All rows were read back." },
	};
}

function programWithResult(result: unknown): DivoPythonProgramResult {
	return {
		result,
		gatewayCallCount: 2,
		calls: [
			{ op: "tools.invoke", toolId: "googleGmail", action: "read", status: "success", ok: true },
			{ op: "tools.invoke", toolId: "googleSheets", action: "create", status: "success", ok: true },
		],
	};
}
