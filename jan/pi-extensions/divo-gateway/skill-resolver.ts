import {
	callDivoGateway,
	type DivoGatewayConfig,
	resolveDivoGatewayConfig,
} from "./gateway-client.ts";
import { readDivoRunCorrelation } from "./run-correlation.ts";
import {
	formatWorkBootstrap,
	parseWorkBootstrap,
	type WorkBootstrap,
} from "./work-bootstrap.ts";

/**
 * Company skill policy: Divo Dex resolves company work only through the
 * authenticated backend registry. Local skill files are never candidates.
 */
export const DIVO_SKILL_POLICY = "cloud_only" as const;

export interface ResolvedSkill {
	id: string;
	slug?: string;
	name: string;
	description: string;
	score: number;
	confidence: "high" | "medium" | "low";
	reason: string;
	source: "persona_link" | "skill_search" | "google_plan";
	toolIds?: string[];
	instructions?: string;
	revision?: number;
	matchedQueries?: string[];
	personaReferences?: Array<{ nodeId: string; scopeKey: string; ruleKey: string }>;
	orchestrationPlan?: GoogleVendorOnboardingPlan;
}

export interface ResolvedPersonaRule {
	nodeId: string;
	scopeKey: string;
	ruleKey: string;
	kind: string;
	instruction: string;
	confidence: number;
	matchScore: number;
	matchedOn: string[];
	learningSources: Array<{
		source: "teach" | "conversation";
		sourceId: string;
		rationale: string;
		evidenceRefs: string[];
		learnedAt: string;
	}>;
}

export interface SkillResolveResult {
	policy: typeof DIVO_SKILL_POLICY;
	query: string;
	queries: string[];
	selected: ResolvedSkill | null;
	results: ResolvedSkill[];
	personaRules: ResolvedPersonaRule[];
	rejected: Array<{
		id: string;
		name: string;
		bestScore: number;
		matchedQueries: string[];
		reason: string;
	}>;
	bootstrap?: WorkBootstrap;
	notes: string[];
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
	variants?: string[];
	limit?: number;
	departmentId?: string;
	env?: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
	actionId?: string;
}): Promise<SkillResolveResult> {
	const query = options.query.trim();
	const limit = clampLimit(options.limit);
	const notes: string[] = [];
	const config = options.env
		? resolveDivoGatewayConfig(options.env)
		: resolveDivoGatewayConfig();
	if ("error" in config) {
		notes.push("Company skill registry is unavailable because the Divo gateway is not configured.");
		return {
			policy: DIVO_SKILL_POLICY,
			query,
			queries: [query],
			selected: null,
			results: [],
			personaRules: [],
			rejected: [],
			notes,
		};
	}

	const work = await resolveBackendWork({
		query,
		variants: normalizeVariants(query, options.variants ?? []),
		limit,
		departmentId: options.departmentId,
		config,
		fetchImpl: options.fetchImpl,
		actionId: options.actionId,
		notes,
	});
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
			source: "google_plan",
			reason: "Matched the governed Google vendor-onboarding workflow.",
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
		const results = [selected, ...(work?.results ?? [])];
		return {
			policy: DIVO_SKILL_POLICY,
			query,
			queries: work?.queries ?? [query],
			selected,
			results,
			personaRules: work?.personaRules ?? [],
			rejected: work?.rejected ?? [],
			...(work?.bootstrap ? { bootstrap: work.bootstrap } : {}),
			notes,
		};
	}
	if (vendorOnboarding) {
		// A partial specialist match is not a usable substitute for the requested
		// multi-phase workflow. The plan endpoint already recorded the precise
		// RBAC or contract reason in notes, so fail closed instead of reranking.
		return {
			policy: DIVO_SKILL_POLICY,
			query,
			queries: work?.queries ?? [query],
			selected: null,
			results: work?.results.filter(skill => skill.source === "persona_link") ?? [],
			personaRules: work?.personaRules ?? [],
			rejected: work?.rejected ?? [],
			...(work?.bootstrap ? { bootstrap: work.bootstrap } : {}),
			notes,
		};
	}
	if (work) return { policy: DIVO_SKILL_POLICY, query, selected: work.results[0] ?? null, ...work, notes };
	return {
		policy: DIVO_SKILL_POLICY,
		query,
		queries: [query],
		selected: null,
		results: [],
		personaRules: [],
		rejected: [],
		notes,
	};
}

export function formatSkillResolveResult(result: SkillResolveResult): string {
	if (result.results.length === 0 && result.personaRules.length === 0) {
		const notes = result.notes.length ? `\n\nNotes:\n${result.notes.map((note) => `- ${note}`).join("\n")}` : "";
		return `No matching company skills found for "${result.query}".${notes}`;
	}

	const lines = [
		`Divo work context resolved for: "${result.query}"`,
		"",
		"Queries searched:",
		...result.queries.map((query, index) => `${index + 1}. ${index === 0 ? "Exact request" : `Variant ${index}`}: ${query}`),
		"",
	];

	if (result.personaRules.length) {
		lines.push("Manager persona matches:");
		for (const rule of result.personaRules) {
			lines.push(`- ${rule.scopeKey} / ${rule.ruleKey} (${Math.round(rule.confidence * 100)}% confidence)`);
			lines.push(`  instruction: ${rule.instruction}`);
			lines.push(`  matched on: ${rule.matchedOn.join(", ") || "task context"}`);
			for (const source of rule.learningSources) {
				lines.push(`  evidence: ${source.source} ${source.sourceId} — ${source.rationale}`);
			}
		}
		lines.push("");
	}

	const personaSkills = result.results.filter(skill => skill.source === "persona_link");
	const searchedSkills = result.results.filter(skill => skill.source === "skill_search");
	if (personaSkills.length) {
		lines.push("Required persona-linked skills:");
		for (const skill of personaSkills) appendSkill(lines, skill);
	}
	if (searchedSkills.length) {
		lines.push("Complementary skills selected by search:");
		for (const skill of searchedSkills) appendSkill(lines, skill);
	}
	const planned = result.results.find(skill => skill.orchestrationPlan);
	if (planned?.orchestrationPlan) {
		lines.push("", "Google workflow phases:");
		for (const [index, phase] of planned.orchestrationPlan.phases.entries()) {
			lines.push(`${index + 1}. ${phase.name} — ${phase.skillId}`);
		}
		lines.push(planned.orchestrationPlan.connection.message);
		lines.push("The first phase recipe is loaded above; load each later exact skill ID immediately before its phase.");
	}
	if (result.rejected.length) {
		lines.push("", "Rejected fuzzy matches (do not use):");
		for (const skill of result.rejected) {
			lines.push(`- ${skill.name} score=${skill.bestScore.toFixed(2)} — ${skill.reason}`);
		}
	}

	if (result.bootstrap) {
		lines.push("", ...formatWorkBootstrap(result.bootstrap));
	}

	if (result.notes.length) {
		lines.push("", "Notes:");
		for (const note of result.notes) lines.push(`- ${note}`);
	}

	return lines.join("\n");
}

function appendSkill(lines: string[], skill: ResolvedSkill): void {
	lines.push(`- ${skill.name} · revision ${skill.revision ?? "unknown"} · ${skill.confidence} confidence`);
	lines.push(`  source: ${skill.source === "persona_link" ? "exact manager-persona link" : "multi-query skill search"}`);
	lines.push(`  reason: ${skill.reason}`);
	if (skill.personaReferences?.length) {
		lines.push(`  references: ${skill.personaReferences.map(reference => `${reference.scopeKey}/${reference.ruleKey}`).join(", ")}`);
	}
	if (skill.matchedQueries?.length) lines.push(`  matched queries: ${skill.matchedQueries.join(" | ")}`);
	if (skill.toolIds?.length) lines.push(`  tools: ${skill.toolIds.join(", ")}`);
	if (skill.instructions) lines.push("", `  Loaded recipe for ${skill.name}:`, skill.instructions, "");
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

interface BackendWorkResolution {
	queries: string[];
	results: ResolvedSkill[];
	personaRules: ResolvedPersonaRule[];
	rejected: SkillResolveResult["rejected"];
	bootstrap?: WorkBootstrap;
}

async function resolveBackendWork(options: {
	query: string;
	variants: string[];
	limit: number;
	departmentId?: string;
	config: DivoGatewayConfig;
	fetchImpl?: typeof fetch;
	actionId?: string;
	notes: string[];
}): Promise<BackendWorkResolution | null> {
	try {
		const correlation = await readDivoRunCorrelation().catch(() => undefined);
		const response = await callDivoGateway(
			options.config,
			{
				op: "work.resolve",
				departmentId: options.departmentId,
				payload: {
					query: options.query,
					...(options.variants.length ? { variants: options.variants } : {}),
					limit: options.limit,
				},
				...(correlation ? {
					execution: {
						version: 1 as const,
						threadId: correlation.threadId,
						runId: correlation.runId,
						actionId: options.actionId ?? "divo-skill-resolve",
					},
				} : {}),
			},
			options.fetchImpl ?? fetch,
		);
		if (!response.body.ok || response.body.status !== "success") {
			options.notes.push(`Backend work.resolve returned ${response.body.status}.`);
			return null;
		}
		const resolved = readBackendWorkResolution(response.body.data);
		if (!resolved) options.notes.push("Backend work.resolve returned an invalid resolution contract.");
		return resolved;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		options.notes.push(`Company work resolution failed: ${message}`);
		return null;
	}
}

function normalizeVariants(originalQuery: string, variants: readonly string[]): string[] {
	const exact = originalQuery.replace(/\s+/g, " ").trim().toLowerCase();
	const seen = new Set([exact]);
	const normalized: string[] = [];
	for (const value of variants) {
		const variant = value.replace(/\s+/g, " ").trim();
		const key = variant.toLowerCase();
		if (!variant || seen.has(key)) continue;
		seen.add(key);
		normalized.push(variant);
		if (normalized.length === 2) break;
	}
	return normalized;
}

function readBackendWorkResolution(data: unknown): BackendWorkResolution | null {
	if (!data || typeof data !== "object") return null;
	const raw = data as Record<string, unknown>;
	const queries = Array.isArray(raw.queries)
		? raw.queries.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
		: [];
	const persona = raw.persona && typeof raw.persona === "object"
		? raw.persona as Record<string, unknown>
		: {};
	const personaRules = readPersonaRules(persona.rules);
	const personaSkills = readResolvedSkills(persona.linkedSkills, "persona_link");
	const additionalSkills = readResolvedSkills(raw.additionalSkills, "skill_search");
	const rejected = readRejectedSkills(raw.rejectedSkills);
	const bootstrap = parseWorkBootstrap(raw.bootstrap);
	if (!queries.length) return null;
	return {
		queries,
		results: [...personaSkills, ...additionalSkills],
		personaRules,
		rejected,
		...(bootstrap ? { bootstrap } : {}),
	};
}

function readResolvedSkills(value: unknown, source: "persona_link" | "skill_search"): ResolvedSkill[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item): ResolvedSkill[] => {
		if (!item || typeof item !== "object") return [];
		const envelope = item as Record<string, unknown>;
		const rawSkill = envelope.skill;
		if (!rawSkill || typeof rawSkill !== "object") return [];
		const skill = rawSkill as Record<string, unknown>;
		const id = readString(skill.id);
		const slug = readString(skill.slug);
		const name = readString(skill.name);
		const description = readString(skill.description);
		const instructions = readString(skill.instructions);
		if (!id || !name || !description || !instructions || !Array.isArray(skill.toolIds)) return [];
		const score = source === "skill_search" && typeof envelope.bestScore === "number"
			? envelope.bestScore
			: 10;
		const references = Array.isArray(envelope.references)
			? envelope.references.flatMap((reference): NonNullable<ResolvedSkill["personaReferences"]> => {
				if (!reference || typeof reference !== "object") return [];
				const raw = reference as Record<string, unknown>;
				const nodeId = readString(raw.nodeId);
				const scopeKey = readString(raw.scopeKey);
				const ruleKey = readString(raw.ruleKey);
				return nodeId && scopeKey && ruleKey ? [{ nodeId, scopeKey, ruleKey }] : [];
			})
			: undefined;
		return [{
			id,
			slug,
			name,
			description,
			score,
			confidence: confidenceForScore(score),
			source,
			reason: readString(envelope.reason) ?? (source === "persona_link"
				? "Selected by an exact manager-persona link."
				: "Selected by the bounded multi-query skill search."),
			toolIds: skill.toolIds.filter((toolId): toolId is string => typeof toolId === "string"),
			instructions,
			revision: typeof skill.revision === "number" ? skill.revision : undefined,
			matchedQueries: Array.isArray(envelope.matchedQueries)
				? envelope.matchedQueries.filter((query): query is string => typeof query === "string")
				: undefined,
			personaReferences: references,
		}];
	});
}

function readPersonaRules(value: unknown): ResolvedPersonaRule[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item): ResolvedPersonaRule[] => {
		if (!item || typeof item !== "object") return [];
		const raw = item as Record<string, unknown>;
		const nodeId = readString(raw.nodeId);
		const scopeKey = readString(raw.scopeKey);
		const ruleKey = readString(raw.ruleKey);
		const kind = readString(raw.kind);
		const instruction = readString(raw.instruction);
		if (!nodeId || !scopeKey || !ruleKey || !kind || !instruction) return [];
		return [{
			nodeId,
			scopeKey,
			ruleKey,
			kind,
			instruction,
			confidence: typeof raw.confidence === "number" ? raw.confidence : 0,
			matchScore: typeof raw.matchScore === "number" ? raw.matchScore : 0,
			matchedOn: Array.isArray(raw.matchedOn) ? raw.matchedOn.filter((field): field is string => typeof field === "string") : [],
			learningSources: readLearningSources(raw.learningSources),
		}];
	});
}

function readLearningSources(value: unknown): ResolvedPersonaRule["learningSources"] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item): ResolvedPersonaRule["learningSources"] => {
		if (!item || typeof item !== "object") return [];
		const raw = item as Record<string, unknown>;
		const source = raw.source === "teach" || raw.source === "conversation" ? raw.source : undefined;
		const sourceId = readString(raw.sourceId);
		const rationale = readString(raw.rationale);
		const learnedAt = readString(raw.learnedAt);
		if (!source || !sourceId || !rationale || !learnedAt) return [];
		return [{
			source,
			sourceId,
			rationale,
			evidenceRefs: Array.isArray(raw.evidenceRefs)
				? raw.evidenceRefs.filter((ref): ref is string => typeof ref === "string")
				: [],
			learnedAt,
		}];
	});
}

function readRejectedSkills(value: unknown): SkillResolveResult["rejected"] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item): SkillResolveResult["rejected"] => {
		if (!item || typeof item !== "object") return [];
		const raw = item as Record<string, unknown>;
		const id = readString(raw.id);
		const name = readString(raw.name);
		const reason = readString(raw.reason);
		if (!id || !name || !reason) return [];
		return [{
			id,
			name,
			bestScore: typeof raw.bestScore === "number" ? raw.bestScore : 0,
			matchedQueries: Array.isArray(raw.matchedQueries)
				? raw.matchedQueries.filter((query): query is string => typeof query === "string")
				: [],
			reason,
		}];
	});
}

function clampLimit(limit: number | undefined): number {
	if (!limit || !Number.isFinite(limit)) return 5;
	return Math.max(1, Math.min(5, Math.floor(limit)));
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}
