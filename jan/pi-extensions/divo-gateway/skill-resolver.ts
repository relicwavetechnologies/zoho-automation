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
	instructions?: string;
	revision?: number;
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
	const config = resolveDivoGatewayConfig(env);
	if ("error" in config) {
		notes.push("Company skill registry is unavailable because the Divo gateway is not configured.");
		return {
			policy: DIVO_SKILL_POLICY,
			query,
			selected: null,
			results: [],
			notes,
		};
	}
	const results = await searchBackendSkills({
		query,
		limit,
		departmentId: options.departmentId,
		config,
		fetchImpl: options.fetchImpl,
		notes,
	});

	// The backend is the ranking authority: it has the complete cloud registry
	// and applies RBAC before returning candidates. Preserve that ordering.
	const ranked = results
		.slice(0, limit)
		.map((skill) => ({ ...skill, confidence: confidenceForScore(skill.score) }));
	const selected = ranked[0]
		? await loadSelectedSkill({
			candidate: ranked[0],
			departmentId: options.departmentId,
			config,
			fetchImpl: options.fetchImpl,
			notes,
		})
		: null;

	return {
		policy: DIVO_SKILL_POLICY,
		query,
		selected,
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
	if (selected?.instructions) {
		lines.push(
			"",
			`Loaded approved recipe${selected.revision ? ` (revision ${selected.revision})` : ""}:`,
			selected.instructions,
		);
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
	config: DivoGatewayConfig;
	fetchImpl?: typeof fetch;
	notes: string[];
}): Promise<ResolvedSkill[]> {
	try {
		const searchResponse = await callDivoGateway(
			options.config,
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

async function loadSelectedSkill(options: {
	candidate: ResolvedSkill;
	departmentId?: string;
	config: DivoGatewayConfig;
	fetchImpl?: typeof fetch;
	notes: string[];
}): Promise<ResolvedSkill> {
	try {
		const response = await callDivoGateway(
			options.config,
			{
				op: "skills.get",
				departmentId: options.departmentId,
				payload: { skillId: options.candidate.id },
			},
			options.fetchImpl ?? fetch,
		);
		if (!response.body.ok || response.body.status !== "success") {
			options.notes.push(`Backend skills.get returned ${response.body.status} for the selected skill.`);
			return options.candidate;
		}
		const skill = readLoadedSkill(response.body.data);
		if (!skill || skill.id !== options.candidate.id) {
			options.notes.push("Backend skills.get returned an invalid selected-skill contract.");
			return options.candidate;
		}
		return {
			...options.candidate,
			name: skill.name,
			description: skill.description,
			toolIds: skill.toolIds,
			instructions: skill.instructions,
			revision: skill.revision,
			nextAction: "Follow the loaded approved recipe directly; do not repeat skill or catalogue discovery.",
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		options.notes.push(`Selected company skill could not be loaded: ${message}`);
		return options.candidate;
	}
}

function readLoadedSkill(data: unknown): {
	id: string;
	name: string;
	description: string;
	instructions: string;
	toolIds: string[];
	revision?: number;
} | null {
	if (!data || typeof data !== "object") return null;
	const skill = (data as { skill?: unknown }).skill;
	if (!skill || typeof skill !== "object") return null;
	const raw = skill as Record<string, unknown>;
	const id = readString(raw.id);
	const name = readString(raw.name);
	const description = readString(raw.description);
	const instructions = readString(raw.instructions);
	if (!id || !name || !description || !instructions || !Array.isArray(raw.toolIds)) return null;
	return {
		id,
		name,
		description,
		instructions,
		toolIds: raw.toolIds.filter((value): value is string => typeof value === "string"),
		revision: typeof raw.revision === "number" ? raw.revision : undefined,
	};
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
		nextAction: "The resolver will load this recipe automatically if selected.",
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
