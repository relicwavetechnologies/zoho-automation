/**
 * Pi-only browser tools — Brave / Chrome / Edge via chrome-devtools-mcp.
 *
 * Use --browserUrl (HTTP CDP discovery). Do NOT pass DevToolsActivePort's
 * browser-level --wsEndpoint — Puppeteer returns 404 on Brave/Chromium 149.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";

const DEFAULT_BROWSER_URL =
	process.env.PI_BROWSER_URL ?? "http://127.0.0.1:9222";

const DEVTOOLS_ACTIVE_PORT_PATHS = [
	"BraveSoftware/Brave-Browser/DevToolsActivePort",
	"Google/Chrome/DevToolsActivePort",
	"Microsoft Edge/DevToolsActivePort",
].map((p) => join(homedir(), "Library", "Application Support", p));

let mcpClient: Client | null = null;
let mcpConnect: Promise<Client> | null = null;
let cachedBrowserUrl: string | null = null;

function mcpResultToText(result: Awaited<ReturnType<Client["callTool"]>>): string {
	return result.content
		.map((block) => {
			if (block.type === "text") return block.text;
			return JSON.stringify(block);
		})
		.join("\n");
}

function browserHintFromPath(file: string): string {
	if (file.includes("Brave")) return "Brave";
	if (file.includes("Edge")) return "Edge";
	return "Chrome";
}

/** Read debugging port written by Brave/Chrome when remote debugging is on. */
async function readDevToolsActivePort(): Promise<{
	port: string;
	file: string;
} | null> {
	for (const file of DEVTOOLS_ACTIVE_PORT_PATHS) {
		try {
			const raw = await readFile(file, "utf8");
			const lines = raw.trim().split("\n");
			if (lines.length < 1) continue;
			const port = lines[0].trim();
			if (port && /^\d+$/.test(port)) {
				return { port, file };
			}
		} catch {
			// try next profile
		}
	}
	return null;
}

async function resolveBrowserUrl(): Promise<{
	browserUrl: string;
	source: string;
	browserHint: string;
}> {
	const fromEnv = process.env.PI_BROWSER_URL?.replace(/\/$/, "");
	if (fromEnv) {
		return {
			browserUrl: fromEnv,
			source: "PI_BROWSER_URL env",
			browserHint: "custom",
		};
	}

	const active = await readDevToolsActivePort();
	if (active) {
		return {
			browserUrl: `http://127.0.0.1:${active.port}`,
			source: active.file,
			browserHint: browserHintFromPath(active.file),
		};
	}

	const fallback = DEFAULT_BROWSER_URL.replace(/\/$/, "");
	try {
		const res = await fetch(`${fallback}/json/list`, {
			signal: AbortSignal.timeout(3000),
		});
		if (res.ok) {
			return {
				browserUrl: fallback,
				source: `${fallback}/json/list`,
				browserHint: "Chromium",
			};
		}
	} catch {
		// fall through
	}

	throw new Error(
		`No browser CDP endpoint found.\n` +
			`• Brave: open brave://inspect/#remote-debugging → enable, keep Brave open\n` +
			`• Chrome: chrome://inspect/#remote-debugging → enable\n` +
			`• Or set PI_BROWSER_URL=http://127.0.0.1:9222`,
	);
}

async function probeBrowser(): Promise<{ ok: boolean; message: string }> {
	try {
		const { browserUrl, browserHint, source } = await resolveBrowserUrl();
		const res = await fetch(`${browserUrl}/json/list`, {
			signal: AbortSignal.timeout(5000),
		});
		if (!res.ok) {
			throw new Error(`CDP HTTP ${res.status} at ${browserUrl}/json/list`);
		}
		const targets = (await res.json()) as Array<{ type?: string }>;
		const pageCount = targets.filter((t) => t.type === "page").length;
		return {
			ok: true,
			message: `${browserHint} CDP ready at ${browserUrl} (${pageCount} tabs, via ${source})`,
		};
	} catch (err) {
		return {
			ok: false,
			message: err instanceof Error ? err.message : String(err),
		};
	}
}

async function resetMcpClient(): Promise<void> {
	mcpClient = null;
	mcpConnect = null;
	cachedBrowserUrl = null;
}

async function getMcp(): Promise<Client> {
	const { browserUrl } = await resolveBrowserUrl();

	if (mcpClient && cachedBrowserUrl === browserUrl) {
		return mcpClient;
	}

	if (mcpConnect && cachedBrowserUrl === browserUrl) {
		return mcpConnect;
	}

	await resetMcpClient();
	cachedBrowserUrl = browserUrl;

	mcpConnect = (async () => {
		const transport = new StdioClientTransport({
			command: "npx",
			args: [
				"-y",
				"chrome-devtools-mcp@latest",
				`--browserUrl=${browserUrl}`,
			],
		});
		const client = new Client({ name: "pi-browser-brave", version: "1.0.0" });
		await client.connect(transport);
		mcpClient = client;
		return client;
	})();

	try {
		return await mcpConnect;
	} catch (err) {
		await resetMcpClient();
		throw err;
	}
}

async function callMcpTool(
	name: string,
	args: Record<string, unknown>,
): Promise<string> {
	try {
		const client = await getMcp();
		const result = await client.callTool({ name, arguments: args });
		if (result.isError) {
			throw new Error(mcpResultToText(result));
		}
		return mcpResultToText(result);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (
			msg.includes("Could not connect to Chrome") ||
			msg.includes("Unexpected server response: 404")
		) {
			await resetMcpClient();
			throw new Error(
				`${msg}\n\nTip: Enable remote debugging at brave://inspect/#remote-debugging and allow the connection if prompted.`,
			);
		}
		throw err;
	}
}

export default function browserBraveExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const probe = await probeBrowser();
		ctx.ui.notify(
			probe.ok ? probe.message : `Browser: ${probe.message}`,
			probe.ok ? "info" : "warning",
		);
	});

	pi.registerTool({
		name: "browser_status",
		label: "Browser connection status",
		description:
			"Check Brave/Chrome/Edge CDP and MCP connectivity (uses HTTP browserUrl, not wsEndpoint)",
		promptGuidelines: [
			"Use browser_status if browser tools fail. Works with Brave — not Chrome-only.",
		],
		parameters: Type.Object({}),
		async execute() {
			const probe = await probeBrowser();
			if (!probe.ok) {
				return {
					content: [{ type: "text", text: probe.message }],
					details: probe,
				};
			}
			try {
				const pages = await callMcpTool("list_pages", {});
				return {
					content: [
						{
							type: "text",
							text: `${probe.message}\n\nMCP list_pages:\n${pages}`,
						},
					],
					details: { ...probe, mcpOk: true },
				};
			} catch (err) {
				const mcpErr = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{
							type: "text",
							text: `${probe.message}\n\nMCP check failed: ${mcpErr}`,
						},
					],
					details: { ...probe, mcpOk: false },
				};
			}
		},
	});

	pi.registerTool({
		name: "browser_list_pages",
		label: "List browser tabs",
		description: "List open tabs in Brave/Chrome/Edge",
		parameters: Type.Object({}),
		async execute() {
			const text = await callMcpTool("list_pages", {});
			return { content: [{ type: "text", text }], details: {} };
		},
	});

	pi.registerTool({
		name: "browser_navigate",
		label: "Navigate browser",
		description: "Navigate the active tab to a URL",
		promptGuidelines: [
			"Use browser_navigate for URLs. Do not launch Google Chrome via bash.",
		],
		parameters: Type.Object({
			url: Type.String({ description: "URL to open" }),
		}),
		async execute(_id, params) {
			const text = await callMcpTool("navigate_page", {
				type: "url",
				url: params.url,
			});
			return { content: [{ type: "text", text }], details: {} };
		},
	});

	pi.registerTool({
		name: "browser_snapshot",
		label: "Browser page snapshot",
		description: "Accessibility snapshot of the current page",
		parameters: Type.Object({}),
		async execute() {
			const text = await callMcpTool("take_snapshot", {});
			return { content: [{ type: "text", text }], details: {} };
		},
	});

	pi.registerTool({
		name: "web_search",
		label: "Web search (browser)",
		description: "Google search in the user's Brave/Chrome browser",
		promptGuidelines: ["Use web_search for web search. No bash or APIs."],
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
		}),
		async execute(_id, params) {
			const q = encodeURIComponent(params.query);
			await callMcpTool("navigate_page", {
				type: "url",
				url: `https://www.google.com/search?q=${q}`,
			});
			const text = await callMcpTool("take_snapshot", {});
			return {
				content: [{ type: "text", text: `Search: ${params.query}\n\n${text}` }],
				details: {},
			};
		},
	});
}
