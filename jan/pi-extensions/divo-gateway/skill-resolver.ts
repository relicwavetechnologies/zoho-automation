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
	orchestrationPlan?: GoogleVendorOnboardingPlan;
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

interface GoogleVendorOnboardingPlan {
	workflow: "vendor_onboarding";
	parent: {
		id: string;
		name: string;
		description: string;
		instructions: string;
	};
	connection: { message: string };
	phases: Array<{
		id: string;
		name: string;
		skillId: string;
		toolId: string;
		skill?: {
			id: string;
			name: string;
			description: string;
			instructions: string;
			toolIds: string[];
			revision?: number;
		};
	}>;
}

type GoogleVendorOnboardingPhaseId =
	| "gmail_source"
	| "google_contact"
	| "calendar_availability"
	| "google_doc"
	| "google_sheet"
	| "calendar_event";

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
	const requestedGooglePhases = deriveVendorOnboardingGooglePhases(query);
	const vendorOnboarding = isVendorOnboardingRequest(query) && requestedGooglePhases.length > 1;
	const googlePlan = vendorOnboarding
		? await planVendorOnboarding({
			phaseIds: requestedGooglePhases,
			departmentId: options.departmentId,
			config,
			fetchImpl: options.fetchImpl,
			notes,
		})
		: null;
	if (googlePlan) {
		const first = googlePlan.phases[0]?.skill;
		const selected: ResolvedSkill = {
			id: "google",
			name: "Google Workspace vendor onboarding",
			description: `Backend-planned ${googlePlan.phases.map((phase) => phase.name).join(" → ")} workflow.`,
			score: 10,
			confidence: "high",
			reason: "Matched the governed Google vendor-onboarding workflow.",
			nextAction: "Follow the phase order. Use the first inline recipe, then load later exact skill IDs immediately before their phase.",
			toolIds: googlePlan.phases.map((phase) => phase.toolId),
			...(first ? {
				instructions: [
					`Google parent guidance (${googlePlan.parent.name}):`,
					googlePlan.parent.instructions,
					"",
					`First specialist recipe (${first.name}):`,
					first.instructions,
				].join("\n"),
				revision: first.revision,
			} : {}),
			orchestrationPlan: googlePlan,
		};
		return { policy: DIVO_SKILL_POLICY, query, selected, results: [selected], notes };
	}
	if (vendorOnboarding) {
		// A partial specialist match is not a usable substitute for the requested
		// multi-phase workflow. The plan endpoint already recorded the precise
		// RBAC or contract reason in notes, so fail closed instead of reranking.
		return { policy: DIVO_SKILL_POLICY, query, selected: null, results: [], notes };
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
	if (selected?.orchestrationPlan) {
		lines.push("", "Google workflow phases:");
		for (const [index, phase] of selected.orchestrationPlan.phases.entries()) {
			lines.push(`${index + 1}. ${phase.name} — ${phase.skillId}`);
		}
		lines.push(selected.orchestrationPlan.connection.message);
		lines.push("The first phase recipe is loaded above; load each later exact skill ID immediately before its phase.");
	}

	if (result.notes.length) {
		lines.push("", "Notes:");
		for (const note of result.notes) lines.push(`- ${note}`);
	}

	return lines.join("\n");
}

function isVendorOnboardingRequest(query: string): boolean {
	return /\bvendor\b/i.test(query) && /\bonboard(?:ing)?\b/i.test(query);
}

async function planVendorOnboarding(options: {
	phaseIds: GoogleVendorOnboardingPhaseId[];
	departmentId?: string;
	config: DivoGatewayConfig;
	fetchImpl?: typeof fetch;
	notes: string[];
}): Promise<GoogleVendorOnboardingPlan | null> {
	try {
		const response = await callDivoGateway(options.config, {
			op: "google.plan",
			departmentId: options.departmentId,
			payload: { workflow: "vendor_onboarding", phaseIds: options.phaseIds },
		}, options.fetchImpl ?? fetch);
		if (!response.body.ok || response.body.status !== "success") {
			options.notes.push(`Backend google.plan returned ${response.body.status}.`);
			return null;
		}
		const plan = readGoogleVendorOnboardingPlan(response.body.data);
		if (!plan) options.notes.push("Backend google.plan returned an invalid workflow contract.");
		return plan;
	} catch (error) {
		options.notes.push(`Google workflow planning failed: ${error instanceof Error ? error.message : String(error)}`);
		return null;
	}
}

function readGoogleVendorOnboardingPlan(data: unknown): GoogleVendorOnboardingPlan | null {
	if (!data || typeof data !== "object") return null;
	const raw = data as Record<string, unknown>;
	if (raw.workflow !== "vendor_onboarding" || !Array.isArray(raw.phases)) return null;
	const rawParent = raw.parent;
	if (!rawParent || typeof rawParent !== "object") return null;
	const parentRecord = rawParent as Record<string, unknown>;
	const parentId = readString(parentRecord.id);
	const parentName = readString(parentRecord.name);
	const parentDescription = readString(parentRecord.description);
	const parentInstructions = readString(parentRecord.instructions);
	if (!parentId || !parentName || !parentDescription || !parentInstructions) return null;
	const connection = raw.connection;
	if (!connection || typeof connection !== "object" || !readString((connection as Record<string, unknown>).message)) return null;
	const phases = raw.phases.flatMap((value): GoogleVendorOnboardingPlan["phases"] => {
		if (!value || typeof value !== "object") return [];
		const phase = value as Record<string, unknown>;
		const id = readString(phase.id);
		const name = readString(phase.name);
		const skillId = readString(phase.skillId);
		const toolId = readString(phase.toolId);
		if (!id || !name || !skillId || !toolId) return [];
		const rawSkill = phase.skill;
		let skill: GoogleVendorOnboardingPlan["phases"][number]["skill"];
		if (rawSkill && typeof rawSkill === "object") {
			const candidate = rawSkill as Record<string, unknown>;
			const skillId = readString(candidate.id);
			const skillName = readString(candidate.name);
			const description = readString(candidate.description);
			const instructions = readString(candidate.instructions);
			if (!skillId || !skillName || !description || !instructions || !Array.isArray(candidate.toolIds)) return [];
			skill = {
				id: skillId, name: skillName, description, instructions,
				toolIds: candidate.toolIds.filter((item): item is string => typeof item === "string"),
				revision: typeof candidate.revision === "number" ? candidate.revision : undefined,
			};
		}
		return [{ id, name, skillId, toolId, ...(skill ? { skill } : {}) }];
	});
	if (!phases.length || !phases[0]?.skill) return null;
	return {
		workflow: "vendor_onboarding",
		parent: {
			id: parentId,
			name: parentName,
			description: parentDescription,
			instructions: parentInstructions,
		},
		connection: { message: readString((connection as Record<string, unknown>).message)! },
		phases,
	};
}

/**
 * Select only Google phases explicitly required by the request. Lark remains
 * a separate governed provider phase and is intentionally not smuggled into
 * the Google plan.
 */
function deriveVendorOnboardingGooglePhases(query: string): GoogleVendorOnboardingPhaseId[] {
	const phases: GoogleVendorOnboardingPhaseId[] = [];
	const add = (phase: GoogleVendorOnboardingPhaseId) => {
		if (!phases.includes(phase)) phases.push(phase);
	};

	if (/\b(?:gmail|email|mail|thread|message)\b/i.test(query)) add("gmail_source");
	if (/\bgoogle\s+contacts?\b|\bgoogle\s+address\s*book\b/i.test(query)) add("google_contact");
	if (/\b(?:availability|free[ -]?busy|time\s+slots?)\b|\bcheck\b[^.\n]{0,60}\bcalendar\b/i.test(query)) {
		add("calendar_availability");
	}
	if (/\bgoogle\s+docs?\b|\bdoc(?:ument)?\s+(?:agenda|brief|summary)\b/i.test(query)) add("google_doc");
	if (/\bgoogle\s+sheets?\b|\bspreadsheet\b|\bsheet\s+tracker\b/i.test(query)) add("google_sheet");
	if (/\b(?:create|schedule|approve)\b[^.\n]{0,80}\bcalendar\s+event\b|\bcalendar\s+event\b/i.test(query)) {
		add("calendar_event");
	}

	return phases;
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
