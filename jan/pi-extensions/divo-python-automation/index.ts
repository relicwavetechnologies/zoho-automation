/**
 * One-process Python workflows over the backend-owned Divo gateway.
 *
 * Model-authored Python runs as a normal local Python process. It never receives
 * the member token or SaaS credentials; a small injected client relays governed
 * company-tool requests to this extension over a private stdio channel. Node
 * performs those requests through the same gateway path as divo_gateway,
 * including local approval, while the backend remains authoritative for RBAC,
 * shared-connection approval, rate limits, audit, credentials, and validation.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ApprovalContext } from "../divo-gateway/approval-gate.ts";
import {
	executeGatewayRequest,
} from "../divo-gateway/gateway-execution.ts";
import {
	resolveDivoGatewayConfig,
	type GatewayRequestBody,
	type GatewayResponseBody,
} from "../divo-gateway/gateway-client.ts";
import { readDivoRunCorrelation } from "../divo-gateway/run-correlation.ts";

const MAX_CODE_CHARS = 32_000;
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_PROTOCOL_BYTES = 2 * 1024 * 1024;
const EXECUTION_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_RESULT_TEXT_CHARS = 24_000;
const MAX_PROCESS_OUTPUT_CHARS = 24_000;

const DivoPythonParams = Type.Object({
	title: Type.String({
		description: "Short visible worklog title describing the outcome, e.g. 'Organize Gmail leads in Google Sheets'.",
		minLength: 3,
		maxLength: 140,
	}),
	summary: Type.String({
		description: "One plain-language sentence describing the complete workflow this single Python run will perform.",
		minLength: 3,
		maxLength: 2_000,
	}),
	code: Type.String({
		description: "Normal Python 3 code defining run(input_data, divo). Standard imports, installed packages, files, subprocesses, print, and networking are available. Use the supplied divo client for governed company-tool calls; credentials and raw member/OAuth tokens are never exposed. Keep one coherent workflow in one run and loop inside the program.",
		minLength: 1,
		maxLength: MAX_CODE_CHARS,
	}),
	input: Type.Unknown({
		description: "Optional non-secret JSON seed data for the workflow. Use {} when the program will obtain its source data through divo.",
	}),
	departmentId: Type.Optional(Type.String({
		description: "Department owning the work. Omit only when the desktop already has the correct active department.",
	})),
});

export type DivoPythonParams = {
	title: string;
	summary: string;
	code: string;
	input: unknown;
	departmentId?: string;
};

export type PythonGatewayHandler = (
	request: GatewayRequestBody,
	callIndex: number,
) => Promise<GatewayResponseBody>;

export type DivoPythonProgramResult = {
	result: unknown;
	gatewayCallCount: number;
	calls: Array<{ op: string; toolId?: string; status: string; ok: boolean }>;
	stdout?: string;
	stderr?: string;
};

type ToolUpdate = {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
};

type ProtocolMessage =
	| { type: "gateway_call"; op: string; payload: Record<string, unknown> }
	| { type: "result"; result: unknown }
	| { type: "failure"; errorType?: string; message: string };

export default function divoPythonAutomationExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "divo_python_automation",
		label: "Divo Python workflow",
		description: "Run one coherent workflow as normal local Python. Imports, installed packages, files, subprocesses, print, and networking work normally. Governed company-tool calls use the supplied Divo client and still receive backend RBAC, connection-policy, approval, audit, schema, and rate-limit enforcement; Python receives no member token or SaaS credential.",
		promptSnippet: "Use divo_python_automation for a multi-step data workflow where Python materially simplifies fetching, pagination, transformation, grouping, deduplication, or several related writes. One outcome should normally use one Python run. Use divo_gateway directly for a simple single call.",
		promptGuidelines: [
			"One coherent outcome equals one divo_python_automation call. Put source reads, pagination, transformations, grouping, deduplication, and related destination writes in the same run(input_data, divo) program. Loop inside Python; never start separate Python runs per page, row, tab, domain, tool call, or small phase.",
			"Use divo_python_automation only when Python adds real value. For one straightforward read or one create/update/send, call divo_gateway directly.",
			"The supplied divo client provides divo.connections(provider), divo.tool(tool_id), divo.invoke(tool_id, args), divo.require(op, payload), and divo.gateway(op, payload). divo.invoke returns { toolId, action, result }; native tool data is at response['result']['data']. Convenience methods raise an exact DivoGatewayError on gateway rejection; gateway returns the full structured response when deliberate branching is required.",
			"Write ordinary Python. Standard imports, installed packages, print, local files, subprocesses, and direct networking are available. Use divo—not raw backend HTTP—for connected company tools because Python does not receive Divo member tokens or SaaS credentials.",
			"Read and validate all required source data first, transform it in memory, then perform writes. This reduces partial completion. Return a concise JSON result describing counts, destinations, and created identifiers.",
			"Never execute a create, send, update, or delete merely to discover its response shape. Use divo.tool or a read/describe operation first. Once a mutation reports success, retain its returned identifier and never repeat it because downstream parsing failed; verify the created resource with a read operation instead.",
			"After destination writes, read back the important destination range or records in the same Python run. Report success only after verification; otherwise report partial completion with the already-created identifier so a retry cannot silently duplicate it.",
			"Every connection-backed call must use an exact connectionId obtained through divo.connections. Never guess an account, credential, backend URL, member token, or OAuth token.",
			"Do not blindly retry permission_denied, approval_required, approval_rejected, local approval denial, invalid_args, or rate_limited. Stop and return or surface the exact status. Retry only an unmistakably transient upstream/network failure, at most once.",
			"Split into another Python run only when the current run must stop for material user clarification or an external approval, or when the user requested genuinely independent workflows. Do not fragment a simple workflow for narration or progress reporting.",
			"Use a specific title such as 'Organize Gmail leads in Google Sheets'. Never use generic titles such as 'Run Python', 'Execute script', or 'Process data'.",
		],
		parameters: DivoPythonParams,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const update = (phase: string, detail: string, extra: Record<string, unknown> = {}) => {
				(onUpdate as ((value: ToolUpdate) => void) | undefined)?.({
					content: [{ type: "text", text: `${phase}\n${detail}` }],
					details: { title: params.title, phase, detail, ...extra },
				});
			};

			try {
				const config = resolveDivoGatewayConfig();
				if ("error" in config) throw new Error(config.error);
				const correlation = await readDivoRunCorrelation();
				update(`Running ${params.title}`, params.summary);

				const program = await runDivoPythonProgram(
					params,
					signal,
					async (request, callIndex) => {
						const operation = describeGatewayRequest(request);
						update(`Running ${params.title}`, `${operation} · call ${callIndex}`, {
							gatewayCall: callIndex,
							gatewayOperation: operation,
						});
						try {
							const actionId = `${toolCallId}:python:${callIndex}`.slice(0, 256);
							const executed = await executeGatewayRequest(
								config,
								{
									op: request.op,
									...(params.departmentId ? { departmentId: params.departmentId } : {}),
									payload: request.payload,
									execution: {
										version: 1,
										threadId: correlation.threadId,
										runId: correlation.runId,
										actionId,
									},
								},
								actionId,
								ctx as ApprovalContext,
							);
							return executed.body;
						} catch (error) {
							const message = error instanceof Error ? error.message : String(error);
							return {
								ok: false,
								status: "tool_error",
								error: { code: "python_gateway_bridge_error", message },
							};
						}
					},
				);

				update(`Completed ${params.title}`, `${program.gatewayCallCount} governed gateway call${program.gatewayCallCount === 1 ? "" : "s"}`);
				return {
					content: [{
						type: "text" as const,
						text: formatProgramResult(params.title, program),
					}],
					details: {
						title: params.title,
						phase: "Completed",
						gatewayCallCount: program.gatewayCallCount,
						calls: program.calls,
						result: program.result,
						...(program.stdout ? { stdout: program.stdout } : {}),
						...(program.stderr ? { stderr: program.stderr } : {}),
					},
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				update(`Failed ${params.title}`, message);
				return {
					content: [{ type: "text" as const, text: `Python workflow failed.\n\n${message}` }],
					details: { title: params.title, phase: "Failed", message },
					isError: true,
				};
			}
		},
	});
}

/** Exported for focused runtime tests; all gateway authority stays in handler. */
export async function runDivoPythonProgram(
	params: DivoPythonParams,
	signal: AbortSignal,
	handleGateway: PythonGatewayHandler,
): Promise<DivoPythonProgramResult> {
	if (signal.aborted) throw new Error("Python workflow was cancelled before it started.");
	if (params.code.length > MAX_CODE_CHARS) throw new Error(`Python code exceeds ${MAX_CODE_CHARS} characters.`);
	const inputJson = JSON.stringify(params.input);
	if (Buffer.byteLength(inputJson, "utf8") > MAX_INPUT_BYTES) {
		throw new Error(`Input exceeds the ${Math.floor(MAX_INPUT_BYTES / 1024 / 1024)} MB limit. Fetch bounded pages through the Divo client inside one run instead.`);
	}

	const directory = await mkdtemp(join(tmpdir(), "divo-python-"));
	const runnerPath = join(directory, "runner.py");
	const inputPath = join(directory, "input.json");
	try {
		await Promise.all([
			writeFile(runnerPath, buildRunner(params.code), { encoding: "utf8", mode: 0o600 }),
			writeFile(inputPath, inputJson, { encoding: "utf8", mode: 0o600 }),
		]);
		return await runDirectPython(directory, runnerPath, signal, handleGateway);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

function buildRunner(userCode: string): string {
	return `import json\nimport os\nimport sys\nimport traceback\n\nUSER_CODE = ${JSON.stringify(userCode)}\nPROTOCOL = os.fdopen(3, 'w', encoding='utf-8', buffering=1)\n\ndef emit(message):\n  PROTOCOL.write(json.dumps(message, ensure_ascii=False) + '\\n')\n  PROTOCOL.flush()\n\nclass DivoGatewayError(RuntimeError):\n  def __init__(self, response):\n    self.response = response\n    status = str(response.get('status') or 'tool_error')\n    error = response.get('error') if isinstance(response.get('error'), dict) else {}\n    approval = response.get('approval') if isinstance(response.get('approval'), dict) else {}\n    message = error.get('message') or approval.get('message') or 'The gateway rejected this call.'\n    super().__init__(status + ': ' + str(message))\n\nclass DivoClient:\n  def gateway(self, op, payload=None):\n    if not isinstance(op, str) or not op.strip():\n      raise ValueError('divo.gateway requires a non-empty op.')\n    if payload is None:\n      payload = {}\n    if not isinstance(payload, dict):\n      raise ValueError('divo.gateway payload must be a dict.')\n    emit({'type': 'gateway_call', 'op': op, 'payload': payload})\n    line = sys.stdin.readline()\n    if not line:\n      raise RuntimeError('The Divo gateway bridge closed before returning a response.')\n    envelope = json.loads(line)\n    response = envelope.get('body') if isinstance(envelope, dict) else None\n    if not isinstance(response, dict):\n      raise RuntimeError('The Divo gateway bridge returned an invalid response.')\n    return response\n\n  def require(self, op, payload=None):\n    response = self.gateway(op, payload)\n    if not response.get('ok') or response.get('status') != 'success':\n      raise DivoGatewayError(response)\n    return response.get('data')\n\n  def connections(self, provider):\n    return self.require('connections.list', {'provider': provider})\n\n  def tool(self, tool_id):\n    return self.require('tools.list', {'toolId': tool_id})\n\n  def invoke(self, tool_id, args):\n    if not isinstance(tool_id, str) or not tool_id.strip():\n      raise ValueError('divo.invoke requires a non-empty tool_id.')\n    if not isinstance(args, dict):\n      raise ValueError('divo.invoke args must be a dict.')\n    return self.require('tools.invoke', {'toolId': tool_id, 'args': args})\n\ntry:\n  with open('input.json', 'r', encoding='utf-8') as handle:\n    input_data = json.load(handle)\n  program_scope = {'__name__': '__divo_workflow__', '__file__': '<divo-python-workflow>'}\n  exec(compile(USER_CODE, '<divo-python-workflow>', 'exec'), program_scope, program_scope)\n  run = program_scope.get('run')\n  if not callable(run):\n    raise ValueError('Define run(input_data, divo) in the Python code.')\n  result = run(input_data, DivoClient())\n  json.dumps(result, ensure_ascii=False)\n  emit({'type': 'result', 'result': result})\nexcept Exception as exc:\n  traceback.print_exc(file=sys.stderr)\n  emit({'type': 'failure', 'errorType': type(exc).__name__, 'message': str(exc)})\n  sys.exit(1)\n`;
}

async function runDirectPython(
	directory: string,
	runnerPath: string,
	signal: AbortSignal,
	handleGateway: PythonGatewayHandler,
): Promise<DivoPythonProgramResult> {
	const pythonExecutable = process.env.DIVO_PYTHON_EXECUTABLE?.trim()
		|| (process.platform === "win32" ? "python" : "python3");
	const child = spawn(pythonExecutable, [runnerPath], {
		cwd: directory,
		env: process.env,
		// fd 3 is reserved for the JSON bridge so ordinary print() output can use
		// stdout without corrupting the protocol.
		stdio: ["pipe", "pipe", "pipe", "pipe"],
	});

	let stdout = "";
	let stderr = "";
	let protocolBytes = 0;
	let resultValue: unknown;
	let failure: string | undefined;
	let gatewayCallCount = 0;
	const calls: DivoPythonProgramResult["calls"] = [];
	let timedOut = false;
	const kill = () => child.kill("SIGTERM");
	signal.addEventListener("abort", kill, { once: true });
	const timeout = setTimeout(() => {
		timedOut = true;
		child.kill("SIGKILL");
	}, EXECUTION_TIMEOUT_MS);
	child.stderr.on("data", chunk => {
		stderr = `${stderr}${String(chunk)}`.slice(-MAX_PROCESS_OUTPUT_CHARS);
	});
	child.stdout.on("data", chunk => {
		stdout = `${stdout}${String(chunk)}`.slice(-MAX_PROCESS_OUTPUT_CHARS);
	});

	const exit = new Promise<{ code: number | null; error?: Error }>(resolve => {
		child.once("error", error => resolve({ code: null, error }));
		child.once("close", code => resolve({ code }));
	});

	try {
		const protocolStream = child.stdio[3];
		if (!protocolStream) throw new Error("Python workflow protocol channel was not created.");
		const lines = createInterface({ input: protocolStream as NodeJS.ReadableStream, crlfDelay: Infinity });
		for await (const line of lines) {
			protocolBytes += Buffer.byteLength(line, "utf8");
			if (protocolBytes > MAX_PROTOCOL_BYTES) {
				child.kill("SIGKILL");
				throw new Error("Python workflow protocol exceeded the 2 MB safety limit.");
			}
			const message = parseProtocolMessage(line);
			if (message.type === "gateway_call") {
				gatewayCallCount += 1;
				const request: GatewayRequestBody = { op: message.op, payload: message.payload };
				const body = await handleGateway(request, gatewayCallCount);
				const toolId = readToolId(message.payload);
				calls.push({
					op: message.op,
					...(toolId ? { toolId } : {}),
					status: body.status,
					ok: body.ok,
				});
				child.stdin.write(`${JSON.stringify({ body })}\n`);
				continue;
			}
			if (message.type === "result") resultValue = message.result;
			if (message.type === "failure") {
				failure = `${message.errorType ? `${message.errorType}: ` : ""}${message.message}`;
			}
		}

		const exited = await exit;
		if (exited.error) throw exited.error;
		if (signal.aborted) throw new Error("Python workflow was cancelled.");
		if (timedOut) throw new Error("Python workflow exceeded the 5 minute execution limit.");
		if (failure) throw new Error(failure);
		if (exited.code !== 0) {
			throw new Error(`Python workflow exited with code ${exited.code ?? "unknown"}${stderr.trim() ? `: ${stderr.trim().slice(0, 1_500)}` : "."}`);
		}
		if (resultValue === undefined) throw new Error("Python workflow ended without returning a result.");
		return {
			result: resultValue,
			gatewayCallCount,
			calls,
			...(stdout.trim() ? { stdout: stdout.trim() } : {}),
			...(stderr.trim() ? { stderr: stderr.trim() } : {}),
		};
	} finally {
		clearTimeout(timeout);
		signal.removeEventListener("abort", kill);
		child.stdin.destroy();
	}
}

function parseProtocolMessage(line: string): ProtocolMessage {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		throw new Error("Python workflow emitted non-protocol output. Return data instead of printing to stdout.");
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Python workflow emitted an invalid protocol message.");
	}
	const record = value as Record<string, unknown>;
	if (record.type === "gateway_call") {
		if (typeof record.op !== "string" || !record.op.trim()) throw new Error("Python workflow requested an empty gateway op.");
		if (!record.payload || typeof record.payload !== "object" || Array.isArray(record.payload)) {
			throw new Error("Python workflow gateway payload must be an object.");
		}
		return { type: "gateway_call", op: record.op, payload: record.payload as Record<string, unknown> };
	}
	if (record.type === "result") return { type: "result", result: record.result };
	if (record.type === "failure" && typeof record.message === "string") {
		return {
			type: "failure",
			...(typeof record.errorType === "string" ? { errorType: record.errorType } : {}),
			message: record.message,
		};
	}
	throw new Error("Python workflow emitted an unknown protocol message.");
}

function readToolId(payload: Record<string, unknown>): string | undefined {
	return typeof payload.toolId === "string" && payload.toolId.trim() ? payload.toolId : undefined;
}

function describeGatewayRequest(request: GatewayRequestBody): string {
	const payload = request.payload && typeof request.payload === "object" && !Array.isArray(request.payload)
		? request.payload as Record<string, unknown>
		: undefined;
	const toolId = payload ? readToolId(payload) : undefined;
	const args = payload?.args && typeof payload.args === "object" && !Array.isArray(payload.args)
		? payload.args as Record<string, unknown>
		: undefined;
	const operation = typeof args?.operation === "string"
		? args.operation
		: typeof args?.op === "string"
			? args.op
			: undefined;
	return [toolId ?? request.op, operation].filter(Boolean).join(" · ");
}

function formatProgramResult(title: string, program: DivoPythonProgramResult): string {
	let serialized: string;
	try {
		serialized = JSON.stringify(program.result, null, 2);
	} catch {
		serialized = String(program.result);
	}
	if (serialized.length > MAX_RESULT_TEXT_CHARS) {
		serialized = `${serialized.slice(0, MAX_RESULT_TEXT_CHARS)}\n… result truncated in chat`;
	}
	const lines = [
		`Completed ${title}.`,
		`Gateway calls: ${program.gatewayCallCount}`,
		"",
		serialized,
	];
	if (program.stdout) lines.push("", "Python output:", program.stdout);
	return lines.join("\n");
}
