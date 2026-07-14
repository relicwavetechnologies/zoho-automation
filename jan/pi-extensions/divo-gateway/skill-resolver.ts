import {
	callDivoGateway,
	type DivoGatewayConfig,
	resolveDivoGatewayConfig,
} from "./gateway-client.ts";

/**
 * Company skill policy: Divo Dex resolves company work only through the
 * authenticated backend registry. Local skill files are never candidates.
 */
export const DIVO_SKILL_POLICY = "cloud_only" as const;

export interface ResolvedSkill {
	id: string;
	name: string;
	description: string;
	score: number;
	confidence: "high" | "medium" | "low";
	nextAction: string;
	reason: string;
	toolIds?: string[];
}

export interface SkillResolveResult {
	policy: typeof DIVO_SKILL_POLICY;
	query: string;
	selected: ResolvedSkill | null;
	results: ResolvedSkill[];
	notes: string[];
}

interface BackendSkillCandidate {
	id: string;
	name: string;
	description: string;
	score?: number;
	toolIds?: string[];
}

export async function resolveDivoSkills(options: {
	query: string;
	limit?: number;
	departmentId?: string;
	env?: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
}): Promise<SkillResolveResult> {
	const query = options.query.trim();
	const limit = clampLimit(options.limit);
	const env = options.env ?? process.env;
	const notes: string[] = [];
	const results = await searchBackendSkills({
		query,
		limit,
		departmentId: options.departmentId,
		env,
		fetchImpl: options.fetchImpl,
		notes,
	});

	// The backend is the ranking authority: it has the complete cloud registry
	// and applies RBAC before returning candidates. Preserve that ordering.
	const ranked = results
		.slice(0, limit)
		.map((skill) => ({ ...skill, confidence: confidenceForScore(skill.score) }));

	return {
		policy: DIVO_SKILL_POLICY,
		query,
		selected: ranked[0] ?? null,
		results: ranked,
		notes,
	};
}

export function formatSkillResolveResult(result: SkillResolveResult): string {
	if (result.results.length === 0) {
		const notes = result.notes.length ? `\n\nNotes:\n${result.notes.map((note) => `- ${note}`).join("\n")}` : "";
		return `No matching company skills found for "${result.query}".${notes}`;
	}

	const selected = result.selected;
	const lines = [
		`Company skill resolver completed for: "${result.query}"`,
		"",
		selected
			? `Selected: ${selected.name} (${selected.confidence} confidence)`
			: "Selected: none",
		"",
		"Ranked company skills:",
	];

	for (const skill of result.results) {
		lines.push(`- ${skill.name} score=${skill.score.toFixed(2)} confidence=${skill.confidence}`);
		lines.push(`  reason: ${skill.reason}`);
		lines.push(`  next: ${skill.nextAction}`);
		if (skill.toolIds?.length) lines.push(`  tools: ${skill.toolIds.join(", ")}`);
	}

	if (result.notes.length) {
		lines.push("", "Notes:");
		for (const note of result.notes) lines.push(`- ${note}`);
	}

	return lines.join("\n");
}

function confidenceForScore(score: number): "high" | "medium" | "low" {
	if (score >= 8) return "high";
	if (score >= 4) return "medium";
	return "low";
}

async function searchBackendSkills(options: {
	query: string;
	limit: number;
	departmentId?: string;
	env: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
	notes: string[];
}): Promise<ResolvedSkill[]> {
	const config = resolveDivoGatewayConfig(options.env);
	if ("error" in config) {
		options.notes.push("Company skill registry is unavailable because the Divo gateway is not configured.");
		return [];
	}

	try {
		const searchResponse = await callDivoGateway(
			config as DivoGatewayConfig,
			{
				op: "skills.search",
				departmentId: options.departmentId,
				payload: { query: options.query, limit: options.limit },
			},
			options.fetchImpl ?? fetch,
		);
		if (!searchResponse.body.ok || searchResponse.body.status !== "success") {
			options.notes.push(`Backend skills.search returned ${searchResponse.body.status}.`);
			return [];
		}

		return readBackendSkills(searchResponse.body.data)
			.map(toResolvedBackendSkill);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		options.notes.push(`Company skill registry request failed: ${message}`);
		return [];
	}
}

function toResolvedBackendSkill(skill: BackendSkillCandidate): ResolvedSkill {
	return {
		id: skill.id,
		name: skill.name,
		description: skill.description,
		score: skill.score ?? 1,
		confidence: "low",
		toolIds: skill.toolIds,
		reason: "Matched the RBAC-filtered company skill registry.",
		nextAction: `Call divo_gateway with op "skills.get" and payload { "skillId": "${skill.id}" }, then follow that skill recipe.`,
	};
}

function readBackendSkills(data: unknown): BackendSkillCandidate[] {
	if (!data || typeof data !== "object") return [];
	const skills = (data as { skills?: unknown }).skills;
	if (!Array.isArray(skills)) return [];

	return skills.flatMap((item): BackendSkillCandidate[] => {
		if (!item || typeof item !== "object") return [];
		const raw = item as Record<string, unknown>;
		const id = readString(raw.id);
		const name = readString(raw.name);
		const description = readString(raw.description);
		if (!id || !name || !description) return [];
		return [{
			id,
			name,
			description,
			score: typeof raw.score === "number" ? raw.score : undefined,
			toolIds: Array.isArray(raw.toolIds) ? raw.toolIds.filter((value): value is string => typeof value === "string") : undefined,
		}];
	});
}

function clampLimit(limit: number | undefined): number {
	if (!limit || !Number.isFinite(limit)) return 5;
	return Math.max(1, Math.min(10, Math.floor(limit)));
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}
