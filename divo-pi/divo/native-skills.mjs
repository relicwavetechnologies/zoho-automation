import { createHash } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { normalizeBackendUrl } from "./auth.mjs";

const DEFAULT_RUNTIME_IMAGE = process.env.DIVO_PI_IMAGE ?? "divo-pi-local:phase0";
export const NATIVE_SKILLS_ROOT = "/run/divo-skills";
const MAX_NATIVE_SKILLS = 100;
const MAX_NATIVE_SKILL_DESCRIPTION_BYTES = 1_024;
const MAX_NATIVE_SKILL_INSTRUCTIONS_BYTES = 100_000;
const MAX_NATIVE_SKILLS_TOTAL_BYTES = 2_000_000;
const RESERVED_NATIVE_SKILL_SLUGS = new Set(
	JSON.parse(
		fs.readFileSync(
			fileURLToPath(new URL("./runtime-manifest.json", import.meta.url)),
			"utf8",
		),
	).trustedSkills ?? [],
);
const stagedNativeSkillDigests = new Map();

export function validateNativeSkillBootstrap(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Native skill bootstrap must be an object");
	}
	if (!Number.isSafeInteger(value.registryRevision) || value.registryRevision < 0) {
		throw new Error("Native skill registry revision is invalid");
	}
	if (!Array.isArray(value.skills) || value.skills.length > MAX_NATIVE_SKILLS) {
		throw new Error(`Native skill bootstrap must contain at most ${MAX_NATIVE_SKILLS} skills`);
	}
	const slugs = new Set();
	let totalBytes = 0;
	const skills = value.skills.map((skill) => {
		if (!skill || typeof skill !== "object" || Array.isArray(skill)) {
			throw new Error("Native skill entry must be an object");
		}
		const { id, slug, name, description, instructions, revision } = skill;
		if (typeof id !== "string" || !id.trim() || id.length > 100) {
			throw new Error("Native skill id is invalid");
		}
		if (
			typeof slug !== "string"
			|| slug.length > 64
			|| !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)
		) {
			throw new Error(`Native skill slug is invalid: ${String(slug)}`);
		}
		if (RESERVED_NATIVE_SKILL_SLUGS.has(slug)) {
			throw new Error(`Native skill slug is reserved by the runtime: ${slug}`);
		}
		if (slugs.has(slug)) throw new Error(`Duplicate native skill slug: ${slug}`);
		slugs.add(slug);
		if (typeof name !== "string" || !name.trim() || name.length > 120) {
			throw new Error(`Native skill name is invalid: ${slug}`);
		}
		if (
			typeof description !== "string"
			|| !description.trim()
			|| Buffer.byteLength(description, "utf8") > MAX_NATIVE_SKILL_DESCRIPTION_BYTES
		) {
			throw new Error(`Native skill description is invalid: ${slug}`);
		}
		if (
			typeof instructions !== "string"
			|| !instructions.trim()
			|| Buffer.byteLength(instructions, "utf8") > MAX_NATIVE_SKILL_INSTRUCTIONS_BYTES
		) {
			throw new Error(`Native skill instructions are invalid: ${slug}`);
		}
		if (!Number.isSafeInteger(revision) || revision < 1) {
			throw new Error(`Native skill revision is invalid: ${slug}`);
		}
		totalBytes += Buffer.byteLength(description, "utf8")
			+ Buffer.byteLength(instructions, "utf8");
		return { id, slug, name: name.trim(), description, instructions, revision };
	});
	if (totalBytes > MAX_NATIVE_SKILLS_TOTAL_BYTES) {
		throw new Error("Native skill bootstrap exceeds the total size limit");
	}
	return { registryRevision: value.registryRevision, skills };
}

export function renderNativeSkillFiles(bootstrap) {
	return validateNativeSkillBootstrap(bootstrap).skills.map((skill) => ({
		slug: skill.slug,
		content: [
			"---",
			`name: ${skill.slug}`,
			`description: ${JSON.stringify(skill.description)}`,
			"---",
			"",
			skill.instructions.trim(),
			"",
		].join("\n"),
	}));
}

export function nativeSkillBootstrapDigest(bootstrap, scope) {
	const validated = validateNativeSkillBootstrap(bootstrap);
	return createHash("sha256")
		.update(JSON.stringify({
			scope: {
				companyId: scope.companyId,
				userId: scope.userId,
				departmentId: scope.departmentId,
				channel: scope.channel,
			},
			bootstrap: validated,
		}))
		.digest("hex");
}

export function nativeSkillLifecycleEvent({
	bootstrap,
	digest,
	staged,
	fetchMs,
	stageMs,
	ephemeral,
	sessionScope,
}) {
	return {
		event: "native_skills.ready",
		registryRevision: bootstrap.registryRevision,
		skillCount: bootstrap.skills.length,
		digest: digest.slice(0, 12),
		staged,
		fetchMs,
		stageMs,
		audience: ephemeral ? "shared" : "private",
		sessionScope,
	};
}

export async function fetchNativeSkillBootstrap({
	backendUrl,
	token,
	departmentId,
	fetchImpl = fetch,
}) {
	if (!departmentId) throw new Error("Native skills require a selected department");
	const query = new URLSearchParams({
		capabilityVersion: "3",
		departmentId,
		nativeSkills: "1",
	});
	const response = await fetchImpl(
		`${normalizeBackendUrl(backendUrl)}/api/desktop/auth/runtime-context?${query}`,
		{ headers: { Authorization: `Bearer ${token}` } },
	);
	const body = await response.json().catch(() => undefined);
	if (!response.ok || body?.success !== true || !body.data?.nativeSkillBootstrap) {
		const error = new Error(body?.message ?? `Native skill bootstrap failed (${response.status})`);
		error.status = response.status;
		throw error;
	}
	return validateNativeSkillBootstrap(body.data.nativeSkillBootstrap);
}

export async function fetchNativeSkillBootstrapOrEmpty(input) {
	try {
		return await fetchNativeSkillBootstrap(input);
	} catch (error) {
		if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500) throw error;
		console.error(`[Pi] Native skill bootstrap unavailable; using bundled skills only: ${error.message}`);
		return { registryRevision: 0, skills: [] };
	}
}

const NATIVE_SKILL_STAGING_SCRIPT = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.DIVO_NATIVE_SKILLS_ROOT || "/run/divo-skills";
const next = path.join(root, ".next");
const previous = path.join(root, ".previous");
const current = path.join(root, "current");
const payload = JSON.parse(fs.readFileSync(0, "utf8"));
if (!payload || !/^[a-f0-9]{64}$/.test(payload.digest) || !Array.isArray(payload.files)) {
	throw new Error("Invalid native skill staging payload");
}
const files = payload.files;
function removeTree(directory) {
	if (!fs.existsSync(directory)) return;
	fs.chmodSync(directory, 0o755);
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory()) removeTree(path.join(directory, entry.name));
	}
	fs.rmSync(directory, { recursive: true, force: true });
}
try {
	const marker = JSON.parse(fs.readFileSync(path.join(current, ".bootstrap.json"), "utf8"));
	if (marker.digest === payload.digest) {
		process.stdout.write("unchanged\n");
		process.exit(0);
	}
} catch {}
removeTree(next);
removeTree(previous);
fs.mkdirSync(next, { recursive: true, mode: 0o755 });
for (const file of files) {
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(file.slug)) throw new Error("Invalid staged skill slug");
	const directory = path.join(next, file.slug);
	fs.mkdirSync(directory, { mode: 0o755 });
	fs.writeFileSync(path.join(directory, "SKILL.md"), file.content, { mode: 0o444 });
}
fs.writeFileSync(
	path.join(next, ".bootstrap.json"),
	JSON.stringify({ digest: payload.digest }),
	{ mode: 0o444 },
);
if (fs.existsSync(current)) fs.renameSync(current, previous);
fs.renameSync(next, current);
removeTree(previous);
process.stdout.write("staged\n");
`;

export function buildNativeSkillStagingArgs(volume, image = DEFAULT_RUNTIME_IMAGE) {
	return [
		"run",
		"--rm",
		"--interactive",
		"--network",
		"none",
		"--user",
		"0:0",
		"--read-only",
		"--cap-drop",
		"ALL",
		"--security-opt",
		"no-new-privileges:true",
		"--mount",
		`type=volume,src=${volume},dst=${NATIVE_SKILLS_ROOT}`,
		"--entrypoint",
		"node",
		image,
		"-e",
		NATIVE_SKILL_STAGING_SCRIPT,
	];
}

export async function stageNativeSkillBootstrap(
	volume,
	bootstrap,
	scope,
	{ force = false, runStaging } = {},
) {
	if (typeof runStaging !== "function") {
		throw new Error("Native skill staging requires a process runner");
	}
	const digest = nativeSkillBootstrapDigest(bootstrap, scope);
	if (!force && stagedNativeSkillDigests.get(volume) === digest) {
		return { digest, staged: false };
	}
	const result = await runStaging(
		"docker",
		buildNativeSkillStagingArgs(volume),
		JSON.stringify({ digest, files: renderNativeSkillFiles(bootstrap) }),
	);
	const status = result?.stdout?.trim();
	if (status !== "staged" && status !== "unchanged") {
		throw new Error("Native skill staging helper returned an invalid status");
	}
	stagedNativeSkillDigests.set(volume, digest);
	return { digest, staged: status === "staged" };
}
