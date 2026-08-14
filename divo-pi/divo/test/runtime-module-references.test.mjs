import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * Every name a runtime module uses is a name it can reach.
 *
 * This exists because of a real outage-shaped bug. Extracting `runtime-rpc.mjs`
 * out of the controller left two of its imports behind: `readline`, used in the
 * `JsonlRpc` constructor, and the two progress projections used on every event
 * line. Both are plain `ReferenceError`s at runtime. The whole 243-test suite
 * passed, `node --check` passed, `divo:check` passed, and the container image
 * built — because nothing parses a missing import and nothing in the suite ever
 * constructed a `JsonlRpc` over a real stream. The first member message of the
 * deploy would have taken the controller process down.
 *
 * `npm run divo:types` cannot catch it: `checkJs` is off for this directory, and
 * turning it on surfaces roughly 115 unrelated inference complaints that nobody
 * has triaged. So this asserts the one error class that is never a matter of
 * taste — TS2304 and TS2552 mean a name is not defined or is misspelled, and
 * both are always bugs — and deliberately ignores everything tsc says about
 * types. Widen it when the inference errors get triaged, not before.
 */
function typeCheckRuntimeModules() {
	const divo = fileURLToPath(new URL("..", import.meta.url));
	return spawnSync(
		"npx",
		[
			"tsc",
			"--allowJs", "--checkJs", "--noEmit",
			// Off deliberately: this is a reference check, not a type check.
			"--strict", "false", "--noImplicitAny", "false", "--noUnusedLocals",
			"--target", "ES2024", "--module", "nodenext", "--moduleResolution", "nodenext",
			`${divo}*.mjs`,
		],
		{ cwd: fileURLToPath(new URL("../..", import.meta.url)), encoding: "utf8", shell: true },
	);
}

/** Every diagnostic tsc reported with one of these codes. */
function reported(result, codes) {
	return `${result.stdout}${result.stderr}`
		.split("\n")
		.filter((line) => new RegExp(`error TS(${codes.join("|")}):`).test(line));
}

const checked = typeCheckRuntimeModules();

test("a runtime module never reaches for a name it did not import", () => {
	// TS2304 is "cannot find name"; TS2552 is the same with a spelling suggestion.
	const undefinedNames = reported(checked, ["2304", "2552"]);
	assert.deepEqual(undefinedNames, [], `\n${undefinedNames.join("\n")}`);
});

test("a runtime module never keeps an import it stopped using", () => {
	// The other half of the same extraction hazard: moving a function out leaves
	// its imports behind, and an import graph is how both the packaging guard and
	// a reader work out what a module still owns. Six were stale in the
	// controller after one such move, and nothing objected.
	const unused = reported(checked, ["6133"]);
	assert.deepEqual(unused, [], `\n${unused.join("\n")}`);
});
