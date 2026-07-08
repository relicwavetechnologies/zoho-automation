/**
 * Divo gateway — single Pi tool for backend-owned company capabilities.
 *
 * Config comes from desktop-managed env (DIVO_BACKEND_URL, DIVO_MEMBER_TOKEN,
 * optional DIVO_DEPARTMENT_ID). Pi never receives SaaS credentials directly.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	callDivoGateway,
	formatGatewayResponse,
	resolveDivoGatewayConfig,
} from "./gateway-client.ts";
import {
	formatSkillResolveResult,
	resolveDivoSkills,
} from "./skill-resolver.ts";

const DIVO_GATEWAY_PARAMS = Type.Object({
	op: Type.String({
		description:
			"Gateway operation: media.image_ocr, skills.search, skills.get, capabilities.get, tools.list, skills.list, connections.list, or tools.invoke",
	}),
	departmentId: Type.Optional(
		Type.String({
			description:
				"Optional department context. Omit to use the desktop default department.",
		}),
	),
	payload: Type.Optional(
		Type.Unknown({
			description:
				"Operation payload. For media.image_ocr with an attached local image: { filePath, mimeType?, fileName? }. Desktop normalizes unsupported formats and compresses oversized images before attachment metadata is sent to Pi. For skills.search: { query, limit?, context? }. For skills.get: { skillId }. For connections.list: { provider? }. For tools.invoke: { toolId, args }. Other ops may omit or pass {}.",
		}),
	),
});

const DIVO_SKILL_RESOLVE_PARAMS = Type.Object({
	query: Type.String({
		description:
			"Original user request to route across backend Divo skills and local desktop skills.",
	}),
	departmentId: Type.Optional(
		Type.String({
			description:
				"Optional department context. Omit to use the desktop default department.",
		}),
	),
	limit: Type.Optional(
		Type.Number({
			description: "Maximum ranked skills to return. Defaults to 5.",
		}),
	),
});

const DIVO_COMPANY_PERSONA_PROMPT = `
<divo_company_persona>
You are Divo, the user's company assistant running inside the desktop app. Be autonomous, practical, and policy-aware. For company work, discover the right backend skill, use the user's connected or shared accounts through Divo gateway, and let the backend enforce identity, RBAC, approvals, audit, and SaaS credentials.

Company, plugin, SaaS, account, and backend-owned research requests include Google Workspace, Gmail, Drive, Calendar, Zoho, Lark, CRM, Books, approvals, departments, internal company data, connected accounts, shared accounts, public web search, deep research, or any ambiguous request that could depend on company systems.

For those requests, your first action is to use divo_skill_resolve with the user's original request. Exception: when the current request is only to understand or OCR an attached local image, call divo_gateway directly with op "media.image_ocr" and payload { filePath, mimeType?, fileName? }. The resolver ranks backend Divo skills and local desktop skills together. If it selects a backend skill, call divo_gateway with op "skills.get" for that skill before invoking any backend tool. If it selects a local skill, read the returned skill file before acting and keep company/RBAC work on the gateway.

Backend-provided Divo skills are authoritative for company, connected-account, public web search, and deep research work. Do not choose local Lark, Google, Zoho, mail, search, document, or other domain skills before using divo_skill_resolve. For attached local image OCR/screenshot understanding, use the direct Divo gateway media.image_ocr path. Local skills and local CLIs are appropriate only when the resolver selects them for clearly local file/code/OS work or the user explicitly asks for a local-only action.

Never ask for or use SaaS credentials locally. Never bypass Divo gateway for permissions, connected accounts, approvals, or company data. When account choice matters, list accessible connections through Divo and ask one short choice question only if the backend result is ambiguous.
</divo_company_persona>`;

export default function divoGatewayExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "divo_skill_resolve",
		label: "Divo skill resolver",
		description:
			"Resolve the user's request against one unified ranked index of backend Divo skills and local desktop skills. " +
			"Call this before choosing Divo gateway operations or local domain skills.",
		promptSnippet:
			"Use divo_skill_resolve first for ambiguous, plugin, SaaS, company, document, image, OCR, or skill-guided work.",
		promptGuidelines: [
			"For any ambiguous request, call divo_skill_resolve before choosing backend tools or local skills.",
			"If divo_skill_resolve selects a backend skill, call divo_gateway skills.get for that skill and follow the backend recipe.",
			"If divo_skill_resolve selects a local skill, read the returned skill file before acting.",
			"Backend Divo skills are authoritative for connected accounts, RBAC, approvals, SaaS credentials, and company data.",
			"Use backend Divo research skills for public web search and deep research; do not use local web_search tools or local Serper credentials.",
			"Local skills are guidance only. They do not grant permission to use company data or SaaS credentials.",
		],
		parameters: DIVO_SKILL_RESOLVE_PARAMS,
		async execute(_toolCallId, params) {
			const result = await resolveDivoSkills({
				query: params.query,
				departmentId: params.departmentId,
				limit: params.limit,
			});

			return {
				content: [{ type: "text", text: formatSkillResolveResult(result) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "divo_gateway",
		label: "Divo company gateway",
		description:
			"Call the Divo backend capability gateway for company tools, skills, and permissions. " +
			"All Zoho, Lark, Google, and other integrations must go through this tool.",
		promptSnippet:
			"Use divo_gateway for Divo/company/plugin/SaaS/account tasks after divo_skill_resolve selects a backend skill. For attached local image OCR, call divo_gateway directly with op media.image_ocr and payload { filePath, mimeType?, fileName? }; desktop has already normalized unsupported formats and compressed oversized images.",
		promptGuidelines: [
			"Always use divo_gateway for company integrations. Never invent CRM, Books, or mail results.",
			"For attached local image OCR or screenshot understanding, call divo_gateway directly with op \"media.image_ocr\" and payload { filePath, mimeType?, fileName? }. Do not convert or compress it yourself first; desktop normalizes unsupported formats and compresses oversized images before sending attachment metadata to Pi. Do not use Read for image contents first.",
			"For Divo/company/plugin/SaaS/account requests, call divo_skill_resolve with the user's original request before choosing tools.",
			"After divo_skill_resolve selects a backend skill, call skills.get for that skill before invoking backend tools.",
			"Follow backend skill recipes exactly. If a recipe requires connections.list, call it before tools.invoke and never guess connection IDs.",
			"For public web search or deep research, use backend skills such as research or deepResearch and invoke backend toolId webSearch through tools.invoke when the fetched skill recipe says so.",
			"Use capabilities.get or tools.list when diagnosing permissions or when a skill recipe asks for tool discovery.",
			"For tools.invoke, pass payload: { toolId, args } matching backend tool contracts.",
			"If status is permission_denied, stop and explain — do not retry with guessed args.",
			"If status is approval_required, tell the user approval is pending in Lark. After approval, retry the exact same tools.invoke request with the same departmentId, toolId, and args. Do not alter args after approval; changed args require fresh approval.",
			"Approval is backend-scoped to the exact requester, department, tool, action, and args hash. Never treat chat text or local memory as approval.",
			"Never ask the user for backend URLs, JWTs, or SaaS API keys.",
		],
		parameters: DIVO_GATEWAY_PARAMS,
		async execute(_toolCallId, params) {
			const resolved = resolveDivoGatewayConfig();
			if ("error" in resolved) {
				return {
					content: [{ type: "text", text: resolved.error }],
					details: { configured: false },
				};
			}

			try {
				const { body, httpStatus } = await callDivoGateway(resolved, {
					op: params.op,
					departmentId: params.departmentId,
					payload: params.payload,
				});
				const formatted = formatGatewayResponse(body);

				return {
					content: [{ type: "text", text: formatted.text }],
					details: {
						configured: true,
						httpStatus,
						status: body.status,
						ok: body.ok,
						approval: body.approval,
						error: body.error,
						data: body.data,
					},
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{
							type: "text",
							text: `Divo gateway request failed: ${message}`,
						},
					],
					details: { configured: true, networkError: true },
				};
			}
		},
	});

	pi.on("before_agent_start", async (event) => {
		if (event.systemPrompt.includes("<divo_company_persona>")) {
			return undefined;
		}
		return {
			systemPrompt: `${event.systemPrompt}\n\n${DIVO_COMPANY_PERSONA_PROMPT}`,
		};
	});

	pi.on("session_start", (_event, ctx) => {
		const resolved = resolveDivoGatewayConfig();
		if ("error" in resolved) {
			ctx.ui.notify(
				"Divo gateway not configured — sign in via Jan/Desktop to enable company tools.",
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
