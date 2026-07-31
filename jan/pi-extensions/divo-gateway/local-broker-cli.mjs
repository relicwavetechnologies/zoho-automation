#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { normalizeLocalInvokeResponse } from "./local-broker-response.mjs";

function usage(message) {
	if (message) process.stderr.write(`${message}\n\n`);
	process.stderr.write([
		"Divo governed company-call client",
		"",
		"  divo-local invoke --tool <toolId> (--args-json <json> | --args-file <path>) [--label <text>]",
		"  divo-local request --op <connections.list|tools.list|tools.invoke> (--payload-json <json> | --payload-file <path>)",
		"",
		"The client contains no member or SaaS credentials. The local Divo broker applies desktop approval and the backend applies RBAC, connection policy, rate limits, manager approval, and audit.",
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
if (!command || !["invoke", "request"].includes(command)) usage();
const options = parseOptions(rest);
let request;
if (command === "invoke") {
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
	request = {
		op: options.op,
		payload: await readJson(options, "payload-json", "payload-file", {}),
	};
}
if (options["department-id"]) request.departmentId = options["department-id"];

const socketPath = process.env.DIVO_LOCAL_BROKER_SOCKET;
if (!socketPath) usage("The Divo local broker is not available in this shell.");
const envelope = {
	version: 1,
	...(options.label ? { label: options.label } : {}),
	request,
};
process.stderr.write(`[Divo] ${options.label ?? (command === "invoke" ? options.tool : options.op)}\n`);

const socket = createConnection(socketPath);
let responseText = "";
const timeout = setTimeout(() => socket.destroy(new Error("Divo broker timed out.")), 125_000);
process.once("SIGINT", () => socket.destroy(new Error("Cancelled")));
socket.setEncoding("utf8");
socket.on("connect", () => socket.write(`${JSON.stringify(envelope)}\n`));
socket.on("data", (chunk) => { responseText += chunk; });
socket.on("error", (error) => {
	clearTimeout(timeout);
	process.stderr.write(`Divo broker error: ${error.message}\n`);
	process.exitCode = error.message === "Cancelled" ? 130 : 3;
});
socket.on("close", () => {
	clearTimeout(timeout);
	if (process.exitCode) return;
	try {
		const rawResponse = JSON.parse(responseText.trim());
		const response = command === "invoke"
			? normalizeLocalInvokeResponse(rawResponse)
			: rawResponse;
		process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
		process.exitCode = response.ok && response.status === "success" ? 0 : 3;
	} catch (error) {
		process.stderr.write(`Divo broker returned invalid JSON: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 3;
	}
});
