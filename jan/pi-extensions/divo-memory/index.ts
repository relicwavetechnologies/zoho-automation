import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { handleMemoryRequest, renderAllMemoryPromptBlocks } from "./memory-store.ts";

const MEMORY_GUIDANCE = `
<divo_user_memory>
You have persistent local user memory across Divo desktop sessions.

Use the memory tool proactively when the user states a durable preference, correction, stable personal detail, or recurring expectation that would reduce future steering.

Save compact declarative facts, not instructions:
- Good: "User prefers concise implementation summaries."
- Good: "User wants image/PDF handling routed through Divo OCR before local workarounds."
- Bad: "Always be concise."
- Bad: "Today we fixed the upload bug."

Do not save task progress, temporary TODOs, one-off file paths, logs, raw data dumps, secrets, credentials, or anything likely to be stale within a week.

Use target "user" for user preferences, communication style, and personal workflow expectations. Use target "memory" only for stable local environment facts, tool quirks, or durable lessons about how this desktop setup works.

Memory is injected into the system prompt at the start of each agent run from local markdown files. Mid-run memory writes are durable immediately, but the new snapshot appears on the next agent run.

Apply injected entries as compatible personal defaults; a separate read call is not required merely to recall them. They may refine presentation and working style, but they do not override the user's current instruction, a task-specific department persona rule or exact linked skill, company policy, permissions, approvals, or security requirements. When a more specific rule conflicts, follow the specific rule and do not silently combine incompatible requirements.
</divo_user_memory>`;

const MEMORY_OPERATION = {
	type: "object",
	properties: {
		action: {
			type: "string",
			description: "Operation in a batch: add, replace, or remove.",
		},
		content: {
			type: "string",
			description: "Memory entry content for add or replace. Keep it compact and declarative.",
		},
		oldText: {
			type: "string",
			description: "Short unique substring of the entry to replace or remove.",
		},
	},
	required: ["action"],
} as const;

const MEMORY_PARAMS = {
	type: "object",
	properties: {
		action: {
			type: "string",
			enum: ["read", "add", "replace", "remove", "batch"],
			description: "Memory action: read, add, replace, remove, or batch. Defaults to read.",
		},
		target: {
			type: "string",
			enum: ["user", "memory"],
			description:
				"Memory target: user for user preferences/profile, memory for local environment/tool lessons. Defaults to user.",
		},
		content: {
			type: "string",
			description: "Memory entry content for add or replace. Keep it compact and declarative.",
		},
		oldText: {
			type: "string",
			description: "Short unique substring of the entry to replace or remove.",
		},
		operations: {
			type: "array",
			items: MEMORY_OPERATION,
			description:
				"Batch operations applied atomically. Prefer one batch when replacing/removing stale entries and adding a new fact together.",
		},
	},
	additionalProperties: false,
} as const;

function formatMemoryResult(result: Awaited<ReturnType<typeof handleMemoryRequest>>): string {
	const lines = [
		result.success ? "Memory updated." : "Memory update failed.",
		`target: ${result.target}`,
		`usage: ${result.usage}`,
		`entries: ${result.entryCount}`,
	];
	if (result.message) lines.push(`message: ${result.message}`);
	if (result.error) lines.push(`error: ${result.error}`);
	if (result.entries?.length) {
		lines.push("", "current_entries:");
		for (const entry of result.entries) {
			lines.push(`- ${entry}`);
		}
	}
	return lines.join("\n");
}

export default function divoMemoryExtension(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		const memoryBlocks = await renderAllMemoryPromptBlocks();
		return {
			systemPrompt: [event.systemPrompt, MEMORY_GUIDANCE, memoryBlocks].filter(Boolean).join("\n\n"),
		};
	});

	pi.registerTool({
		name: "memory",
		label: "Divo user memory",
		description:
			"Read or update Divo's persistent local user memory. Use this for durable user preferences, corrections, stable workflow expectations, and local environment/tool lessons.",
		promptSnippet:
			"Use memory to save durable user preferences, corrections, stable workflow expectations, and local environment/tool lessons that should persist across sessions.",
		promptGuidelines: [
			"Use memory proactively when the user states a durable preference, correction, stable personal detail, or recurring expectation.",
			"Write compact declarative facts, not imperatives. Prefer 'User prefers concise summaries' over 'Always summarize concisely'.",
			"Do not save task progress, temporary TODOs, one-off paths, logs, raw data dumps, secrets, or facts likely to be stale within a week.",
			"Use target=user for user preferences and communication style. Use target=memory only for stable local environment facts, tool quirks, or durable desktop setup lessons.",
			"When memory is full or stale, use one batch operation to remove/replace old entries and add the new fact.",
		],
		parameters: MEMORY_PARAMS,
		async execute(_toolCallId, params) {
			const result = await handleMemoryRequest(params);
			return {
				content: [{ type: "text", text: formatMemoryResult(result) }],
				details: result,
			};
		},
	});
}
