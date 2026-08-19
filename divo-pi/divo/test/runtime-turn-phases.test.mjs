import assert from "node:assert/strict";
import test from "node:test";
import { createTurnPhases } from "../runtime-turn-phases.mjs";

/** A clock that only moves when a test says so, so durations are exact. */
function fakeClock() {
	let value = 1_000;
	const now = () => value;
	now.advance = (ms) => {
		value += ms;
	};
	return now;
}

test("a phase reports what it cost", async () => {
	const now = fakeClock();
	const phases = createTurnPhases(now);
	const result = await phases.measure("skills", async () => {
		now.advance(120);
		return "bootstrap";
	});
	assert.equal(result, "bootstrap");
	assert.equal(phases.ms("skills"), 120);
	assert.deepEqual(phases.samples(), [{
		name: "skills",
		startedAt: 1_000,
		endedAt: 1_120,
		durationMs: 120,
		status: "ok",
	}]);
});

test("a phase that throws is still measured", async () => {
	const now = fakeClock();
	const phases = createTurnPhases(now);
	await assert.rejects(
		phases.measure("model", async () => {
			now.advance(11_000);
			throw new Error("provider unavailable");
		}),
		/provider unavailable/,
	);
	assert.equal(phases.ms("model"), 11_000);
	assert.equal(phases.samples()[0].status, "error");
});

test("a phase that runs twice reports the total, not the last attempt", async () => {
	const now = fakeClock();
	const phases = createTurnPhases(now);
	for (const cost of [400, 700]) {
		await phases.measure("model", async () => now.advance(cost));
	}
	assert.equal(phases.ms("model"), 1_100);
});

test("a span adds up the phases it names and ignores the rest", async () => {
	const now = fakeClock();
	const phases = createTurnPhases(now);
	await phases.measure("start", async () => now.advance(50));
	await phases.measure("prepare", async () => now.advance(200));
	await phases.measure("model", async () => now.advance(9_000));
	assert.equal(phases.spanMs("start", "prepare"), 250);
	assert.equal(phases.spanMs("start", "prepare", "handshake"), 250);
});

test("an unmeasured phase reads as zero rather than undefined", () => {
	const phases = createTurnPhases(fakeClock());
	assert.equal(phases.ms("model"), 0);
	assert.deepEqual(phases.durations(), {});
});

test("wall time is what the member waited, not the sum of the phases", async () => {
	const now = fakeClock();
	const phases = createTurnPhases(now);
	// A gap between phases is still time the member spent waiting, and two
	// concurrent phases are not two waits. Summing `durations()` reports neither
	// correctly, which is why this is measured separately.
	now.advance(70);
	await phases.measure("skills", async () => now.advance(300));
	now.advance(30);
	await phases.measure("model", async () => now.advance(600));
	assert.equal(phases.wallMs(), 1_000);
	assert.equal(phases.spanMs("skills", "model"), 900);
});

test("the record keeps the order phases began, not the order they finished", async () => {
	const now = fakeClock();
	const phases = createTurnPhases(now);
	let releaseFirst;
	let releaseSecond;
	const first = phases.measure("first", () => new Promise((resolve) => {
		releaseFirst = resolve;
	}));
	const second = phases.measure("second", () => new Promise((resolve) => {
		releaseSecond = resolve;
	}));
	// The turn starts a Docker inspect and a backend fetch together and either can
	// win. Recording on completion alone would reorder the record by whichever
	// did, and make two turns' records incomparable for no reason.
	releaseSecond();
	await second;
	releaseFirst();
	await first;
	assert.deepEqual(Object.keys(phases.durations()), ["first", "second"]);
});

test("the record carries every phase the turn ran, in the order it first ran", async () => {
	const now = fakeClock();
	const phases = createTurnPhases(now);
	await phases.measure("skills", async () => now.advance(10));
	await phases.measure("runtime", async () => now.advance(20));
	await phases.measure("skills", async () => now.advance(5));
	assert.deepEqual(phases.durations(), { skills: 15, runtime: 20 });
	assert.deepEqual(Object.keys(phases.durations()), ["skills", "runtime"]);
});

test("a phase still in flight is not reported as costing nothing", async () => {
	const now = fakeClock();
	const phases = createTurnPhases(now);
	let release;
	const inFlight = phases.measure("image", () => new Promise((resolve) => {
		release = resolve;
	}));
	await phases.measure("skills", async () => now.advance(20));
	// The turn can be thrown away while the image inspect is still running. `0`
	// would read as "the Docker round trip was instant" when it never finished.
	assert.deepEqual(phases.durations(), { image: null, skills: 20 });
	now.advance(300);
	release();
	await inFlight;
	assert.deepEqual(phases.durations(), { image: 320, skills: 20 });
});
