/**
 * Questions a run is currently sitting on.
 *
 * Pi's extension UI is request/response: the run blocks until something writes
 * an answer back. Every answerer this controller had until now was a policy
 * that decided immediately, so "blocked" was never longer than a function call.
 * This is the other kind of answerer — the one where the answer arrives from
 * outside the process, minutes later, because a person had to do something.
 *
 * Parking a question here is what turns a run that ends into a run that waits.
 * The registry owns the two ways a wait can end badly, so no caller has to:
 * the deadline, and the run being abandoned. Both resolve the question rather
 * than leaving it, because an unanswered `ui.confirm` holds the run until the
 * admission slot times out twenty minutes later, and a member who is told
 * nothing for twenty minutes has been failed twice.
 */

/** More than any real member has open at once; a leak stops here, not in memory. */
const DEFAULT_MAX_PENDING = 64;
/** A question nobody could possibly still be answering. */
const MAX_WAIT_MS = 15 * 60_000;

export function createRuntimeAskRegistry({
	maxPending = DEFAULT_MAX_PENDING,
	onEvent,
} = {}) {
	/** askId -> { settle, timer } */
	const pending = new Map();

	const release = (askId, granted, reason) => {
		const parked = pending.get(askId);
		if (!parked) return false;
		pending.delete(askId);
		clearTimeout(parked.timer);
		parked.abortListener?.();
		parked.settle(granted);
		onEvent?.({ event: "runtime_ask.settled", askId, granted, reason });
		return true;
	};

	return {
		get pendingCount() {
			return pending.size;
		},

		/**
		 * Hold a question open. Returns false when it cannot be held, and the
		 * caller must then answer it immediately: a question that is neither
		 * parked nor answered is a run that hangs.
		 */
		park({ askId, settle, expiresAt, signal }) {
			if (typeof askId !== "string" || !askId.trim()) return false;
			if (pending.has(askId)) return false;
			if (pending.size >= maxPending) {
				onEvent?.({ event: "runtime_ask.rejected", askId, reason: "too_many_pending" });
				return false;
			}

			const deadline = Number.isFinite(Date.parse(expiresAt ?? ""))
				? Math.min(Date.parse(expiresAt) - Date.now(), MAX_WAIT_MS)
				: MAX_WAIT_MS;
			if (deadline <= 0) return false;

			const timer = setTimeout(() => release(askId, false, "expired"), deadline);
			timer.unref?.();

			// The run being cancelled has to reach the parked question too. Without
			// this the abort tears down the turn while this map still holds a
			// settle that will never be called.
			const abortListener = signal
				? () => release(askId, false, "aborted")
				: undefined;
			if (signal && abortListener) signal.addEventListener("abort", abortListener, { once: true });

			pending.set(askId, {
				settle,
				timer,
				abortListener: signal && abortListener
					? () => signal.removeEventListener("abort", abortListener)
					: undefined,
			});
			onEvent?.({ event: "runtime_ask.parked", askId, waitMs: deadline });
			return true;
		},

		/** Answer a parked question. False when nothing was waiting for it. */
		answer(askId, granted) {
			return release(askId, granted === true, "answered");
		},
	};
}
