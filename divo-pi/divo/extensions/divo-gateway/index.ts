/**
 * Divo gateway — native Pi tools for backend-governed company capabilities.
 *
 * Config is captured from the trusted runtime launcher at startup, then the member
 * token is removed from the environment before local shells can inherit it.
 * Pi never receives SaaS credentials directly.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { registerApprovalGate } from "./approval-gate.ts";
import {
	divoPromptStripReport,
	readDepartmentPersonaContext,
} from "./department-persona.ts";
import {
	composeRunSystemPrompt,
	DIVO_DIRECT_WEB_SEARCH_POLICY,
} from "./run-prompt.ts";
import { registerMemoryReviewTool } from "./memory-review.ts";
import { registerMemoryRecallTool } from "./memory-recall.ts";
import { registerPersonalMemoryTool } from "./personal-memory.ts";
import { registerKnowledgeReviewTool } from "./knowledge-review.ts";
import {
	formatGatewayResponse,
	isGatewayApprovalStatus,
	captureDivoGatewayConfig,
	resolveDivoGatewayConfig,
} from "./gateway-client.ts";
import { executeGatewayRequest } from "./gateway-execution.ts";
import {
	createGatewayPlatformInvoker,
	createGatewayTypedToolInvoker,
	fetchNativeContractBootstrap,
} from "./typed-tool-runtime.ts";
import { registerTypedPlatformTools } from "./typed-platform-tools.ts";
import { registerDivoLlmProviders } from "../divo-llm/index.ts";
import { registerLocalDivoBroker, localCliAvailable } from "./local-broker.ts";
import {
	enrichGeneratedNativeToolCatalogue,
	providerNativeContractToolIds,
	registerGeneratedNativeToolCatalogue,
	type NativeContractCache,
} from "./native-tools/catalogue.ts";
import {
	registerDeepSeekToolSurface,
	toolIdsForDeepSeekPreload,
} from "./native-tools/deepseek-tool-surface.ts";
import { registerNativeSemrushTool } from "./native-tools/semrush.ts";
import {
	formatSkillResolveResult,
	resolveDivoSkills,
} from "./skill-resolver.ts";
import { registerTraceCapture } from "./trace.ts";
import { readDivoRunCorrelation } from "./run-correlation.ts";



function refreshDivoRuntime(pi: ExtensionAPI): void {
	const hasFreshToken = typeof process.env.DIVO_MEMBER_TOKEN === "string"
		&& process.env.DIVO_MEMBER_TOKEN.trim().length > 0;
	const resolved = hasFreshToken
		? captureDivoGatewayConfig(process.env)
		: resolveDivoGatewayConfig();
	delete process.env.DIVO_MEMBER_TOKEN;
	if ("error" in resolved) return;
	registerDivoLlmProviders(pi, resolved);
}



const DIVO_SKILL_RESOLVE_PARAMS = Type.Object({
	query: Type.String({
		description:
			"Original user request to route through the RBAC-filtered backend Divo skill registry.",
	}),
	variants: Type.Optional(Type.Array(Type.String({
		description:
			"A focused rewrite that preserves the original intent while emphasizing one distinct capability need.",
	}), {
		maxItems: 2,
		description:
			"At most two variants. Use one for the core task and one for output/integration/scheduling when useful; never omit constraints from the exact query.",
	})),
	departmentId: Type.Optional(
		Type.String({
			description:
				"Optional department context. Omit to use the authenticated runtime default.",
		}),
	),
	limit: Type.Optional(
		Type.Number({
			description: "Maximum complementary fuzzy-matched skills to return. Defaults to 5.",
		}),
	),
});




const typedToolInvoker = createGatewayTypedToolInvoker();
const nativeContractCache: NativeContractCache = new Map();

function reportInactiveNativeTools(pi: ExtensionAPI, registered: readonly string[]): void {
	const activeNames = new Set(pi.getActiveTools());
	const inactive = registered.filter(name => !activeNames.has(name));
	if (inactive.length > 0) {
		console.error(`[divo-native-tools] registered tools missing from allowlist: ${inactive.join(",")}`);
	}
}

export default function divoGatewayExtension(pi: ExtensionAPI) {
	registerApprovalGate(pi);
	registerLocalDivoBroker(pi);
	registerMemoryRecallTool(pi);
	registerPersonalMemoryTool(pi);
	registerMemoryReviewTool(pi);
	registerKnowledgeReviewTool(pi);
	// Permanent Divo tools are registered from Pi-owned contracts at process
	// start. Backend bootstrap data may enrich a provider-owned nested input
	// schema, but it can never define or remove an outer Pi tool.
	const semrushToolName = registerNativeSemrushTool(pi, typedToolInvoker);
	const nativeCatalogue = registerGeneratedNativeToolCatalogue(pi, typedToolInvoker);
	const nativeToolNames = [semrushToolName, ...nativeCatalogue.registered];
	const deepseekToolSurface = registerDeepSeekToolSurface(pi);
	// Capabilities that are not a governed tool call and would otherwise vanish
	// with the mega-tool: connected accounts, and reading an attached image.
	registerTypedPlatformTools(pi, createGatewayPlatformInvoker());

	pi.registerTool({
		name: "divo_skill_resolve",
		label: "Divo skill resolver",
		description:
			"Fallback router discovery for company work not clearly identified by the injected catalogue. " +
			"Returns advisory persona rules and bounded DB router candidates; read the matching native router and specialist.",
		promptSnippet:
			"Use divo_skill_resolve only when a specialized company workflow is likely and neither the injected catalogue nor persona supplies a clear exact skillId.",
		promptGuidelines: [
			"Always put the user's exact original wording in query. Never replace it with a summary.",
			"Use at most two variants: one for the core task/domain and one for a distinct output, integration, scheduling, or monitoring need. Preserve all entities, constraints, destinations, timing, and formats.",
			"Example: query='Prepare our monthly vendor-onboarding exception report and schedule it for Finance'; variants=['Apply the company vendor-onboarding exception workflow for Finance', 'Deliver the report monthly through scheduled Divo work'].",
			"The response contains advisory persona rules and router-only DB candidates. Read the relevant native router and specialist when available; if guidance is missing, continue with the governed tool contract when the requested capability is otherwise clear.",
			"Do not call this for greetings, ordinary conversation, or a simple direct capability call. No matching skill is a valid result.",
			"If no useful router is selected, do not guess a specialist. A clear capability may still be invoked through the governed backend contract.",
			"Do not include visible user-facing pre-tool text about resolver, gateway, backend, routing, enum, or tool mechanics. Call the tool directly or use plain wording like \"I'll check that.\"",
			"Unless the user asks about security or architecture, do not mention backend, local credentials, OAuth tokens, RBAC, audit, tool IDs, or request plumbing in final answers.",
			"Backend Divo skills are authoritative for connected accounts, RBAC, approvals, SaaS credentials, and company data.",
			"Do not call this for an ordinary public web lookup, comparison, pricing check, or current-facts question. " + DIVO_DIRECT_WEB_SEARCH_POLICY,
			"Company work has no local skill fallback. If the registry is unavailable, do not substitute a local skill.",
		],
		parameters: DIVO_SKILL_RESOLVE_PARAMS,
		async execute(toolCallId, params) {
			const result = await resolveDivoSkills({
				query: params.query,
				variants: params.variants,
				departmentId: params.departmentId,
				limit: params.limit,
				actionId: toolCallId,
			});
			// Outer tools are permanent Pi source. A work resolution may add exact
			// provider-native input schemas to Google/Airtable wrapper branches.
			if (result.bootstrap) {
				const refreshed = enrichGeneratedNativeToolCatalogue(
					pi,
					typedToolInvoker,
					result.bootstrap.nativeContracts,
					nativeContractCache,
				);
				if (refreshed.length > 0) {
					console.error(`[divo-native-tools] enriched ${refreshed.join(",")}`);
				}
			}
			const resolvedToolIds = [
				...result.results.flatMap((skill) => skill.toolIds ?? []),
				...(result.bootstrap?.tools.map((tool) => tool.id) ?? []),
				...result.results.flatMap((skill) =>
					skill.orchestrationPlan?.phases.map((phase) => phase.toolId) ?? []),
			];
			const activated = deepseekToolSurface.activateToolIds(resolvedToolIds);
			if (activated.length > 0) {
				console.error(`[divo-deepseek-tools] skill activation ${activated.join(",")}`);
			}
			return {
				content: [{ type: "text", text: formatSkillResolveResult(result) }],
				details: result,
			};
		},
	});

	let preparedDepartmentContext: Awaited<ReturnType<typeof readDepartmentPersonaContext>> | undefined;
	pi.on("input", async (event, ctx) => {
		// A queued steer/follow-up belongs to the currently running agent loop.
		// Do not replace its tool surface mid-call; the search tool remains the
		// safe recovery path if that queued message needs a different capability.
		if (event.streamingBehavior !== undefined) return { action: "continue" };
		preparedDepartmentContext = await readDepartmentPersonaContext();
		const availableTools = preparedDepartmentContext?.capabilityBootstrap?.availableTools;
		deepseekToolSurface.prepareTurn({
			prompt: event.text,
			model: ctx.model,
			...(availableTools
				? { allowedToolIds: availableTools.map((tool) => tool.toolId) }
				: {}),
		});
		return { action: "continue" };
	});

	pi.on("before_agent_start", async (event) => {
		refreshDivoRuntime(pi);
		const correlation = await readDivoRunCorrelation().catch(() => undefined);
		const toolSurfaceSelection = deepseekToolSurface.currentSelection();
		if (toolSurfaceSelection.mode === "eager") {
			reportInactiveNativeTools(pi, nativeToolNames);
		} else {
			reportInactiveNativeTools(pi, toolSurfaceSelection.selectedToolNames);
		}
		// The complete outer catalogue is already live. Fetch only to preload
		// prompt-relevant provider-native input schemas for reachable Google and
		// Airtable tools; failure leaves their safe describe-then-call contract.
		const departmentContext = preparedDepartmentContext
			?? await readDepartmentPersonaContext();
		preparedDepartmentContext = undefined;
		const permittedToolIds = departmentContext?.capabilityBootstrap?.availableTools
			?.map((tool) => tool.toolId) ?? [];
		const preloadCandidates = toolIdsForDeepSeekPreload(
			permittedToolIds,
			toolSurfaceSelection,
		);
		const reachableToolIds = providerNativeContractToolIds(preloadCandidates);
		if (reachableToolIds.length > 0) {
			try {
				const fetched = await fetchNativeContractBootstrap(
					reachableToolIds,
					"native-inputs-eager",
					event.prompt,
				);
				const refreshed = fetched.bootstrap
					? enrichGeneratedNativeToolCatalogue(
						pi,
						typedToolInvoker,
						fetched.bootstrap.nativeContracts,
						nativeContractCache,
					)
					: [];
				console.error(`[divo-native-tools] ${JSON.stringify({
					refreshed: refreshed.length,
					failed: fetched.failed,
				})}`);
			} catch (error) {
				// An absent nested preload is recoverable: describe remains available
				// and the backend still validates the native input before execution.
				console.error(`[divo-native-tools] input enrichment failed: ${String(error)}`);
			}
		}
		const { systemPrompt, skillSummary } = composeRunSystemPrompt({
			// Input-time tool retrieval happens before this base-prompt snapshot,
			// so it contains guidance only for the exact active DeepSeek surface.
			basePrompt: event.systemPrompt,
			departmentContext,
			skills: event.systemPromptOptions.skills,
			cliAvailable: localCliAvailable(),
			threadId: correlation?.threadId,
			environment: process.env,
		});
		// The Pi-prompt strip is string matching against upstream code: if a marker
		// stops matching it does nothing, and does it silently. Anything other
		// than all-zero here means an upgrade moved the text.
		const stripped = divoPromptStripReport(systemPrompt);
		if (stripped.guidelines > 0 || stripped.documentation) {
			console.error(`[divo-prompt] pi presentation text survived: ${JSON.stringify(stripped)}`);
		}
		if (skillSummary.native > 0) {
			console.error(`[divo-skills] ${JSON.stringify(skillSummary)}`);
		}
		if (systemPrompt === event.systemPrompt) {
			return undefined;
		}
		return {
			systemPrompt,
		};
	});

	// Capture a detailed trace of every desktop run (tool + model calls) and
	// stream it to the backend. Fire-and-forget; adds no user-facing latency.
	registerTraceCapture(pi);

	pi.on("session_start", (_event, ctx) => {
		const resolved = resolveDivoGatewayConfig();
		if ("error" in resolved) {
			ctx.ui.notify(
				"Divo gateway not configured — sign in through Divo to enable company tools.",
				"warning",
			);
			return;
		}
		ctx.ui.notify(
			`Divo gateway ready (${resolved.backendUrl})`,
			"info",
		);
	});
}
