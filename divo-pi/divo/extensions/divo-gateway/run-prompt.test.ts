import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	composeRunSystemPrompt,
	currentRunPrompt,
	DIVO_COMPANY_PERSONA_PROMPT,
	DIVO_LOCAL_EXECUTION_PROMPT,
	DIVO_LOCAL_EXECUTION_UNAVAILABLE_PROMPT,
} from "./run-prompt.ts";

const NATIVE_SKILL = { filePath: "/run/divo-skills/current/finance-ops-core/SKILL.md" };
const BUNDLED_SKILL = { filePath: "/opt/pi/skills/git/SKILL.md" };

/** The directories a run is told about, none of them read from this process. */
const ENVIRONMENT = {
	DIVO_WORKSPACE_DIR: "/data/workspace",
	DIVO_RUN_DIR: "/data/workspace/.divo/run",
	DIVO_THREAD_WORK_DIR: "/data/state/threads/same-thread/work",
} as NodeJS.ProcessEnv;

function compose(overrides: Partial<Parameters<typeof composeRunSystemPrompt>[0]> = {}) {
	return composeRunSystemPrompt({
		basePrompt: "You are Pi.",
		departmentContext: null,
		skills: [BUNDLED_SKILL],
		cliAvailable: false,
		threadId: "thread-1",
		environment: ENVIRONMENT,
		...overrides,
	});
}

describe("the system prompt one turn is sent", () => {
	it("carries the company persona, the execution route and the run's own directories", () => {
		const { systemPrompt } = compose();
		assert.ok(systemPrompt.includes(DIVO_COMPANY_PERSONA_PROMPT.trim()));
		assert.ok(systemPrompt.includes(DIVO_LOCAL_EXECUTION_UNAVAILABLE_PROMPT));
		assert.ok(systemPrompt.includes("/data/workspace/.divo/run"));
		assert.ok(systemPrompt.includes("thread-1"));
		// Pi's own prompt is the base, not something appended to Divo's.
		assert.ok(systemPrompt.startsWith("You are Pi."));
	});

	it("gives a run the execution text that matches the runtime it actually has", () => {
		// The failure this guards is the prompt disagreeing with the runtime: a
		// turn told to use divo-local on a container where it is not installed
		// spends its steps discovering that.
		const without = compose({ cliAvailable: false }).systemPrompt;
		const with_ = compose({ cliAvailable: true }).systemPrompt;
		assert.ok(without.includes(DIVO_LOCAL_EXECUTION_UNAVAILABLE_PROMPT));
		assert.ok(!without.includes(DIVO_LOCAL_EXECUTION_PROMPT));
		assert.ok(with_.includes(DIVO_LOCAL_EXECUTION_PROMPT));
	});

	it("says a directory is unavailable rather than describing one that is not there", () => {
		// An empty environment used to render `undefined` into the prompt, which
		// the model reads as a path and tries to write to.
		const prompt = currentRunPrompt(undefined, {} as NodeJS.ProcessEnv);
		assert.ok(!prompt.includes("undefined"));
		assert.match(prompt, /workspace root is: unavailable/);
		assert.match(prompt, /session id for this run is: unavailable/);
	});

	it("recognises a native catalogue from Pi's skill list", () => {
		const { nativeSkills, skillSummary } = compose({ skills: [NATIVE_SKILL, BUNDLED_SKILL] });
		assert.equal(nativeSkills, true);
		assert.equal(skillSummary.loaded, 2);
		assert.equal(skillSummary.native, 1);
	});

	it("recognises one that reached the model through the prompt instead", () => {
		// A native catalogue can arrive either way. Reading only the structured
		// list injected legacy UUID routing hints beside a real slug index.
		const { nativeSkills } = compose({
			skills: [BUNDLED_SKILL],
			basePrompt: "You are Pi.\n<location>/run/divo-skills/current/finance/SKILL.md</location>",
		});
		assert.equal(nativeSkills, true);
	});

	it("counts what the model will actually see, not what Pi started with", () => {
		// `exposed` has to be read off the finished prompt. Composition injects
		// the department persona, so a skill reference reaching the model through
		// that route exists in the composed prompt and not in the base one —
		// which is exactly the gap this number is watched for.
		const departmentContext = {
			departmentName: "Finance",
			personaPrompt: "Use <skill>finance-ops-core</skill> first.",
		};
		assert.equal(compose({ departmentContext }).skillSummary.exposed, 1);
		assert.equal(compose().skillSummary.exposed, 0);
	});
});
