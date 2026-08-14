import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * Every name a runtime module uses is a name it can reach.
 *
 * This exists because of a real outage-shaped bug. Extracting `runtime-rpc.mjs`
 * out of the controller left three of its imports behind: `readline`, used in
 * the `JsonlRpc` constructor, and the two progress projections used on every
 * event line. All three are plain `ReferenceError`s at runtime. The whole suite
 * passed, `node --check` passed, `divo:check` passed, and the container image
 * built — because nothing parses a missing import and nothing in the suite ever
 * constructed a `JsonlRpc` over a real stream. The first member message of the
 * deploy would have taken the controller process down.
 *
 * `npm run divo:types` cannot catch it: `checkJs` is off for this directory. So
 * this asserts the error classes that are never a matter of taste — TS2304 and
 * TS2552 mean a name is not defined or is misspelled, TS6133 means an import
 * nothing uses — and deliberately ignores what tsc says about types. Turning
 * `checkJs` fully on over these files reports 26 further diagnostics, mostly
 * TS2339 on inferred object shapes. That is a small enough number to triage, and
 * widening this guard afterwards is worth doing.
 *
 * The first test below is the one that keeps the other two honest. A guard that
 * silently passes when the compiler never ran is worse than no guard, because it
 * reports green over an unchecked codebase — which is exactly what this file did
 * when it was first written.
 */

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const RUNTIME_MODULES = `${fileURLToPath(new URL("..", import.meta.url))}*.mjs`;

function runTsc(args, environment = process.env) {
	return spawnSync("npx", ["tsc", ...args], {
		cwd: REPO,
		encoding: "utf8",
		shell: true,
		env: environment,
	});
}

function checkRuntimeModules(environment) {
	return runTsc(
		[
			"--allowJs", "--checkJs", "--noEmit",
			// Off deliberately: this is a reference check, not a type check.
			"--strict", "false", "--noImplicitAny", "false", "--noUnusedLocals",
			"--target", "ES2024", "--module", "nodenext", "--moduleResolution", "nodenext",
			RUNTIME_MODULES,
		],
		environment,
	);
}

/**
 * Did the compiler actually run?
 *
 * `spawnSync` with a shell reports a missing command as exit 127 rather than as
 * a spawn error, so the absence of diagnostics is ambiguous between "nothing is
 * wrong" and "nothing was checked" — and the filters below read the second as
 * the first. Asking tsc for its version is the unambiguous positive proof, and
 * it does not depend on knowing which exit code a diagnostic run uses. It uses
 * 2, not 1, which is what the first attempt at this assertion got wrong.
 */
function assertCompilerRan(environment) {
	const version = runTsc(["--version"], environment);
	assert.equal(version.error, undefined, `could not run tsc: ${version.error?.message}`);
	assert.match(
		`${version.stdout}`.trim(),
		/^Version \d+\.\d+/,
		`tsc did not run: ${`${version.stderr}${version.stdout}`.trim().slice(0, 300)}`,
	);
}

const checked = checkRuntimeModules();

test("this guard fails when it cannot check anything", () => {
	// The regression for the guard itself. Without `npx` on PATH the shell exits
	// 127 and prints "command not found" to stderr; every diagnostic filter below
	// then matches nothing, and both assertions pass over a codebase nobody
	// compiled. That is how this file shipped green the first time.
	const blind = { ...process.env, PATH: "/nonexistent" };
	assert.deepEqual(reported(checkRuntimeModules(blind), ["2304", "2552", "6133"]), []);
	assert.throws(() => assertCompilerRan(blind), /tsc did not run/);

	// And the real environment has to satisfy it, or the two tests below are
	// asserting over an empty string.
	assertCompilerRan();
});

test("a runtime module never reaches for a name it did not import", () => {
	assertCompilerRan();
	// TS2304 is "cannot find name"; TS2552 is the same with a spelling suggestion.
	const undefinedNames = reported(checked, ["2304", "2552"]);
	assert.deepEqual(undefinedNames, [], `\n${undefinedNames.join("\n")}`);
});

test("a runtime module never keeps an import it stopped using", () => {
	assertCompilerRan();
	// The other half of the same extraction hazard: moving a function out leaves
	// its imports behind, and an import graph is how both the packaging guard and
	// a reader work out what a module still owns. Thirteen were stale after one
	// such move, and nothing objected.
	const unused = reported(checked, ["6133"]);
	assert.deepEqual(unused, [], `\n${unused.join("\n")}`);
});

/** Every diagnostic tsc reported with one of these codes. */
function reported(result, codes) {
	return `${result.stdout}${result.stderr}`
		.split("\n")
		.filter((line) => new RegExp(`error TS(${codes.join("|")}):`).test(line));
}
