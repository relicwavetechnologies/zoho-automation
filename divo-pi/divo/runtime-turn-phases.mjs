/**
 * How long each phase of one turn took.
 *
 * A turn's latency used to be measured wherever it was easy to measure: five
 * `Date.now()` deltas computed inline in the middle of the run, draining into
 * three unrelated log lines. The phase that dominates a turn — waiting on the
 * model — was measured by nothing, because it had no convenient place to
 * subtract two timestamps.
 *
 * That is the wrong way round. What a turn spends its time on is one fact about
 * one turn, so one module owns it and every sink reads from here. Adding a phase
 * is naming it at the call site; nothing else has to change to see it.
 *
 * What `finalize` measures is worth stating, because the number is small and
 * the reason is not obvious: on a successful turn, teardown is a `setTimeout`
 * for a private run and a fire-and-forget reclamation for a shared one. Both
 * were deliberately moved off the turn, so a few milliseconds here is the
 * correct reading and not a sign that teardown is free. The Docker work it
 * defers is a third of a second, and it is `trackRuntimeReclamation` — not this
 * module — that would have to time it.
 *
 * Durations are recorded even when the phase throws. A turn that failed after
 * eleven seconds is exactly the turn whose timings someone will want.
 */
export function createTurnPhases(now = Date.now) {
	const byPhase = new Map();
	const running = new Set();
	const startedAt = now();
	const samples = [];
	return {
		/**
		 * Wall-clock time since the turn began.
		 *
		 * Deliberately not the sum of the phases: phases are allowed to overlap,
		 * and adding two concurrent phases together reports time the turn never
		 * spent. It covers this turn only: the lease resolution and the HTTP around
		 * it belong to the caller, and a member waiting on a reply waited for those
		 * too, so this is a floor on their wait rather than the whole of it.
		 */
		wallMs() {
			return now() - startedAt;
		},
		/**
		 * Run one phase and remember what it cost.
		 *
		 * Re-measuring a name adds to it rather than replacing it, because a phase
		 * can legitimately run more than once in a turn — a transient provider
		 * failure retries the model — and the turn spent the sum, not the last one.
		 */
		async measure(name, work) {
			const phaseStartedAt = now();
			let status = "ok";
			// Claimed on entry rather than on completion, so the record reads in the
			// order phases *began*. Recording on completion alone would reorder the
			// concurrent pair at the start of a turn depending on which of a Docker
			// inspect and a backend fetch happened to win.
			byPhase.set(name, byPhase.get(name) ?? 0);
			running.add(name);
			try {
				return await work();
			} catch (error) {
				status = "error";
				throw error;
			} finally {
				const endedAt = now();
				const durationMs = Math.max(0, endedAt - phaseStartedAt);
				byPhase.set(name, byPhase.get(name) + durationMs);
				samples.push({
					name,
					startedAt: phaseStartedAt,
					endedAt,
					durationMs,
					status,
				});
				running.delete(name);
			}
		},
		ms(name) {
			return byPhase.get(name) ?? 0;
		},
		/** One number for a span that several named phases add up to. */
		spanMs(...names) {
			return names.reduce((total, name) => total + (byPhase.get(name) ?? 0), 0);
		},
		/**
		 * Every phase this turn ran, in the order it began.
		 *
		 * A phase still in flight reports `null`, not `0`. The image inspect is
		 * deliberately left running when the skill fetch throws the turn away, and
		 * reporting that as `0` tells an operator a Docker round trip was instant
		 * when in fact it never finished.
		 */
		durations() {
			return Object.fromEntries(
				[...byPhase].map(([name, ms]) => [name, running.has(name) ? null : ms]),
			);
		},
		/** Bounded source-clock samples for the backend's causal trace ledger. */
		samples() {
			return samples
				.map((sample) => ({ ...sample }))
				.sort((left, right) => left.startedAt - right.startedAt || left.endedAt - right.endedAt);
		},
	};
}
