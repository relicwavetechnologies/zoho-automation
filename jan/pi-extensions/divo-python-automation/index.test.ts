import assert from "node:assert/strict";
import { describe, it } from "node:test";
import extension, { runDivoPythonProgram } from "./index.ts";

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
});
