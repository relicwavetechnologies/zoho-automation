#!/usr/bin/env node

import {
	fetchMemberSession,
	fetchRuntimeContext,
	normalizeBackendUrl,
	readSessionEnvironment,
	selectDepartment,
	signInWithLark,
} from "./auth.mjs";
import { defaults, startDivoPi } from "./runtime.mjs";

function usage() {
	console.log(`Divo Pi

Usage:
  npm run divo:login -- [options]
  npm run divo:start -- [options] [prompt]

Options:
  --backend <url>          Divo backend or public ngrok URL
  --department <id|name>  Department selection (defaults to the first)
  --workspace <path>      Isolated workspace
  --thread <id>           Durable Pi session id
  --session-env <path>    Reuse an existing desktop Divo member session
  --print                 Run one prompt and exit
  --no-browser            Print the Lark OAuth URL without opening it
  --help                  Show this help
`);
}

export function parseArguments(argv) {
	const result = {
		command: argv[0] === "login" ? "login" : "run",
		backendUrl: process.env.DIVO_BACKEND_URL ?? "http://localhost:8000",
		backendExplicit: false,
		department: undefined,
		sessionEnvironment: undefined,
		workspace: defaults.workspace,
		thread: "terminal-phase-0",
		print: false,
		launchBrowser: true,
		help: false,
		prompt: [],
	};
	const startIndex = argv[0] === "login" || argv[0] === "run" ? 1 : 0;
	for (let index = startIndex; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--help") {
			result.help = true;
		} else if (argument === "--print") {
			result.print = true;
		} else if (argument === "--no-browser") {
			result.launchBrowser = false;
		} else if (["--backend", "--department", "--workspace", "--thread", "--session-env"].includes(argument)) {
			const value = argv[index + 1];
			if (!value) throw new Error(`${argument} requires a value`);
			index += 1;
			if (argument === "--backend") {
				result.backendUrl = value;
				result.backendExplicit = true;
			}
			if (argument === "--department") result.department = value;
			if (argument === "--workspace") result.workspace = value;
			if (argument === "--thread") result.thread = value;
			if (argument === "--session-env") result.sessionEnvironment = value;
		} else if (argument.startsWith("-")) {
			throw new Error(`Unknown option: ${argument}`);
		} else {
			result.prompt.push(argument);
		}
	}
	return result;
}

async function authenticate(options) {
	if (options.sessionEnvironment) {
		const existing = readSessionEnvironment(options.sessionEnvironment);
		const backendUrl = options.backendExplicit
			? normalizeBackendUrl(options.backendUrl)
			: existing.backendUrl;
		if (existing.mode & 0o077) {
			console.error(
				`[divo-pi] warning: session file permissions are ${existing.mode.toString(8)}; prefer 600`,
			);
		}
		const session = await fetchMemberSession({ backendUrl, token: existing.token });
		const department = selectDepartment(
			session.departments ?? [],
			options.department ?? existing.departmentId,
		);
		const runtimeContext = await fetchRuntimeContext({
			backendUrl,
			token: existing.token,
			department,
			departments: session.departments ?? [],
		});
		return { backendUrl, token: existing.token, session, department, runtimeContext };
	}
	const backendUrl = normalizeBackendUrl(options.backendUrl);
	console.error(`[divo-pi] starting Lark sign-in against ${backendUrl}`);
	const auth = await signInWithLark({
		backendUrl,
		launchBrowser: options.launchBrowser,
		onAuthorizeUrl: (url) => {
			console.error("[divo-pi] complete sign-in in your browser:");
			console.error(url);
		},
	});
	const departments = auth.session.departments ?? [];
	const department = selectDepartment(departments, options.department);
	const runtimeContext = await fetchRuntimeContext({
		backendUrl: auth.backendUrl,
		token: auth.token,
		department,
		departments,
	});
	return { ...auth, department, runtimeContext };
}

async function main() {
	const options = parseArguments(process.argv.slice(2));
	if (options.help) {
		usage();
		return;
	}
	const authenticated = await authenticate(options);
	const identity =
		authenticated.session.name ?? authenticated.session.email ?? authenticated.session.userId;
	console.error(
		`[divo-pi] authenticated as ${identity}; department=${authenticated.department?.name ?? "none"}`,
	);
	if (options.command === "login") {
		console.log("Divo Pi browser authentication and runtime-context verification succeeded.");
		return;
	}
	startDivoPi({
		backendUrl: authenticated.backendUrl,
		token: authenticated.token,
		departmentId: authenticated.department?.id,
		runtimeContext: authenticated.runtimeContext,
		workspace: options.workspace,
		thread: options.thread,
		print: options.print,
		prompt: options.prompt.join(" ") || undefined,
	});
}

main().catch((error) => {
	console.error(`[divo-pi] ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});
