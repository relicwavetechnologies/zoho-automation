/**
 * Which provider operations the model is shown the exact shape of, this turn.
 *
 * A backend tool like `googleSheets` fronts fifteen provider operations and
 * `googleDocs` nineteen. Binding all of them was what turned a selected Google
 * wrapper from roughly a kilobyte of schema into tens of kilobytes: the runtime
 * had learned every contract, so the model was shown every contract.
 *
 * Knowing a contract and showing a contract are different decisions, and this
 * module owns the second one. Operations that are not bound are not lost — the
 * wrapper keeps its describe-then-call branch listing them by name, so the model
 * can still reach any of them in one extra step. That is the trade: a bounded
 * request now, and one describe call on the rare turn that needs an operation
 * the prompt gave no hint of.
 */
import type { NativeContract, NativeContractCache } from "./catalogue.ts";
import { words } from "./deepseek-tool-surface.ts";

/** Exact provider schema bytes one turn may bind before operations defer. */
export const DEFAULT_MAX_CONTRACT_BYTES = 24_576;

/**
 * Most exact operations one turn binds, however well they score.
 *
 * A prompt names a task, not a shortlist. Past a handful of operations the
 * extra schemas are speculation, and speculation is what this module exists to
 * stop paying for.
 */
export const MAX_BOUND_CONTRACTS = 6;

export interface TieredNativeContracts {
	readonly bound: readonly NativeContract[];
	readonly deferred: readonly NativeContract[];
	readonly boundBytes: number;
	readonly deferredBytes: number;
}

function contractBytes(contract: NativeContract): number {
	try {
		return Buffer.byteLength(JSON.stringify(contract.inputSchema));
	} catch {
		return 0;
	}
}

/**
 * Score each operation by how much its matched words distinguish it.
 *
 * Plain overlap does not work here. Every Google Sheets operation says "sheet"
 * and every Gmail one says "message", so asking "what can you do with google
 * sheets?" matched twenty-eight of twenty-nine operations and bound nearly the
 * whole family — the exact outcome this module exists to prevent. Weighting a
 * token by how rare it is across the eligible operations makes the shared
 * vocabulary worth almost nothing and lets "append", "reply" or "permissions"
 * decide.
 */
function relevanceScores(
	contracts: readonly NativeContract[],
	queryTokens: ReadonlySet<string>,
): number[] {
	if (queryTokens.size === 0 || contracts.length === 0) return contracts.map(() => 0);
	const documents = contracts.map(
		contract => new Set(words(`${contract.nativeTool} ${contract.description ?? ""}`)),
	);
	const documentFrequency = new Map<string, number>();
	for (const document of documents) {
		for (const token of document) {
			documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
		}
	}
	return documents.map((document) => {
		let score = 0;
		for (const token of queryTokens) {
			if (!document.has(token)) continue;
			const frequency = documentFrequency.get(token) ?? 0;
			score += Math.log(1 + (contracts.length - frequency + 0.5) / (frequency + 0.5));
		}
		return score;
	});
}

/**
 * Choose the exact operation contracts worth this turn's bytes.
 *
 * Only operations belonging to a tool the model can actually see are eligible:
 * binding a schema onto a wrapper the turn already deferred would spend bytes on
 * a capability the model was not offered. Ranking is by prompt overlap, then by
 * size, so a cheap confident match outranks an expensive speculative one.
 */
export function tierNativeContracts(input: {
	readonly cache: NativeContractCache;
	readonly visibleToolIds: readonly string[];
	readonly query: string;
	readonly maxContractBytes?: number;
}): TieredNativeContracts {
	const visible = new Set(input.visibleToolIds);
	const eligible = [...input.cache.values()].filter(contract => visible.has(contract.toolId));
	const queryTokens = new Set(words(input.query));
	const budget = input.maxContractBytes ?? DEFAULT_MAX_CONTRACT_BYTES;

	const scores = relevanceScores(eligible, queryTokens);
	const ranked = eligible
		.map((contract, index) => ({
			contract,
			index,
			bytes: contractBytes(contract),
			score: scores[index] ?? 0,
		}))
		.sort((left, right) =>
			right.score - left.score
			|| left.bytes - right.bytes
			|| left.index - right.index);

	// Relative, so one weak match in an otherwise unrelated prompt cannot drag a
	// whole family in behind it.
	const minimumScore = (ranked[0]?.score ?? 0) * 0.5;
	const bound: NativeContract[] = [];
	const deferred: NativeContract[] = [];
	let boundBytes = 0;
	let deferredBytes = 0;
	for (const candidate of ranked) {
		// An operation the prompt gives no hint of stays on describe-then-call
		// rather than competing for the turn's budget on size alone.
		const earnsBytes = candidate.score > 0
			&& candidate.score >= minimumScore
			&& bound.length < MAX_BOUND_CONTRACTS
			&& boundBytes + candidate.bytes <= budget;
		if (earnsBytes) {
			bound.push(candidate.contract);
			boundBytes += candidate.bytes;
			continue;
		}
		deferred.push(candidate.contract);
		deferredBytes += candidate.bytes;
	}
	return { bound, deferred, boundBytes, deferredBytes };
}
