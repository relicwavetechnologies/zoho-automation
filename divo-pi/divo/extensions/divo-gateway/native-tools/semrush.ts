import type {
	TypedToolHost,
	TypedToolInvoker,
} from "../typed-tool-runtime.ts";
import {
	DIVO_SEMRUSH_PARAMS,
	DIVO_SEMRUSH_TOOL_ID,
	DIVO_SEMRUSH_TOOL_NAME,
} from "./semrush-contract.ts";

/**
 * Registers Semrush as a permanent, first-class Pi tool.
 *
 * Tool ergonomics live here: name, model contract, descriptions, guidance,
 * concurrency, and the exact governed request. Provider execution deliberately
 * does not: the injected invoker crosses the backend's single capability
 * boundary, where member authentication, RBAC, the Semrush key, quota policy,
 * result shaping, and audit are enforced.
 */
export function registerNativeSemrushTool(
	host: TypedToolHost,
	invoke: TypedToolInvoker,
): string {
	host.registerTool({
		name: DIVO_SEMRUSH_TOOL_NAME,
		label: "Divo Semrush research",
		description:
			"Run read-only Semrush SEO research: country-level domain overview, one-call backlink comparison, or keyword position trend. Access and provider execution are governed by Divo.",
		promptSnippet:
			"Use divo_semrush for bounded Semrush SEO evidence. Choose exactly one supported operation and report the result's own coverage limits.",
		promptGuidelines: [
			"Use domain_overview for country-level rank, keywords, traffic, and cost. One call returns every country database Semrush holds for that domain; do not call once per country.",
			"Use one backlinks_comparison call containing every requested target, up to ten. Do not fan out domain_overview calls to approximate a backlink comparison.",
			"Use keyword_position_trend for one domain and keyword around a YYYYMMDD date. It returns a dated series, not a full keyword list.",
			"Every operation is one bounded provider report, not a pageable dataset. Preserve status, preview coverage, missing targets, and other limitations in the answer.",
			"For counts and rankings, use backend-returned insights instead of counting preview rows or doing arithmetic in prose.",
			"Never invent another Semrush operation or send endpoints, headers, cookies, export columns, or API keys.",
			"A permission or configuration rejection is authoritative. Report it plainly and do not route around it.",
		],
		parameters: DIVO_SEMRUSH_PARAMS as unknown as Record<string, unknown>,
		executionMode: "parallel",
		execute: (toolCallId, params, _signal, _onUpdate, ctx) =>
			invoke({
				toolId: DIVO_SEMRUSH_TOOL_ID,
				args: params,
				toolCallId,
			}, ctx),
	});
	return DIVO_SEMRUSH_TOOL_NAME;
}
