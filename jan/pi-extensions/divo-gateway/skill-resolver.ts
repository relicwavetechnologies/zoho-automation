import {
	existsSync,
	readdirSync,
	readFileSync,
	statSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
import {
	callDivoGateway,
	type DivoGatewayConfig,
	resolveDivoGatewayConfig,
} from "./gateway-client.ts";

export type SkillSource = "backend" | "local";

export interface ResolvedSkill {
	source: SkillSource;
	id: string;
	name: string;
	description: string;
	score: number;
	confidence: "high" | "medium" | "low";
	nextAction: string;
	reason: string;
	toolIds?: string[];
	filePath?: string;
}

export interface SkillResolveResult {
	query: string;
	selected: ResolvedSkill | null;
	results: ResolvedSkill[];
	notes: string[];
}

interface LocalSkill {
	name: string;
	description: string;
	filePath: string;
	body: string;
	disableModelInvocation: boolean;
}

interface BackendSkillCandidate {
	id: string;
	name: string;
	description: string;
	score?: number;
	toolIds?: string[];
}

const RESERVED_LOCAL_SKILLS = new Set(["divo-gateway"]);

const BACKEND_TERMS = new Set([
	"company",
	"crm",
	"zoho",
	"books",
	"invoice",
	"google",
	"gmail",
	"drive",
	"calendar",
	"workspace",
	"shared",
	"connection",
	"connections",
	"rbac",
	"approval",
	"department",
	"admin",
	"lark",
	"mail",
]);

const LOCAL_TERMS = new Set([
	"local",
	"file",
	"files",
	"folder",
	"workspace",
	"code",
	"debug",
	"pdf",
	"image",
	"ocr",
	"screenshot",
	"document",
	"docx",
	"csv",
	"xlsx",
]);

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

	const [backendResults, localResults] = await Promise.all([
		searchBackendSkills({ query, limit, departmentId: options.departmentId, env, fetchImpl: options.fetchImpl, notes }),
		Promise.resolve(searchLocalSkills(query, env)),
	]);

	const ranked = [...backendResults, ...localResults]
		.sort((a, b) => b.score - a.score || sourceOrder(a.source) - sourceOrder(b.source) || a.name.localeCompare(b.name))
		.slice(0, limit)
		.map((skill) => ({
			...skill,
			confidence: confidenceForScore(skill.score),
		}));

	return {
		query,
		selected: ranked[0] ?? null,
		results: ranked,
		notes,
	};
}

export function formatSkillResolveResult(result: SkillResolveResult): string {
	if (result.results.length === 0) {
		const notes = result.notes.length ? `\n\nNotes:\n${result.notes.map((note) => `- ${note}`).join("\n")}` : "";
		return `No matching Divo or local skills found for "${result.query}".${notes}`;
	}

	const selected = result.selected;
	const lines = [
		`Unified skill resolver completed for: "${result.query}"`,
		"",
		selected
			? `Selected: ${selected.name} (${selected.source}, ${selected.confidence} confidence)`
			: "Selected: none",
		"",
		"Ranked skills:",
	];

	for (const skill of result.results) {
		lines.push(
			`- ${skill.name} [${skill.source}] score=${skill.score.toFixed(2)} confidence=${skill.confidence}`,
		);
		lines.push(`  reason: ${skill.reason}`);
		lines.push(`  next: ${skill.nextAction}`);
		if (skill.filePath) {
			lines.push(`  file: ${skill.filePath}`);
		}
		if (skill.toolIds?.length) {
			lines.push(`  tools: ${skill.toolIds.join(", ")}`);
		}
	}

	if (result.notes.length) {
		lines.push("", "Notes:");
		for (const note of result.notes) {
			lines.push(`- ${note}`);
		}
	}

	return lines.join("\n");
}

function sourceOrder(source: SkillSource): number {
	return source === "backend" ? 0 : 1;
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
		options.notes.push("Backend skills were skipped because the Divo gateway is not configured.");
		return [];
	}

	try {
		const response = await callDivoGateway(
			config as DivoGatewayConfig,
			{
				op: "skills.search",
				departmentId: options.departmentId,
				payload: { query: options.query, limit: options.limit },
			},
			options.fetchImpl ?? fetch,
		);

		if (!response.body.ok || response.body.status !== "success") {
			options.notes.push(`Backend skills.search returned ${response.body.status}.`);
			return [];
		}

		const skills = readBackendSkills(response.body.data);
		return skills.map((skill) => ({
			source: "backend" as const,
			id: skill.id,
			name: skill.name,
			description: skill.description,
			score: normalizeBackendScore(skill.score, options.query),
			confidence: "low" as const,
			toolIds: skill.toolIds,
			reason: "Matched RBAC-filtered backend skill search.",
			nextAction: `Call divo_gateway with op "skills.get" and payload { "skillId": "${skill.id}" }, then follow that skill recipe.`,
		}));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		options.notes.push(`Backend skills.search failed: ${message}`);
		return [];
	}
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
			toolIds: Array.isArray(raw.toolIds) ? raw.toolIds.filter((v): v is string => typeof v === "string") : undefined,
		}];
	});
}

function searchLocalSkills(query: string, env: NodeJS.ProcessEnv): ResolvedSkill[] {
	const queryWords = tokenize(query);
	if (queryWords.length === 0) return [];

	const skills = discoverLocalSkills(env);
	const localIntentBoost = queryWords.some((word) => LOCAL_TERMS.has(word)) ? 2 : 0;
	const backendIntentPenalty = queryWords.some((word) => BACKEND_TERMS.has(word)) ? -1 : 0;

	return skills
		.map((skill) => {
			const score = scoreText(queryWords, [
				skill.name,
				skill.description,
				skill.body,
			]) + localIntentBoost + backendIntentPenalty;
			return {
				source: "local" as const,
				id: `local:${skill.name}`,
				name: skill.name,
				description: skill.description,
				score,
				confidence: "low" as const,
				filePath: skill.filePath,
				reason: skill.disableModelInvocation
					? "Matched local skill index. This skill is hidden from automatic prompt selection and should be loaded explicitly."
					: "Matched local skill index.",
				nextAction: `Read ${skill.filePath} before acting. Use local tools only if the task is not company/RBAC/connected-account work.`,
			};
		})
		.filter((skill) => skill.score > 0);
}

export function discoverLocalSkills(env: NodeJS.ProcessEnv = process.env): LocalSkill[] {
	const rawDirs = env.DIVO_SKILL_DIRS?.trim();
	if (!rawDirs) return [];

	const seen = new Set<string>();
	const roots = rawDirs.split(delimiter).map((dir) => dir.trim()).filter(Boolean);
	const skills: LocalSkill[] = [];
	for (const root of roots) {
		for (const filePath of findSkillFiles(root)) {
			if (seen.has(filePath)) continue;
			seen.add(filePath);
			const parsed = parseSkillFile(filePath);
			if (!parsed || RESERVED_LOCAL_SKILLS.has(parsed.name)) continue;
			skills.push(parsed);
		}
	}
	return skills;
}

function findSkillFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const rootSkill = join(dir, "SKILL.md");
	if (existsSync(rootSkill) && statSync(rootSkill).isFile()) {
		return [rootSkill];
	}

	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...findSkillFiles(path));
		} else if (entry.isFile() && entry.name.endsWith(".md")) {
			files.push(path);
		}
	}
	return files;
}

function parseSkillFile(filePath: string): LocalSkill | null {
	const raw = readFileSync(filePath, "utf-8");
	const parsed = parseFrontmatter(raw);
	if (!parsed.description) return null;
	return {
		name: parsed.name || dirname(filePath).split(/[\\/]/).pop() || "unnamed-skill",
		description: parsed.description,
		filePath,
		body: parsed.body,
		disableModelInvocation: parsed.disableModelInvocation,
	};
}

function parseFrontmatter(raw: string): {
	name?: string;
	description?: string;
	disableModelInvocation: boolean;
	body: string;
} {
	if (!raw.startsWith("---")) {
		return { body: raw, disableModelInvocation: false };
	}

	const end = raw.indexOf("\n---", 3);
	if (end === -1) {
		return { body: raw, disableModelInvocation: false };
	}

	const frontmatter = raw.slice(3, end).trim();
	const body = raw.slice(end + 4).trim();
	const values = new Map<string, string>();

	for (const line of frontmatter.split(/\r?\n/)) {
		const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
		if (!match) continue;
		values.set(match[1], unquote(match[2]));
	}

	return {
		name: values.get("name"),
		description: values.get("description"),
		disableModelInvocation: values.get("disable-model-invocation") === "true",
		body,
	};
}

function unquote(value: string): string {
	const trimmed = value.trim();
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function normalizeBackendScore(score: number | undefined, query: string): number {
	const base = typeof score === "number" && Number.isFinite(score) ? score : 1;
	const words = tokenize(query);
	const backendBoost = words.some((word) => BACKEND_TERMS.has(word)) ? 3 : 0;
	return base + backendBoost;
}

function scoreText(words: string[], fields: string[]): number {
	const strong = fields.slice(0, 2).join(" ").toLowerCase();
	const full = fields.join(" ").toLowerCase();
	let score = 0;
	for (const word of words) {
		if (strong.includes(word)) score += 3;
		else if (full.includes(word)) score += 1;
	}
	return score;
}

function tokenize(query: string): string[] {
	return query
		.toLowerCase()
		.split(/[^a-z0-9._-]+/)
		.map((word) => word.trim())
		.filter((word) => word.length > 1);
}

function clampLimit(limit: number | undefined): number {
	if (!limit || !Number.isFinite(limit)) return 5;
	return Math.max(1, Math.min(10, Math.floor(limit)));
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}
