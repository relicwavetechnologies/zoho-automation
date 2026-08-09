import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	callDivoGateway,
	formatGatewayResponse,
	resolveDivoGatewayConfig,
	type DivoGatewayConfig,
	type GatewayExecutionContext,
	type GatewayResponseBody,
} from "./gateway-client.ts";
import { readDivoRunCorrelation } from "./run-correlation.ts";
import {
	formatWorkBootstrap,
	parseWorkBootstrap,
	type WorkBootstrap,
} from "./work-bootstrap.ts";

const DIVO_SKILL_VIEW_PARAMS = Type.Object({
	skillId: Type.String({
		description: "Exact skill ID from the injected Divo catalogue or a persona-linked rule.",
	}),
	departmentId: Type.Optional(Type.String({
		description: "Optional department context. Omit to use the authenticated runtime default.",
	})),
});

export interface DivoLoadedSkill {
	id: string;
	slug: string;
	name: string;
	description: string;
	instructions: string;
	toolIds: string[];
	revision: number;
	registryRevision?: number;
	bootstrap?: WorkBootstrap;
}

interface SkillViewDependencies {
	resolveConfig: () => DivoGatewayConfig | { error: string };
	callGateway: typeof callDivoGateway;
}

const DEFAULT_DEPENDENCIES: SkillViewDependencies = {
	resolveConfig: resolveDivoGatewayConfig,
	callGateway: callDivoGateway,
};

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

export function parseLoadedSkill(body: GatewayResponseBody): DivoLoadedSkill {
	if (!body.ok || body.status !== "success") {
		throw new Error(formatGatewayResponse(body).text);
	}
	const data = asRecord(body.data);
	const skill = asRecord(data?.skill);
	if (!skill) throw new Error("Divo returned an invalid skill response.");

	const requiredStrings = ["id", "slug", "name", "description", "instructions"] as const;
	for (const key of requiredStrings) {
		if (typeof skill[key] !== "string" || !skill[key].trim()) {
			throw new Error(`Divo returned an invalid skill response: missing ${key}.`);
		}
	}
	if (!Array.isArray(skill.toolIds) || !skill.toolIds.every(toolId => typeof toolId === "string")) {
		throw new Error("Divo returned an invalid skill response: invalid toolIds.");
	}
	if (!Number.isInteger(skill.revision) || Number(skill.revision) < 1) {
		throw new Error("Divo returned an invalid skill response: invalid revision.");
	}
	const bootstrap = parseWorkBootstrap(data?.bootstrap);

	return {
		id: skill.id as string,
		slug: skill.slug as string,
		name: skill.name as string,
		description: skill.description as string,
		instructions: skill.instructions as string,
		toolIds: skill.toolIds as string[],
		revision: Number(skill.revision),
		...(Number.isInteger(data?.registryRevision) ? {
			registryRevision: Number(data?.registryRevision),
		} : {}),
		...(bootstrap ? { bootstrap } : {}),
	};
}

export async function loadDivoSkill(
	params: { skillId: string; departmentId?: string; execution?: GatewayExecutionContext },
	dependencies: SkillViewDependencies = DEFAULT_DEPENDENCIES,
): Promise<DivoLoadedSkill> {
	const resolved = dependencies.resolveConfig();
	if ("error" in resolved) throw new Error(resolved.error);
	const { body } = await dependencies.callGateway(resolved, {
		op: "skills.get",
		departmentId: params.departmentId,
		payload: { skillId: params.skillId },
		...(params.execution ? { execution: params.execution } : {}),
	});
	return parseLoadedSkill(body);
}

export function registerDivoSkillView(
	pi: ExtensionAPI,
	options: {
		onSkillLoaded?: (
			skill: DivoLoadedSkill,
			execution?: GatewayExecutionContext,
		) => void;
	} = {},
): void {
	pi.registerTool({
		name: "divo_skill_view",
		label: "Divo skill",
		description:
			"Compatibility loader for an exact backend-owned Divo skill ID. Use only when knowledge publishing still requires DB audit provenance, or when Pi's native DB skills are absent during rollback.",
		promptSnippet:
			"Do not use divo_skill_view for ordinary native skills. Use it only for a provenance-bound knowledge-publishing step, or when native DB skills are absent.",
		promptGuidelines: [
			"Use only an exact skillId present in the injected Divo catalogue, a persona-linked rule, or a backend resolution result. Never guess an ID.",
			"When Pi's available_skills contains the relevant DB skill, read its SKILL.md instead of calling this compatibility tool unless the workflow explicitly requires audit provenance.",
			"Do not load a skill for greetings, ordinary conversation, or a simple direct capability call that needs no reusable procedure.",
			"Follow the returned recipe exactly, but remember that it does not grant tool permission; each invocation is still enforced by the backend.",
			"The response also preloads exact contracts and accessible accounts required by this recipe. Do not call tools.list or connections.list again for bootstrap items during the current run.",
		],
		parameters: DIVO_SKILL_VIEW_PARAMS,
		async execute(toolCallId, params) {
			const correlation = await readDivoRunCorrelation().catch(() => undefined);
			const execution = correlation ? {
				version: 1 as const,
				threadId: correlation.threadId,
				runId: correlation.runId,
				actionId: toolCallId,
			} : undefined;
			const skill = await loadDivoSkill({
				...params,
				...(execution ? { execution } : {}),
			});
			options.onSkillLoaded?.(skill, execution);
			return {
				content: [{
					type: "text",
					text: [
						`${skill.name} (revision ${skill.revision})`,
						`Skill ID: ${skill.id}`,
						`Required governed tools: ${skill.toolIds.length ? skill.toolIds.join(", ") : "none"}`,
						"",
						skill.instructions,
						...(skill.bootstrap ? ["", ...formatWorkBootstrap(skill.bootstrap)] : []),
					].join("\n"),
				}],
				details: skill,
			};
		},
	});
}
