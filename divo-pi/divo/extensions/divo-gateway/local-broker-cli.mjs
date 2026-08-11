#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { normalizeLocalInvokeResponse } from "./local-broker-response.mjs";

function usage(message) {
	if (message) process.stderr.write(`${message}\n\n`);
	process.stderr.write([
		"Divo governed company-call client",
		"",
		"  divo-local call <toolId>.<nativeTool> (--input-json <json> | --input-file <path>) [--connection-id <uuid>] [--output <run-path>] [--label <text>]",
		"  divo-local describe <toolId>.<nativeTool> [--connection-id <uuid>] [--output <run-path>] [--label <text>]",
		"  divo-local invoke --tool <toolId> (--args-json <json> | --args-file <path>) [--output <run-path>] [--label <text>]",
		"  divo-local request --op <connections.list|tools.list> (--payload-json <json> | --payload-file <path>)",
		"",
		"The client contains no member or SaaS credentials. The local Divo broker applies runtime approval and the backend applies RBAC, connection policy, rate limits, manager approval, and audit.",
	].join("\n"));
	process.exit(2);
}

function parseOptions(values) {
	const options = {};
	for (let index = 0; index < values.length; index += 2) {
		const key = values[index];
		const value = values[index + 1];
		if (!key?.startsWith("--") || value === undefined) usage(`Invalid option ${key ?? ""}`);
		options[key.slice(2)] = value;
	}
	return options;
}

function parseNativeSpec(value) {
	if (!value || value.startsWith("--")) usage("Expected <toolId>.<nativeTool>.");
	const parts = value.split(".");
	if (parts.length !== 2 || !parts[0] || !parts[1]) usage("Use <toolId>.<nativeTool>, for example googleSheets.create_spreadsheet.");
	const [toolId, nativeTool] = parts;
	if (!/^[A-Za-z][A-Za-z0-9]*$/.test(toolId)) usage(`Invalid toolId in ${value}.`);
	if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(nativeTool)) usage(`Invalid nativeTool in ${value}.`);
	return { toolId, nativeTool };
}

async function readJson(options, inlineKey, fileKey, fallback) {
	const inline = options[inlineKey];
	const file = options[fileKey];
	if (inline && file) usage(`Use only --${inlineKey} or --${fileKey}.`);
	const raw = inline ?? (file ? await readFile(file, "utf8") : undefined);
	if (raw === undefined) return fallback;
	try {
		return JSON.parse(raw);
	} catch (error) {
		usage(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

const [command, ...rest] = process.argv.slice(2);
if (!command || !["call", "describe", "invoke", "request"].includes(command)) usage();
const nativeSpec = command === "call" || command === "describe" ? parseNativeSpec(rest[0]) : undefined;
const options = parseOptions(nativeSpec ? rest.slice(1) : rest);
let request;
if (command === "call") {
	if (options["args-json"] || options["args-file"] || options.tool || options.op) {
		usage("call uses --input-json or --input-file with <toolId>.<nativeTool>; do not pass --tool, --op, or --args-file.");
	}
	request = {
		op: "tools.invoke",
		payload: {
			toolId: nativeSpec.toolId,
			args: {
				...(options["connection-id"] ? { connectionId: options["connection-id"] } : {}),
				op: "call",
				nativeTool: nativeSpec.nativeTool,
				input: await readJson(options, "input-json", "input-file", {}),
			},
		},
	};
} else if (command === "describe") {
	if (options["args-json"] || options["args-file"] || options["input-json"] || options["input-file"] || options.tool || options.op) {
		usage("describe takes only <toolId>.<nativeTool>, optional --connection-id, --output, and --label.");
	}
	request = {
		op: "tools.invoke",
		payload: {
			toolId: nativeSpec.toolId,
			args: {
				...(options["connection-id"] ? { connectionId: options["connection-id"] } : {}),
				op: "describe",
				nativeTool: nativeSpec.nativeTool,
			},
		},
	};
} else if (command === "invoke") {
	if (!options.tool) usage("--tool is required for invoke.");
	request = {
		op: "tools.invoke",
		payload: {
			toolId: options.tool,
			args: await readJson(options, "args-json", "args-file", {}),
		},
	};
} else {
	if (!options.op) usage("--op is required for request.");
	const requestOp = options.op.trim();
	if (!["connections.list", "tools.list"].includes(requestOp)) {
		usage("request supports only connections.list or tools.list; use invoke for tool execution.");
	}
	request = {
		op: requestOp,
		payload: await readJson(options, "payload-json", "payload-file", {}),
	};
}
const invokesTool = ["call", "describe", "invoke"].includes(command);
if (options.output && !invokesTool) usage("--output is available only for call, describe, or invoke.");
if (options["department-id"]) request.departmentId = options["department-id"];

let outputPath;
if (invokesTool) {
	const runRoot = process.env.DIVO_RUN_DIR;
	if (!runRoot) usage(`DIVO_RUN_DIR is required for ${command}.`);
	const root = resolve(runRoot);
	const outputBase = nativeSpec
		? `${nativeSpec.toolId}-${nativeSpec.nativeTool}`
		: options.tool;
	const requestedOutput = options.output
		?? `divo-${outputBase.replaceAll(/[^a-zA-Z0-9_-]/g, "-")}-${randomUUID()}.json`;
	outputPath = isAbsolute(requestedOutput) ? resolve(requestedOutput) : resolve(root, requestedOutput);
	const child = relative(root, outputPath);
	if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
		usage("--output must name a new file inside DIVO_RUN_DIR.");
	}
}

const socketPath = process.env.DIVO_LOCAL_BROKER_SOCKET;
if (!socketPath) usage("The Divo local broker is not available in this shell.");
const MAX_AUTOMATIC_RATE_LIMIT_RETRY_SECONDS = 60;
const envelope = {
	version: 1,
	...(options.label ? { label: options.label } : nativeSpec ? { label: `${nativeSpec.toolId}.${nativeSpec.nativeTool}` } : {}),
	...(invokesTool ? { resultMode: "local-file" } : {}),
	request,
};
process.stderr.write(`[Divo] ${options.label ?? (nativeSpec ? `${nativeSpec.toolId}.${nativeSpec.nativeTool}` : command === "invoke" ? options.tool : options.op)}\n`);

const abortController = new AbortController();
process.once("SIGINT", () => abortController.abort());

try {
	let response = normalizeResponse(await exchange(envelope, abortController.signal));
	const retryAfterSeconds = automaticRetryDelay(response);
	if (retryAfterSeconds !== undefined) {
		process.stderr.write(`[Divo] governed rate budget reached; retrying this exact call once in ${retryAfterSeconds}s\n`);
		await wait(retryAfterSeconds * 1_000, abortController.signal);
		response = normalizeResponse(await exchange(envelope, abortController.signal));
	}
	if (outputPath && response.ok && response.status === "success") {
		const serialized = `${JSON.stringify(response, null, 2)}\n`;
		await writeFile(outputPath, serialized, { flag: "wx", mode: 0o600 });
		process.stdout.write(`${JSON.stringify({
			ok: response.ok,
			status: response.status,
			output: outputPath,
			bytes: Buffer.byteLength(serialized, "utf8"),
			...(response.trace ? { trace: response.trace } : {}),
		}, null, 2)}\n`);
	} else {
		process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
	}
	process.exitCode = response.ok && response.status === "success" ? 0 : 3;
} catch (error) {
	const cancelled = abortController.signal.aborted;
	process.stderr.write(`Divo broker error: ${cancelled ? "Cancelled" : error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = cancelled ? 130 : 3;
}

function normalizeResponse(rawResponse) {
	return invokesTool
		? normalizeLocalInvokeResponse(rawResponse)
		: rawResponse;
}

function automaticRetryDelay(response) {
	if (!invokesTool || response?.status !== "rate_limited") return undefined;
	const seconds = response?.error?.retryAfterSeconds;
	return Number.isInteger(seconds)
		&& seconds >= 1
		&& seconds <= MAX_AUTOMATIC_RATE_LIMIT_RETRY_SECONDS
		? seconds
		: undefined;
}

function wait(milliseconds, signal) {
	return new Promise((resolveWait, rejectWait) => {
		if (signal.aborted) {
			rejectWait(new Error("Cancelled"));
			return;
		}
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", cancel);
			resolveWait();
		}, milliseconds);
		const cancel = () => {
			clearTimeout(timer);
			rejectWait(new Error("Cancelled"));
		};
		signal.addEventListener("abort", cancel, { once: true });
	});
}

function exchange(requestEnvelope, signal) {
	return new Promise((resolveResponse, rejectResponse) => {
		const socket = createConnection(socketPath);
		let responseText = "";
		let settled = false;
		const finish = (callback, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			signal.removeEventListener("abort", cancel);
			callback(value);
		};
		const cancel = () => socket.destroy(new Error("Cancelled"));
		const timeout = setTimeout(() => socket.destroy(new Error("Divo broker timed out.")), 125_000);
		if (signal.aborted) cancel();
		else signal.addEventListener("abort", cancel, { once: true });
		socket.setEncoding("utf8");
		socket.on("connect", () => socket.write(`${JSON.stringify(requestEnvelope)}\n`));
		socket.on("data", (chunk) => { responseText += chunk; });
		socket.on("error", (error) => finish(rejectResponse, error));
		socket.on("close", () => {
			if (settled) return;
			try {
				finish(resolveResponse, JSON.parse(responseText.trim()));
			} catch (error) {
				finish(rejectResponse, new Error(`Divo broker returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`));
			}
		});
	});
}
