const DEFAULT_FLUSH_MS = 16;
const DEFAULT_MAX_BUFFERED_BYTES = 256 * 1024;

function isAnswerDelta(value) {
	return value?.type === "progress"
		&& value.progress?.type === "answer_delta"
		&& typeof value.progress.delta === "string";
}

function isAnswerReset(value) {
	return value?.type === "progress" && value.progress?.type === "answer_reset";
}

function serialized(value) {
	const line = `${JSON.stringify(value)}\n`;
	return { value, line, bytes: Buffer.byteLength(line), answerDelta: isAnswerDelta(value) };
}

function waitForDrain(response) {
	if (response.destroyed || response.writableEnded) return Promise.resolve(false);
	return new Promise((resolve) => {
		const cleanup = () => {
			response.off("drain", drained);
			response.off("close", closed);
			response.off("error", closed);
		};
		const drained = () => {
			cleanup();
			resolve(true);
		};
		const closed = () => {
			cleanup();
			resolve(false);
		};
		response.once("drain", drained);
		response.once("close", closed);
		response.once("error", closed);
	});
}

/**
 * A bounded, backpressure-aware NDJSON writer for the controller boundary.
 *
 * Live answer fragments are optional presentation state; the final result is
 * authoritative. If a reader is so slow that its live queue reaches the cap,
 * the writer clears that partial answer and suppresses further deltas until a
 * reset or terminal result. It never drops tool lifecycle, errors, or results.
 */
export function createNdjsonStreamWriter(response, options = {}) {
	const flushMs = options.flushMs ?? DEFAULT_FLUSH_MS;
	const maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
	const queue = [];
	let bufferedBytes = 0;
	let timer;
	let pumping = false;
	let currentPump = Promise.resolve();
	let closed = false;
	let suppressAnswerDeltas = false;

	const removeQueuedAnswerDeltas = () => {
		for (let index = queue.length - 1; index >= 0; index -= 1) {
			if (!queue[index].answerDelta) continue;
			bufferedBytes -= queue[index].bytes;
			queue.splice(index, 1);
		}
	};

	const enqueueSerialized = (item) => {
		queue.push(item);
		bufferedBytes += item.bytes;
	};

	const startPump = () => {
		if (closed || pumping || queue.length === 0) return;
		pumping = true;
		currentPump = (async () => {
			while (!closed && queue.length > 0) {
				const item = queue.shift();
				bufferedBytes -= item.bytes;
				if (response.destroyed || response.writableEnded) {
					closed = true;
					break;
				}
				if (!response.write(item.line) && !await waitForDrain(response)) {
					closed = true;
					break;
				}
			}
		})().finally(() => {
			pumping = false;
			if (!closed && queue.length > 0) startPump();
		});
	};

	const schedule = (delay = 0) => {
		if (closed || pumping) return;
		if (delay <= 0) {
			if (timer) clearTimeout(timer);
			timer = undefined;
			startPump();
			return;
		}
		if (timer) return;
		timer = setTimeout(() => {
			timer = undefined;
			startPump();
		}, delay);
	};

	const enqueue = (value) => {
		if (closed || response.destroyed || response.writableEnded) return false;
		if (value?.type === "heartbeat" && queue.some(item => item.value?.type === "heartbeat")) {
			return true;
		}
		if (isAnswerReset(value)) {
			suppressAnswerDeltas = false;
			removeQueuedAnswerDeltas();
		}
		if (isAnswerDelta(value)) {
			if (suppressAnswerDeltas) return false;
			const last = queue.at(-1);
			if (last?.answerDelta) {
				bufferedBytes -= last.bytes;
				const merged = serialized({
					type: "progress",
					progress: {
						...last.value.progress,
						delta: `${last.value.progress.delta}${value.progress.delta}`,
					},
				});
				queue[queue.length - 1] = merged;
				bufferedBytes += merged.bytes;
			} else {
				enqueueSerialized(serialized(value));
			}
			if (bufferedBytes > maxBufferedBytes) {
				removeQueuedAnswerDeltas();
				suppressAnswerDeltas = true;
				enqueueSerialized(serialized({
					type: "progress",
					progress: { type: "answer_reset" },
				}));
				schedule();
				return false;
			}
			schedule(flushMs);
			return true;
		}

		enqueueSerialized(serialized(value));
		schedule();
		return true;
	};

	return {
		enqueue,
		async flush() {
			if (timer) {
				clearTimeout(timer);
				timer = undefined;
			}
			while (!closed && (pumping || queue.length > 0)) {
				if (!pumping) startPump();
				await currentPump;
			}
		},
		get bufferedBytes() {
			return bufferedBytes;
		},
	};
}
