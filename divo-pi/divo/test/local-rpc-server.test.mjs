import assert from "node:assert/strict";
import test from "node:test";
import {
	CAPACITY_MESSAGE,
	createAdmissionController,
	createControllerServer,
} from "../local-rpc-server.mjs";

function deferred() {
	let resolve;
	const promise = new Promise((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

test("admission isolates profiles, rejects overload, and accepts a retry", async () => {
	const gates = new Map();
	const calls = [];
	const admission = createAdmissionController({
		maxActiveRuns: 2,
		execute: async (profile) => {
			calls.push(profile);
			const gate = deferred();
			gates.set(profile, gate);
			await gate.promise;
			return { profile, text: "done" };
		},
	});
	const abhishek = admission.run({ profile: "abhishek", message: "work" });
	const anish = admission.run({ profile: "anish", message: "work" });
	assert.equal(admission.activeCount, 2);
	await assert.rejects(
		admission.run({ profile: "abhishek", message: "duplicate" }),
		(error) => error.statusCode === 409 && error.code === "user_busy",
	);
	await assert.rejects(
		admission.run({ profile: "third", message: "overload" }),
		(error) => error.statusCode === 429 && error.code === "capacity_full",
	);
	assert.deepEqual(calls, ["abhishek", "anish"]);
	gates.get("abhishek").resolve();
	await abhishek;
	const third = admission.run({ profile: "third", message: "retry" });
	assert.deepEqual(calls, ["abhishek", "anish", "third"]);
	gates.get("third").resolve();
	gates.get("anish").resolve();
	assert.equal((await third).profile, "third");
	await anish;
	assert.equal(admission.activeCount, 0);
});

test("HTTP overload response is immediate, friendly, and retryable", async (context) => {
	const gate = deferred();
	const { admission, server } = createControllerServer({
		maxActiveRuns: 1,
		execute: async (profile) => {
			await gate.promise;
			return { profile, text: "done" };
		},
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	context.after(() => server.close());
	const { port } = server.address();
	const endpoint = `http://127.0.0.1:${port}/v1/runs`;
	const first = fetch(endpoint, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ profile: "abhishek", message: "work" }),
	});
	while (admission.activeCount === 0) {
		await new Promise((resolve) => setImmediate(resolve));
	}
	const startedAt = Date.now();
	const overloaded = await fetch(endpoint, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ profile: "anish", message: "work" }),
	});
	const payload = await overloaded.json();
	assert.equal(overloaded.status, 429);
	assert.equal(overloaded.headers.get("retry-after"), "60");
	assert.equal(payload.error.code, "capacity_full");
	assert.equal(payload.error.message, CAPACITY_MESSAGE);
	assert.equal(payload.error.retryAfterSeconds, 60);
	assert.ok(Date.now() - startedAt < 1_000);
	gate.resolve();
	assert.equal((await first).status, 200);
});

test("Lark runs admit only the profile derived from a validated runtime lease", async () => {
	const calls = [];
	const admission = createAdmissionController({
		maxActiveRuns: 1,
		resolveLease: async ({ backendUrl, lease }) => {
			calls.push({ kind: "resolve", backendUrl, lease });
			return {
				profile: "cloud-derived",
				thread: "lark-derived",
				backendUrl,
				token: lease,
				userId: "user-1",
				companyId: "company-1",
				instanceId: "pi-local-1",
			};
		},
		executeRuntime: async (runtime, message, options) => {
			calls.push({ kind: "execute", runtime, message, options });
			return { profile: runtime.profile, thread: runtime.thread, text: "done" };
		},
	});

	const result = await admission.runRuntime({
		backendUrl: "https://backend.example",
		runtimeLease: "signed-lease",
		message: " hello ",
		profile: "caller-choice-is-ignored",
		approve: true,
	});

	assert.deepEqual(result, {
		profile: "cloud-derived",
		thread: "lark-derived",
		text: "done",
	});
	assert.equal(calls[1].message, "hello");
	assert.equal(calls[1].runtime.profile, "cloud-derived");
	assert.equal("approve" in calls[1], false);
	assert.equal(calls[1].options.signal, undefined);
});

test("disconnecting a Lark request aborts its admitted runtime", async (context) => {
	const started = deferred();
	const aborted = deferred();
	const admission = createAdmissionController({
		resolveLease: async ({ backendUrl, lease }) => ({
			profile: "cloud-derived",
			thread: "lark-derived",
			backendUrl,
			token: lease,
			userId: "user-1",
			companyId: "company-1",
			instanceId: "pi-local-1",
		}),
		executeRuntime: async (_runtime, _message, { signal }) => {
			started.resolve();
			await new Promise((_, reject) => {
				signal.addEventListener(
					"abort",
					() => {
						aborted.resolve();
						reject(new Error("stopped"));
					},
					{ once: true },
				);
			});
		},
	});
	const { server } = createControllerServer({ admission });
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	context.after(() => server.close());
	const { port } = server.address();
	const controller = new AbortController();
	const request = fetch(`http://127.0.0.1:${port}/v1/lark-runs`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			backendUrl: "https://backend.example",
			runtimeLease: "signed-lease",
			message: "work",
		}),
		signal: controller.signal,
	});
	await started.promise;
	controller.abort();

	await assert.rejects(request, (error) => error.name === "AbortError");
	await aborted.promise;
	while (admission.activeCount !== 0) {
		await new Promise((resolve) => setImmediate(resolve));
	}
	assert.equal(admission.activeCount, 0);
});
