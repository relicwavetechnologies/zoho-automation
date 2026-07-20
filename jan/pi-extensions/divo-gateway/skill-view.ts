import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	callDivoGateway,
	formatGatewayResponse,
	resolveDivoGatewayConfig,
	type DivoGatewayConfig,
	type GatewayResponseBody,
} from "./gateway-client.ts";

const DIVO_SKILL_VIEW_PARAMS = Type.Object({
	skillId: Type.String({
		description: "Exact skill ID from the injected Divo catalogue or a persona-linked rule.",
	}),
	departmentId: Type.Optional(Type.String({
		description: "Optional department context. Omit to use the desktop default department.",
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
	};
}

export async function loadDivoSkill(
	params: { skillId: string; departmentId?: string },
	dependencies: SkillViewDependencies = DEFAULT_DEPENDENCIES,
): Promise<DivoLoadedSkill> {
	const resolved = dependencies.resolveConfig();
	if ("error" in resolved) throw new Error(resolved.error);
	const { body } = await dependencies.callGateway(resolved, {
		op: "skills.get",
		departmentId: params.departmentId,
		payload: { skillId: params.skillId },
	});
	return parseLoadedSkill(body);
}

export function registerDivoSkillView(
	pi: ExtensionAPI,
	options: { onSkillLoaded?: (skill: DivoLoadedSkill) => void } = {},
): void {
	pi.registerTool({
		name: "divo_skill_view",
		label: "Divo skill",
		description:
			"Load one exact backend-owned Divo skill by ID. The backend rechecks the authenticated member's skill grant and every required tool permission before returning the recipe.",
		promptSnippet:
			"When the injected catalogue or manager persona identifies an exact relevant skillId, load it once with divo_skill_view before following that workflow.",
		promptGuidelines: [
			"Use only an exact skillId present in the injected Divo catalogue, a persona-linked rule, or a backend resolution result. Never guess an ID.",
			"Do not load a skill for greetings, ordinary conversation, or a simple direct capability call that needs no reusable procedure.",
			"Follow the returned recipe exactly, but remember that it does not grant tool permission; each invocation is still enforced by the backend.",
		],
		parameters: DIVO_SKILL_VIEW_PARAMS,
		async execute(_toolCallId, params) {
			const skill = await loadDivoSkill(params);
			options.onSkillLoaded?.(skill);
			return {
				content: [{
					type: "text",
					text: [
						`${skill.name} (revision ${skill.revision})`,
						`Skill ID: ${skill.id}`,
						`Required governed tools: ${skill.toolIds.length ? skill.toolIds.join(", ") : "none"}`,
						"",
						skill.instructions,
					].join("\n"),
				}],
				details: skill,
			};
		},
	});
}
