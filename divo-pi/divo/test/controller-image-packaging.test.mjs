import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * `Dockerfile.controller` copies an explicit allowlist of files rather than the
 * whole directory, which keeps the controller image free of the in-container
 * agent entrypoints — but it also means every extraction that adds a module
 * silently drops it from the image. The failure only surfaces as an
 * ERR_MODULE_NOT_FOUND at container start, long after the change.
 *
 * So the allowlist is checked against the real import graph rather than against
 * a second hand-written list, and a module has to be reachable from the server
 * entrypoint before this test will accept it as packaged.
 */
const RUNTIME_DIR = path.join(import.meta.dirname, "..");
const DOCKERFILE = path.join(RUNTIME_DIR, "..", "Dockerfile.controller");
const ENTRYPOINT = "local-rpc-server.mjs";

/**
 * Files a packaged module reads at import time without importing them, so the
 * closure walker cannot see them and a missing one is just as fatal:
 * `native-skills.mjs` parses the trusted runtime manifest at module scope, and
 * the controller never finishes importing without it.
 */
const MODULE_SCOPE_ASSETS = ["runtime-manifest.json"];

function importClosure(entry) {
	const reached = new Set();
	const visit = (file) => {
		if (reached.has(file)) return;
		reached.add(file);
		const source = fs.readFileSync(path.join(RUNTIME_DIR, file), "utf8");
		// `from "./x"` covers import, re-export and multi-line braces; the second
		// arm covers a bare side-effect `import "./x"`, which names no binding.
		for (const [, specifier] of source.matchAll(/(?:from|^\s*import)\s+"(\.\/[^"]+)"/gm)) {
			visit(path.normalize(path.join(path.dirname(file), specifier)));
		}
	};
	visit(entry);
	return reached;
}

/** Everything the shipped image must hold for the entrypoint to import at all. */
function requiredRuntimeFiles() {
	return [...importClosure(ENTRYPOINT), ...MODULE_SCOPE_ASSETS];
}

/** Instructions of the last build stage, with continuation lines rejoined. */
function finalStageInstructions(dockerfile) {
	const joined = dockerfile.replace(/\\\r?\n\s*/g, " ");
	const lines = joined.split("\n").map((line) => line.trim());
	// Only the final stage becomes the shipped image; a COPY in an earlier stage
	// is discarded, and this file already builds in two stages.
	const lastFrom = lines.findLastIndex((line) => /^FROM\s/i.test(line));
	return lines.slice(lastFrom + 1);
}

/**
 * The runtime files the shipped image ends up holding in its own `divo/`.
 *
 * Both halves of a COPY are part of the contract. `COPY divo/runtime-docker.mjs
 * ./lib/` carries the file but not to the specifier `local-rpc-server.mjs`
 * imports, and `COPY --from=<stage>` reads another stage's filesystem rather
 * than the build context, so neither contributes a packaged module here.
 */
function copiedRuntimeFiles(dockerfile) {
	return new Set(
		finalStageInstructions(dockerfile)
			.filter((line) => /^COPY\s/i.test(line))
			.flatMap((line) => {
				const tokens = line.split(/\s+/).slice(1);
				if (tokens.some((token) => token.startsWith("--from="))) return [];
				// `CMD` runs `node divo/local-rpc-server.mjs` from the workdir, so only
				// a copy into the workdir's own `divo/` is on the import path.
				if (tokens.at(-1) !== "./divo/") return [];
				return tokens.slice(0, -1).flatMap((source) => {
					const name = source.startsWith("divo/") ? source.slice("divo/".length) : undefined;
					return name && !name.includes("/") ? [name] : [];
				});
			}),
	);
}

function missingFromImage(dockerfile) {
	const copied = copiedRuntimeFiles(dockerfile);
	return requiredRuntimeFiles().filter((file) => !copied.has(file)).sort();
}

test("the controller image carries every module its entrypoint imports", () => {
	const missing = missingFromImage(fs.readFileSync(DOCKERFILE, "utf8"));
	assert.deepEqual(
		missing,
		[],
		`Dockerfile.controller does not COPY: ${missing.join(", ")}. The image cannot start without them.`,
	);
});

test("the controller image carries nothing the entrypoint cannot reach", () => {
	// A stale entry is not fatal at runtime, but it is how the allowlist stops
	// describing the program it packages.
	const required = new Set(requiredRuntimeFiles());
	const stale = [...copiedRuntimeFiles(fs.readFileSync(DOCKERFILE, "utf8"))]
		.filter((file) => !required.has(file))
		.sort();
	assert.deepEqual(stale, []);
});

test("a module dropped from the allowlist is reported, not tolerated", () => {
	const dockerfile = fs.readFileSync(DOCKERFILE, "utf8");
	assert.deepEqual(
		missingFromImage(dockerfile.replace(" divo/runtime-docker.mjs", "")),
		["runtime-docker.mjs"],
	);
});

test("a COPY that lands somewhere other than divo/ counts as not carried", () => {
	// The sources alone are not the contract. Redirecting the destination keeps
	// every filename on the line while breaking every import specifier.
	const dockerfile = fs.readFileSync(DOCKERFILE, "utf8");
	const redirected = dockerfile.replace(/ \.\/divo\/$/m, " ./lib/");
	assert.notEqual(redirected, dockerfile);
	assert.ok(missingFromImage(redirected).includes(ENTRYPOINT));
});

test("a COPY left behind in an earlier build stage counts as not carried", () => {
	// The layer an earlier stage writes is discarded, so a module copied there
	// is absent from the shipped image while every filename still appears here.
	const dockerfile = fs.readFileSync(DOCKERFILE, "utf8");
	const strandedInFirstStage = dockerfile
		.replace(" divo/runtime-docker.mjs", "")
		.replace(/^(FROM node:.*)$/m, "COPY divo/runtime-docker.mjs ./divo/\n$1");
	assert.deepEqual(missingFromImage(strandedInFirstStage), ["runtime-docker.mjs"]);

	// The manifest is not imported by anything, so it is the artifact most likely
	// to be stranded without notice — and `native-skills.mjs` reads it at module
	// scope, so losing it stops the import just as hard as losing a module.
	const strandedManifest = dockerfile
		.replace(" divo/runtime-manifest.json", "")
		.replace(/^(FROM node:.*)$/m, "COPY divo/runtime-manifest.json ./divo/\n$1");
	assert.deepEqual(missingFromImage(strandedManifest), ["runtime-manifest.json"]);
});

test("the allowlist is read the way Docker reads it", () => {
	// Wrapping a 450-character COPY across continuation lines is the natural next
	// edit to this file, and must not read as though the image lost every module.
	const dockerfile = fs.readFileSync(DOCKERFILE, "utf8");
	const wrapped = dockerfile.replace(/^COPY divo\/(.*)$/m, (line) =>
		line.replace(/ /g, " \\\n\t"),
	);
	assert.notEqual(wrapped, dockerfile);
	assert.deepEqual(missingFromImage(wrapped), []);
});

/** Where `./divo/` resolves for a COPY, and where a workdir-relative CMD runs. */
function workdirs(dockerfile) {
	const instructions = finalStageInstructions(dockerfile);
	const copyIndex = instructions.findIndex(
		(line) => /^COPY\s/i.test(line) && line.endsWith("./divo/"),
	);
	return {
		beforeCopy: instructions.findLast(
			(line, index) => /^WORKDIR\s/i.test(line) && index < copyIndex,
		),
		atStartup: instructions.findLast((line) => /^WORKDIR\s/i.test(line)),
	};
}

test("the guard follows the module the image is actually told to run", () => {
	const dockerfile = fs.readFileSync(DOCKERFILE, "utf8");
	assert.match(dockerfile, new RegExp(`^CMD .*divo/${ENTRYPOINT}`, "m"));
	// That CMD is workdir-relative, so `./divo/` is only the module path the
	// entrypoint imports while one workdir is in force when the COPY runs and
	// still in force at startup. A WORKDIR that moves between them lands the
	// files somewhere `node divo/local-rpc-server.mjs` will not look.
	const { beforeCopy, atStartup } = workdirs(dockerfile);
	assert.equal(beforeCopy, "WORKDIR /app");
	assert.equal(atStartup, beforeCopy);
});

test("a workdir that moves after the COPY counts as not carried", () => {
	const dockerfile = fs.readFileSync(DOCKERFILE, "utf8");
	const copyBeforeWorkdir = dockerfile
		.replace(/^WORKDIR \/app\n/m, "")
		.replace(/^(COPY divo\/.*)$/m, "$1\nWORKDIR /app");
	assert.notEqual(copyBeforeWorkdir, dockerfile);
	assert.equal(workdirs(copyBeforeWorkdir).beforeCopy, undefined);

	const movedAfterCopy = dockerfile.replace(/^(COPY divo\/.*)$/m, "$1\nWORKDIR /app/sub");
	assert.notEqual(workdirs(movedAfterCopy).atStartup, workdirs(movedAfterCopy).beforeCopy);
});
