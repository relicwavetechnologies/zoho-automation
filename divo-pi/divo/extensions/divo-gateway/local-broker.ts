import type {
	ExtensionAPI,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { authorizeToolInvocation, type LoadedSkillLookup } from "./skill-authorization.ts";
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
import { readDivoRunCorrelation } from "./run-correlation.ts";

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
	nextBrokerCall: number;
}

export interface LocalBrokerExecutionDependencies {
	resolveConfig: typeof resolveDivoGatewayConfig;
	readCorrelation: typeof readDivoRunCorrelation;
	executeGateway: typeof executeGatewayRequest;
	/**
	 * Which skill registered a tool in this run. Supplied by the extension that
	 * owns the registry, so the broker enforces the same gate as the tool path
	 * instead of trusting whatever a script sends.
	 */
	lookupLoadedSkill: LoadedSkillLookup;
}

export const DEFAULT_EXECUTION_DEPENDENCIES: LocalBrokerExecutionDependencies = {
	resolveConfig: resolveDivoGatewayConfig,
	readCorrelation: readDivoRunCorrelation,
	executeGateway: executeGatewayRequest,
	// No registry wired means nothing was ever loaded, so every invocation is
	// refused. Failing closed is the only safe default for an authorization gate.
	lookupLoadedSkill: () => undefined,
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
	return {
		version: 1,
		...(cleanString(input.label, 120) ? { label: cleanString(input.label, 120) } : {}),
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
		active.nextBrokerCall += 1;
		const actionId = `${active.toolCallId}:broker:${active.nextBrokerCall}`;
		const label = brokerLabel(input);
		// Same gate the divo_gateway tool applies. A script reaching the backend
		// through this socket has no more authority than the model calling the
		// tool directly, and the skillId is taken from what was actually loaded.
		const payload = asRecord(input.request.payload);
		const authorization = authorizeToolInvocation({
			op: input.request.op,
			toolId: payload?.["toolId"],
			runId: correlation.runId,
			lookup: dependencies.lookupLoadedSkill,
			scheduling: payload?.["toolId"] === "scheduledWorkflows",
		});
		if (authorization && !authorization.ok) {
			throw new Error(authorization.message);
		}
		const authorizedPayload = authorization?.ok
			? { ...(payload ?? {}), skillId: authorization.skillId }
			: input.request.payload;

		const request: GatewayRequestBody = {
			op: input.request.op,
			...(input.request.departmentId || correlation.departmentId
				? { departmentId: input.request.departmentId ?? correlation.departmentId }
				: {}),
			...(Object.hasOwn(input.request, "payload") ? { payload: authorizedPayload } : {}),
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

	pi.on("tool_call", (event: ToolCallEvent, ctx) => {
		if (event.toolName !== "bash") return undefined;
		activeCalls.set(event.toolCallId, {
			toolCallId: event.toolCallId,
			context: ctx,
			nextBrokerCall: 0,
		});
		return undefined;
	});

	pi.on("tool_execution_end", (event) => {
		if (event.toolName === "bash") activeCalls.delete(event.toolCallId);
	});

	pi.on("session_start", async (_event, ctx) => {
		if (server) return;
		const resolved = resolveDivoGatewayConfig();
		if ("error" in resolved) return;
		try {
			cliDirectory = await mkdtemp(join(tmpdir(), "divo-cli-"));
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
