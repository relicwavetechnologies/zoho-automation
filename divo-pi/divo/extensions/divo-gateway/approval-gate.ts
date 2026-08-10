import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { readDivoRunCorrelation, type DivoRunCorrelationV1 } from "./run-correlation.ts";

export const DIVO_APPROVAL_PROTOCOL_TITLE = "divo_approval_v1";
type JsonRecord = Record<string, unknown>;

export interface ApprovalPresentationV1 {
	version: 1;
	toolCallId: string;
	source: "divo" | "bash" | "edit" | "write";
	kind: string;
	action: string;
	title: string;
	intentId?: string;
	presentation: unknown;
	runCorrelation: DivoRunCorrelationV1;
	expiresAt?: string;
}

export type ApprovalContext = Pick<ExtensionContext, "cwd" | "signal"> & {
	ui: Pick<ExtensionContext["ui"], "confirm">;
};

function asRecord(value: unknown): JsonRecord | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as JsonRecord)
		: undefined;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function approvalBlock(reason: string): ToolCallEventResult {
	return { block: true, reason };
}

const LOCAL_LARK_SKILL_PATH = /(?:^|[\\/])skills[\\/]lark-[^\\/\s"']+(?:[\\/]|$)/i;
const LARK_CLI_COMMAND = /(?:^|[\\/\s"';&|()])lark-cli(?=$|[\s"';&|()])/i;

/**
 * Best-effort policy tripwire for obvious model mistakes. This is not a shell
 * security boundary: Bash and general-purpose interpreters can construct both
 * executable names and paths after this pre-execution text inspection. A hard
 * boundary requires removing those tools from Pi's allowlist or an OS sandbox.
 */
function gateObviousLocalLarkFallback(event: ToolCallEvent): ToolCallEventResult | undefined {
	const input = asRecord(event.input);
	if (!input) return undefined;

	if (event.toolName === "bash") {
		const command = nonEmptyString(input.command);
		if (command && LARK_CLI_COMMAND.test(command)) {
			return approvalBlock(
				"lark-cli is disabled in Divo. Use the governed Divo Lark tools; there is no local fallback.",
			);
		}
		if (command && LOCAL_LARK_SKILL_PATH.test(command)) {
			return approvalBlock(
				"Local lark-* skill paths are disabled in Divo. Resolve the governed backend skill instead.",
			);
		}
	}

	const path = nonEmptyString(input.path);
	if (path && LOCAL_LARK_SKILL_PATH.test(path)) {
		return approvalBlock(
			"Local lark-* skill paths are disabled in Divo. Resolve the governed backend skill instead.",
		);
	}
	return undefined;
}

async function askForApproval(
	ctx: ApprovalContext,
	request: Omit<ApprovalPresentationV1, "runCorrelation">,
): Promise<ToolCallEventResult | undefined> {
	let confirmed = false;
	try {
		// Capture provenance before Pi creates the raw extension UI request.
		const correlatedRequest: ApprovalPresentationV1 = {
			...request,
			runCorrelation: await readDivoRunCorrelation(),
		};
		confirmed = await ctx.ui.confirm(
			DIVO_APPROVAL_PROTOCOL_TITLE,
			JSON.stringify(correlatedRequest),
			ctx.signal ? { signal: ctx.signal } : undefined,
		);
	} catch {
		return approvalBlock("Approval UI failed; the action was not executed.");
	}

	return confirmed
		? undefined
		: approvalBlock("The user did not approve this action.");
}

function localApprovalRequest(
	event: ToolCallEvent,
	ctx: ApprovalContext,
): Omit<ApprovalPresentationV1, "runCorrelation"> | undefined {
	const input = event.input as JsonRecord;
	if (event.toolName === "bash") {
		return {
			version: 1,
			toolCallId: event.toolCallId,
			source: "bash",
			kind: "bash.execute",
			action: "execute",
			title: "Run terminal command",
			presentation: {
				kind: "bash.execute",
				command: input.command,
				cwd: ctx.cwd,
				...(input.timeout === undefined ? {} : { timeout: input.timeout }),
			},
		};
	}
	if (event.toolName === "edit") {
		return {
			version: 1,
			toolCallId: event.toolCallId,
			source: "edit",
			kind: "file.edit",
			action: "update",
			title: "Edit local file",
			presentation: {
				kind: "file.edit",
				cwd: ctx.cwd,
				path: input.path,
				edits: input.edits,
			},
		};
	}
	if (event.toolName === "write") {
		return {
			version: 1,
			toolCallId: event.toolCallId,
			source: "write",
			kind: "file.write",
			action: "write",
			title: "Write local file",
			presentation: {
				kind: "file.write",
				cwd: ctx.cwd,
				path: input.path,
				content: input.content,
			},
		};
	}
	return undefined;
}

/**
 * Routing rules that outlive the mega-tool.
 *
 * The envelope checks this used to perform — payload is an object, toolId is
 * non-empty, args is an object — are now enforced by the typed tool's own
 * schema before the call ever reaches here, so only the genuine routing rules
 * remain: knowledge reads and writes belong on their dedicated surfaces, where
 * the exact content and target are reviewed.
 */
function gateTypedKnowledgeInvocation(event: ToolCallEvent): ToolCallEventResult | undefined {
	const args = asRecord(event.input);
	if (!args) return undefined;
	const operation = nonEmptyString(args.operation);

	if (operation === "recall") {
		return approvalBlock(
			"Memory recall must use divo_memory_recall with a query and optional exact department-name ranking preferences. The backend derives and searches all active memberships; names do not select or grant scope.",
		);
	}
	if (operation === "propose" || operation === "apply") {
		if (nonEmptyString(args.scope) === "personal" && nonEmptyString(args.kind) === "memory") {
			return approvalBlock(
				"Raw personal-memory proposals are disabled. Use divo_memory for an explicit personal save, correction, or deletion; implicit learning remains a separate backend process.",
			);
		}
		return approvalBlock(
			"Personal skills/files and all shared knowledge changes must use the dedicated review surface so the exact content and target are reviewed before backend policy can apply them.",
		);
	}
	return undefined;
}

/**
 * Present a server-created write intent and return its ID only after the user
 * approves it. The backend owns classification and binds the intent to the
 * validated identity, department, tool, action, and args.
 */
export async function approvePreparedDivoIntent(
	toolCallId: string,
	value: unknown,
	ctx: ApprovalContext,
): Promise<string> {
	const data = asRecord(value);
	const intentId = nonEmptyString(data?.intentId);
	if (!data || !intentId || !("presentation" in data)) {
		throw new Error(
			"The backend did not return a complete approval intent; the action was not executed.",
		);
	}

	const presentationRecord = asRecord(data.presentation);
	const blocked = await askForApproval(ctx, {
		version: 1,
		toolCallId,
		source: "divo",
		kind:
			nonEmptyString(data.kind) ??
			nonEmptyString(presentationRecord?.kind) ??
			"divo.write",
		action:
			nonEmptyString(data.action) ??
			nonEmptyString(presentationRecord?.action) ??
			"write",
		title:
			nonEmptyString(data.title) ??
			nonEmptyString(presentationRecord?.title) ??
			"Review action",
		intentId,
		presentation: data.presentation,
		...(nonEmptyString(data.expiresAt)
			? { expiresAt: nonEmptyString(data.expiresAt) }
			: {}),
	});
	if (blocked) throw new Error(blocked.reason);
	return intentId;
}

export async function handleApprovalToolCall(
	event: ToolCallEvent,
	ctx: ApprovalContext,
): Promise<ToolCallEventResult | undefined> {
	const blockedLarkFallback = gateObviousLocalLarkFallback(event);
	if (blockedLarkFallback) return blockedLarkFallback;

	const local = localApprovalRequest(event, ctx);
	if (local) return askForApproval(ctx, local);

	if (event.toolName === "divo_knowledge") {
		return gateTypedKnowledgeInvocation(event);
	}
	return undefined;
}

export function registerApprovalGate(pi: ExtensionAPI): void {
	pi.on("tool_call", (event, ctx) => handleApprovalToolCall(event, ctx));
}
