import type {
	ExtensionAPI,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { ApprovalContext } from "./approval-gate.ts";
import { executeGatewayRequest } from "./gateway-execution.ts";
import {
	resolveDivoGatewayConfig,
	type GatewayRequestBody,
	type GatewayResponseBody,
} from "./gateway-client.ts";
import { readDivoRunCorrelation, type DivoRunCorrelationV1 } from "./run-correlation.ts";

const BROKER_PROTOCOL_VERSION = 1;
const MAX_REQUEST_BYTES = 1_000_000;
const ALLOWED_BROKER_OPS = new Set([
	"connections.list",
	"tools.list",
	"tools.invoke",
]);

export const DIVO_LOCAL_BROKER_SOCKET_ENV = "DIVO_LOCAL_BROKER_SOCKET";

type JsonRecord = Record<string, unknown>;

export interface LocalBrokerRequestV1 {
	version: 1;
	label?: string;
	resultMode?: "local-file";
	request: {
		op: string;
		departmentId?: string;
		payload?: unknown;
	};
}

export interface LocalBrokerResponseV1 {
	version: 1;
	ok: boolean;
	status: string;
	httpStatus: number;
	data?: unknown;
	error?: GatewayResponseBody["error"];
	approval?: GatewayResponseBody["approval"];
	trace: {
		threadId: string;
		runId: string;
		actionId: string;
		label: string;
	};
}

export interface ActiveBashCall {
	toolCallId: string;
	context: ApprovalContext;
	correlation: DivoRunCorrelationV1;
	nextBrokerCall: number;
}

export interface LocalBrokerExecutionDependencies {
	resolveConfig: typeof resolveDivoGatewayConfig;
	readCorrelation: typeof readDivoRunCorrelation;
	executeGateway: typeof executeGatewayRequest;
}

export const DEFAULT_EXECUTION_DEPENDENCIES: LocalBrokerExecutionDependencies = {
	resolveConfig: resolveDivoGatewayConfig,
	readCorrelation: readDivoRunCorrelation,
	executeGateway: executeGatewayRequest,
};

function asRecord(value: unknown): JsonRecord | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as JsonRecord
		: undefined;
}

function cleanString(value: unknown, maxLength = 200): string | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	return value.trim().slice(0, maxLength);
}

function brokerLabel(input: LocalBrokerRequestV1): string {
	const explicit = cleanString(input.label, 120);
	if (explicit) return explicit;
	const payload = asRecord(input.request.payload);
	const toolId = cleanString(payload?.toolId, 80);
	const args = asRecord(payload?.args);
	const action = cleanString(args?.operation, 50)
		?? cleanString(args?.op, 50)
		?? cleanString(args?.action, 50);
	if (toolId) return action ? `${toolId} · ${action}` : toolId;
	return input.request.op;
}

export function parseLocalBrokerRequest(value: unknown): LocalBrokerRequestV1 {
	const input = asRecord(value);
	const request = asRecord(input?.request);
	const op = cleanString(request?.op);
	if (input?.version !== BROKER_PROTOCOL_VERSION || !request || !op) {
		throw new Error("Invalid Divo local broker request. Expected protocol version 1 and request.op.");
	}
	if (!ALLOWED_BROKER_OPS.has(op)) {
		throw new Error(`Divo local broker operation "${op}" is not exposed.`);
	}
	if (input.resultMode !== undefined && input.resultMode !== "local-file") {
		throw new Error("Invalid Divo local broker result mode.");
	}
	if (input.resultMode === "local-file" && op !== "tools.invoke") {
		throw new Error("Local-file results are available only for tools.invoke.");
	}
	return {
		version: 1,
		...(cleanString(input.label, 120) ? { label: cleanString(input.label, 120) } : {}),
		...(input.resultMode === "local-file" ? { resultMode: "local-file" as const } : {}),
		request: {
			op,
			...(cleanString(request.departmentId) ? { departmentId: cleanString(request.departmentId) } : {}),
			...(Object.hasOwn(request, "payload") ? { payload: request.payload } : {}),
		},
	};
}

export async function executeLocalBrokerRequest(
	value: unknown,
	activeCalls: ReadonlyMap<string, ActiveBashCall>,
	dependencies: LocalBrokerExecutionDependencies = DEFAULT_EXECUTION_DEPENDENCIES,
	requestSignal?: AbortSignal,
): Promise<LocalBrokerResponseV1> {
	const input = parseLocalBrokerRequest(value);
	if (activeCalls.size !== 1) {
		throw new Error(activeCalls.size === 0
			? "Divo local broker calls must run from an active, locally approved Bash command."
			: "Concurrent Bash commands cannot share one Divo broker authorization context.");
	}
	const active = activeCalls.values().next().value as ActiveBashCall;
	const combinedSignal = combineAbortSignals(active.context.signal, requestSignal);
	if (combinedSignal.signal?.aborted) {
		combinedSignal.dispose();
		throw new DOMException("The Divo broker request was cancelled.", "AbortError");
	}
	try {
		const config = dependencies.resolveConfig();
		if ("error" in config) throw new Error(config.error);
		const correlation = await dependencies.readCorrelation();
		if (!sameCorrelation(correlation, active.correlation)) {
			throw new Error("Divo run context changed after this Bash command started; the broker request was rejected.");
		}
		active.nextBrokerCall += 1;
		const actionId = `${active.toolCallId}:broker:${active.nextBrokerCall}`;
		const label = brokerLabel(input);
		// A script reaching the backend through this socket has no more authority
		// than the model. Ignore any caller-supplied legacy skill provenance; the
		// backend checks identity, RBAC, schema, connection access, and approval.
		const payload = asRecord(input.request.payload);
		let trustedPayload = input.request.payload;
		if (input.request.op === "tools.invoke" && payload) {
			trustedPayload = { ...payload };
			delete trustedPayload.skillId;
		}
		if (
			input.request.op === "tools.invoke"
			&& (payload?.["toolId"] === "shopifyOrders" || payload?.["toolId"] === "shopifyCustomers")
		) {
			throw new Error("Protected Shopify record tools must be called directly through divo_gateway; divo-local cannot retain or print their results.");
		}
		const request: GatewayRequestBody = {
			op: input.request.op,
			...(input.request.departmentId || correlation.departmentId
				? { departmentId: input.request.departmentId ?? correlation.departmentId }
				: {}),
			...(Object.hasOwn(input.request, "payload") ? { payload: trustedPayload } : {}),
			execution: {
				version: 1,
				threadId: correlation.threadId,
				runId: correlation.runId,
				actionId,
			},
		};
		const result = await dependencies.executeGateway(
			config,
			request,
			actionId,
				{
					...active.context,
					...(combinedSignal.signal ? { signal: combinedSignal.signal } : {}),
					...(correlation.channel ? { runtimeChannel: correlation.channel } : {}),
					...(input.resultMode ? { resultMode: input.resultMode } : {}),
				},
		);
		return {
			version: 1,
			ok: result.body.ok && result.body.status === "success",
			status: result.body.status,
			httpStatus: result.httpStatus,
			...(Object.hasOwn(result.body, "data") ? { data: result.body.data } : {}),
			...(result.body.error ? { error: result.body.error } : {}),
			...(result.body.approval ? { approval: result.body.approval } : {}),
			trace: {
				threadId: correlation.threadId,
				runId: correlation.runId,
				actionId,
				label,
			},
		};
	} finally {
		combinedSignal.dispose();
	}
}

function sameCorrelation(left: DivoRunCorrelationV1, right: DivoRunCorrelationV1): boolean {
	return left.threadId === right.threadId
		&& left.runId === right.runId
		&& left.departmentId === right.departmentId
		&& left.channel === right.channel;
}

function combineAbortSignals(...signals: Array<AbortSignal | undefined>): {
	signal?: AbortSignal;
	dispose: () => void;
} {
	const present = signals.filter((signal): signal is AbortSignal => Boolean(signal));
	if (present.length === 0) return { dispose: () => undefined };
	if (present.length === 1) return { signal: present[0], dispose: () => undefined };
	const controller = new AbortController();
	const abort = () => controller.abort();
	for (const signal of present) {
		if (signal.aborted) controller.abort();
		else signal.addEventListener("abort", abort, { once: true });
	}
	return {
		signal: controller.signal,
		dispose: () => {
			for (const signal of present) signal.removeEventListener("abort", abort);
		},
	};
}

function writeJsonLine(socket: Socket, value: unknown): void {
	socket.end(`${JSON.stringify(value)}\n`);
}

function errorResponse(error: unknown): JsonRecord {
	const isAbort = error instanceof DOMException && error.name === "AbortError";
	return {
		version: 1,
		ok: false,
		status: isAbort ? "cancelled" : "broker_error",
		httpStatus: 0,
		error: {
			code: isAbort ? "cancelled" : "local_broker_error",
			message: error instanceof Error ? error.message : String(error),
		},
	};
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Whether this runtime offers the `divo-local` CLI at all.
 *
 * The CLI exists so a workflow can page through a large record set
 * from one persistent Python file without every row landing in the model's
 * context. Cloud `/tmp` is `noexec`, so launchers are staged in the
 * runtime-owned home there; the socket itself can remain under `/tmp`.
 */
export function localCliEnabled(): boolean {
	return process.env["DIVO_LOCAL_CLI_DISABLED"] !== "1";
}

async function writeCliLaunchers(directory: string): Promise<void> {
	const cliPath = join(import.meta.dirname, "local-broker-cli.mjs");
	const unixPath = join(directory, "divo-local");
	await writeFile(
		unixPath,
		`#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(cliPath)} "$@"\n`,
		{ mode: 0o700 },
	);
	await writeFile(
		join(directory, "divo-local.cmd"),
		`@echo off\r\n"${process.execPath.replaceAll('"', '""')}" "${cliPath.replaceAll('"', '""')}" %*\r\n`,
	);
}

function socketAddress(): string {
	const nonce = randomBytes(8).toString("hex");
	return process.platform === "win32"
		? `\\\\.\\pipe\\divo-local-${process.pid}-${nonce}`
		: join(tmpdir(), `divo-${process.pid}-${nonce}.sock`);
}

export function registerLocalDivoBroker(
	pi: ExtensionAPI,
	dependencies: LocalBrokerExecutionDependencies = DEFAULT_EXECUTION_DEPENDENCIES,
): void {
	const activeCalls = new Map<string, ActiveBashCall>();
	let server: Server | undefined;
	let socketPath: string | undefined;
	let cliDirectory: string | undefined;
	const originalPath = process.env.PATH;
	const originalSocket = process.env[DIVO_LOCAL_BROKER_SOCKET_ENV];

	async function stopBroker(): Promise<void> {
		activeCalls.clear();
		if (server) {
			const openServer = server;
			if (openServer.listening) {
				await new Promise<void>((resolve) => openServer.close(() => resolve()));
			}
			server = undefined;
		}
		if (socketPath && process.platform !== "win32") await rm(socketPath, { force: true });
		if (cliDirectory) await rm(cliDirectory, { recursive: true, force: true });
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		if (originalSocket === undefined) delete process.env[DIVO_LOCAL_BROKER_SOCKET_ENV];
		else process.env[DIVO_LOCAL_BROKER_SOCKET_ENV] = originalSocket;
		socketPath = undefined;
		cliDirectory = undefined;
	}

	pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
		if (event.toolName !== "bash") return undefined;
		const correlation = await dependencies.readCorrelation();
		activeCalls.set(event.toolCallId, {
			toolCallId: event.toolCallId,
			context: ctx,
			correlation,
			nextBrokerCall: 0,
		});
		return undefined;
	});

	pi.on("tool_execution_end", (event) => {
		if (event.toolName === "bash") activeCalls.delete(event.toolCallId);
	});

	pi.on("session_start", async (_event, ctx) => {
		if (server) return;
		// No socket, no launchers, no PATH entry: when explicitly disabled the CLI
		// is absent. Say so in the log, because an absence
		// nobody records is one nobody notices — this stayed invisible for four
		// days while the prompt kept prescribing the client it had removed.
		if (!localCliEnabled()) {
			console.error("[divo-gateway] local CLI disabled for this channel; divo-local will not exist");
			return;
		}
		const resolved = resolveDivoGatewayConfig();
		if ("error" in resolved) {
			console.error(`[divo-gateway] local broker not started: ${resolved.error}`);
			ctx.ui.notify(`Divo local execution is unavailable: ${resolved.error}`, "warning");
			return;
		}
		try {
			const launcherRoot = process.env["DIVO_HOME"] || tmpdir();
			cliDirectory = await mkdtemp(join(launcherRoot, "divo-cli-"));
			await writeCliLaunchers(cliDirectory);
			socketPath = socketAddress();
			server = createServer((socket) => {
				let input = "";
				let handled = false;
				let completed = false;
				const requestAbort = new AbortController();
				const abortDisconnectedRequest = () => {
					if (!completed) requestAbort.abort();
				};
				socket.on("error", abortDisconnectedRequest);
				socket.on("close", abortDisconnectedRequest);
				socket.setEncoding("utf8");
				socket.on("data", async (chunk) => {
					input += chunk;
					if (Buffer.byteLength(input, "utf8") > MAX_REQUEST_BYTES) {
						handled = true;
						writeJsonLine(socket, errorResponse(new Error("Divo broker request exceeds 1 MB.")));
						return;
					}
					if (handled || !input.includes("\n")) return;
					handled = true;
					try {
						const line = input.slice(0, input.indexOf("\n")).trim();
						if (!line) throw new Error("Divo broker request was empty.");
						const response = await executeLocalBrokerRequest(
							JSON.parse(line),
							activeCalls,
							dependencies,
							requestAbort.signal,
						);
						completed = true;
						writeJsonLine(socket, response);
					} catch (error) {
						completed = true;
						writeJsonLine(socket, errorResponse(error));
					}
				});
			});
			await new Promise<void>((resolve, reject) => {
				server?.once("error", reject);
				server?.listen(socketPath, resolve);
			});
			if (process.platform !== "win32") await chmod(socketPath, 0o600);
			process.env.PATH = `${cliDirectory}${delimiter}${originalPath ?? ""}`;
			process.env[DIVO_LOCAL_BROKER_SOCKET_ENV] = socketPath;
		} catch (error) {
			await stopBroker();
			ctx.ui.notify(
				`Divo local execution is unavailable: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		}
	});

	pi.on("session_shutdown", stopBroker);
}
