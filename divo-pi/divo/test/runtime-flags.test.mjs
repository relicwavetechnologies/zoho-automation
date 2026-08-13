import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * The register of every environment variable the controller-side runtime reads.
 *
 * A flag nobody can name is a flag nobody can operate: it gets set in one
 * environment on a hunch, does nothing recognisable, and survives because
 * removing it feels riskier than leaving it. So each one is recorded here with
 * the single thing it decides and who sets it, and the test below fails when a
 * new read appears without an entry — or when an entry outlives its last read.
 *
 * `where` is the answer to "who is expected to set this", and is the part worth
 * checking against reality before adding an entry: `unset` means the default is
 * the only behaviour anyone has ever run.
 */
const RUNTIME_FLAGS = {
	DIVO_PI_IMAGE: {
		where: "docker-compose.yml / .dev / .localprod, pinned to a digest by deploy.yml",
		decides: "which Pi image every runtime container, staging writer and attachment writer runs.",
	},
	DIVO_PI_RESOURCE_PREFIX: {
		where: "docker-compose.yml / .dev / .localprod, and both workflow smoke steps",
		decides:
			"the prefix on every container, volume and network name, so one host can run main, dev and localprod without them colliding or reclaiming each other's runtimes.",
	},
	DIVO_PI_ADD_HOST_GATEWAY: {
		where: "docker-compose.yml (false), .dev (false), .localprod (true)",
		decides:
			"whether containers get a host.docker.internal route. Localprod runs the backend on the host, so its runtimes need one; deployed stacks reach the backend over the compose network and must not.",
	},
	DIVO_PI_ENTRY_MODE: {
		where: "divo-pi/Dockerfile, which sets compiled",
		decides:
			"whether Pi starts from compiled output or from TypeScript through tsx. The image ships compiled; a working copy defaults to source so an edit runs without a build.",
	},
	DIVO_PI_KEEPALIVE: {
		where: "unset — an operational kill switch, not deployment configuration",
		decides:
			"whether a finished thread runtime keeps its Pi process for the next turn. Setting it to false makes every turn cold, which is the way to take warm reuse out of the picture during an incident without shipping code.",
	},
	DIVO_CONTROLLER_HOST: {
		where: "docker-compose.yml / .dev / .localprod, all 0.0.0.0",
		decides: "the interface the controller's HTTP server binds; it defaults to loopback.",
	},
	DIVO_CONTROLLER_PORT: {
		where: "docker-compose.yml / .dev / .localprod, all 4317",
		decides: "the port that server listens on.",
	},
	MAX_ACTIVE_RUNS: {
		where: "docker-compose.localprod.yml (2); unset elsewhere, so main and dev admit the default 8",
		decides:
			"how many runs may hold a container at once before further requests are told the runtime is busy.",
	},
	DIVO_NATIVE_SKILLS_ROOT: {
		where: "unset in production; the controller test sets it to stage into a temporary directory",
		decides: "where the skill-staging script writes inside the container.",
	},
	DIVO_BOOTSTRAP_PATH: {
		where: "unset — the path is fixed by the auth volume mount",
		decides: "where the container entrypoint reads the run's signed bootstrap.",
	},
	DIVO_INTERRUPTION_PATH: {
		where: "unset — as above",
		decides: "where the container entrypoint reads a staged interruption.",
	},
	DIVO_BACKEND_URL: {
		where:
			"the operator's shell. The same name is written into every container by runtime.mjs, but that is the per-run contract, not this read",
		decides: "the backend `divo/cli.mjs` talks to when it is run by hand.",
	},
};

const RUNTIME_DIR = path.join(import.meta.dirname, "..");

/**
 * Controller-side runtime modules only — the variables an operator sets.
 *
 * What the extensions read is owned elsewhere, in three kinds, none of which a
 * deployment chooses: the per-run contract `runtime.mjs` writes into the child
 * environment and re-patches on warm reuse (pinned by
 * `RUNTIME_ENVIRONMENT_PATCH_KEYS`); `PI_CODING_AGENT_DIR`, which `runtime.mjs`
 * writes once at spawn and deliberately does not patch, because it is fixed for
 * the life of a container; and two signals an extension sets for itself inside
 * the container — `DIVO_LOCAL_BROKER_SOCKET` from the local broker and
 * `DIVO_LLM_PROXY_ACTIVE` from the LLM extension. `PATH` is the remaining case:
 * inherited from the operating system, and prepended by the broker so its
 * launcher is findable.
 */
function runtimeSources() {
	return fs
		.readdirSync(RUNTIME_DIR)
		.filter((entry) => entry.endsWith(".mjs"))
		.map((entry) => ({ entry, source: fs.readFileSync(path.join(RUNTIME_DIR, entry), "utf8") }));
}

function readFlags() {
	const found = new Map();
	for (const { entry, source } of runtimeSources()) {
		for (const [, name] of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
			found.set(name, [...(found.get(name) ?? []), entry]);
		}
		for (const [, name] of source.matchAll(/process\.env\["([A-Z][A-Z0-9_]*)"\]/g)) {
			found.set(name, [...(found.get(name) ?? []), entry]);
		}
	}
	// Inherited from the operating system rather than chosen by anyone here.
	found.delete("PATH");
	return found;
}

test("every environment variable the runtime reads has one recorded purpose", () => {
	const undocumented = [...readFlags().keys()]
		.filter((name) => !Object.hasOwn(RUNTIME_FLAGS, name))
		.sort();
	assert.deepEqual(
		undocumented,
		[],
		`Undocumented runtime flags: ${undocumented.join(", ")}. Add each to RUNTIME_FLAGS with who sets it and the one thing it decides, or stop reading it.`,
	);
});

test("no recorded flag has outlived the code that read it", () => {
	const read = readFlags();
	const orphaned = Object.keys(RUNTIME_FLAGS).filter((name) => !read.has(name)).sort();
	assert.deepEqual(orphaned, []);
});

test("each flag is read in one place, so it has a single owner", () => {
	// Two modules reading one variable means two defaults, and they drift apart
	// silently: DIVO_PI_IMAGE was read in both runtime-docker and native-skills,
	// each with its own copy of the fallback tag.
	const shared = [...readFlags()]
		.map(([name, files]) => [name, [...new Set(files)]])
		.filter(([, files]) => files.length > 1)
		.map(([name, files]) => `${name} (${files.join(", ")})`)
		.sort();
	assert.deepEqual(shared, []);
});

test("the register describes each flag rather than just naming it", () => {
	for (const [name, entry] of Object.entries(RUNTIME_FLAGS)) {
		assert.ok(entry.where, `${name} does not say who sets it`);
		assert.ok(entry.decides?.length > 30, `${name} does not say what it decides`);
	}
});
