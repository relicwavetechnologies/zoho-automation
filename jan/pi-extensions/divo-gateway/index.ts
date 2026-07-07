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

const DIVO_GATEWAY_PARAMS = Type.Object({
	op: Type.String({
		description:
			"Gateway operation: capabilities.get, tools.list, skills.list, skills.get, or tools.invoke",
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
				"Operation payload. For tools.invoke: { toolId, args }. Other ops may omit or pass {}.",
		}),
	),
});

export default function divoGatewayExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "divo_gateway",
		label: "Divo company gateway",
		description:
			"Call the Divo backend capability gateway for company tools, skills, and permissions. " +
			"All Zoho, Lark, Google, and other integrations must go through this tool.",
		promptSnippet:
			"Use divo_gateway for every company tool, CRM, Books, mail, or skill lookup.",
		promptGuidelines: [
			"Always use divo_gateway for company integrations. Never invent CRM, Books, or mail results.",
			"Start with capabilities.get or tools.list when unsure what is allowed.",
			"For tools.invoke, pass payload: { toolId, args } matching backend tool contracts.",
			"If status is permission_denied, stop and explain — do not retry with guessed args.",
			"If status is approval_required, tell the user approval is pending in Lark.",
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
