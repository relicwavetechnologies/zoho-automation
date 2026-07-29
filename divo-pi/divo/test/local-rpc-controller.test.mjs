import assert from "node:assert/strict";
import test from "node:test";
import {
	assertExpectedLogin,
	assertPinnedProfile,
	approveHeadlessWorkspaceAction,
	backendUrlForContainer,
	buildContainerCreateArgs,
	loadToken,
	resourcesFor,
	runtimeIdentityNames,
	runtimeContainerNeedsReplacement,
	validateProfileName,
	validateThread,
} from "../local-rpc-controller.mjs";

test("two profiles receive distinct Docker resources", () => {
	const abhishek = resourcesFor("abhishek");
	const anish = resourcesFor("anish");
	assert.notEqual(abhishek.container, anish.container);
	assert.notEqual(abhishek.network, anish.network);
	assert.notEqual(abhishek.volume, anish.volume);
	assert.notEqual(abhishek.authVolume, anish.authVolume);
	assert.equal(abhishek.volume, "divo-pi-local-abhishek");
	assert.equal(anish.volume, "divo-pi-local-anish");
});

test("cloud runtime names are stable, isolated, and safe for Docker", () => {
	const first = runtimeIdentityNames("company-1", "user-1", "lark:chat-1");
	const sameUserOtherThread = runtimeIdentityNames("company-1", "user-1", "lark:chat-2");
	const otherUser = runtimeIdentityNames("company-1", "user-2", "lark:chat-1");

	assert.equal(first.profile, sameUserOtherThread.profile);
	assert.notEqual(first.thread, sameUserOtherThread.thread);
	assert.notEqual(first.profile, otherUser.profile);
	assert.equal(validateProfileName(first.profile), first.profile);
	assert.equal(validateThread(first.thread), first.thread);
});

test("headless mode allows isolated workspace work but not company mutations", () => {
	assert.equal(approveHeadlessWorkspaceAction(
		"divo_approval_v1",
		JSON.stringify({ source: "bash", presentation: { command: "python report.py" } }),
	), true);
	assert.equal(approveHeadlessWorkspaceAction(
		"divo_approval_v1",
		JSON.stringify({ source: "write", presentation: { path: "report.md" } }),
	), true);
	assert.equal(approveHeadlessWorkspaceAction(
		"divo_approval_v1",
		JSON.stringify({ source: "divo", intentId: "server-bound-intent" }),
	), false);
	assert.equal(approveHeadlessWorkspaceAction("other", "{}"), false);
	assert.equal(approveHeadlessWorkspaceAction("divo_approval_v1", "not-json"), false);
});

test("container creation is hardened and contains no member secret", () => {
	const args = buildContainerCreateArgs("abhishek", "divo-pi:test");
	const serialized = args.join(" ");
	assert.match(serialized, /--interactive/);
	assert.match(serialized, /--read-only/);
	assert.match(serialized, /--cap-drop ALL/);
	assert.match(serialized, /no-new-privileges:true/);
	assert.match(serialized, /type=volume,src=divo-pi-local-abhishek,dst=\/data/);
	assert.match(
		serialized,
		/type=volume,src=divo-pi-local-abhishek-auth,dst=\/run\/divo-auth/,
	);
	assert.match(serialized, /--network divo-pi-local-abhishek/);
	assert.match(serialized, /--add-host host\.docker\.internal:host-gateway/);
	assert.doesNotMatch(serialized, /token|password|secret/i);
});

test("cloud container creation can remove the host gateway route", () => {
	const args = buildContainerCreateArgs("abhishek", "divo-pi:test", {
		addHostGateway: false,
	});
	assert.doesNotMatch(args.join(" "), /host\.docker\.internal|host-gateway/);
});

test("a runtime container is replaced only when its image changes", () => {
	const container = {
		Config: { Image: "ghcr.io/relicwavetechnologies/divo-pi:dev-old" },
	};
	assert.equal(
		runtimeContainerNeedsReplacement(
			container,
			"ghcr.io/relicwavetechnologies/divo-pi:dev-new",
		),
		true,
	);
	assert.equal(
		runtimeContainerNeedsReplacement(
			container,
			"ghcr.io/relicwavetechnologies/divo-pi:dev-old",
		),
		false,
	);
});

test("loopback backend URLs are translated only for the container", () => {
	assert.equal(
		backendUrlForContainer("http://127.0.0.1:8000"),
		"http://host.docker.internal:8000",
	);
	assert.equal(
		backendUrlForContainer("https://backend.example"),
		"https://backend.example",
	);
});

test("profile and thread names cannot escape controller-owned resources", () => {
	assert.equal(validateProfileName("Abhishek"), "abhishek");
	assert.equal(validateThread("lark.oc_123"), "lark.oc_123");
	assert.throws(() => validateProfileName("../anish"), /Profile must use/);
	assert.throws(() => validateThread("../../anish"), /Thread must contain/);
});

test("controller rejects an authenticated identity swapped between profiles", () => {
	assert.doesNotThrow(() =>
		assertPinnedProfile(
			{ profile: "abhishek", userId: "user-a", companyId: "company-1" },
			{ userId: "user-a", companyId: "company-1" },
		),
	);
	assert.throws(
		() =>
			assertPinnedProfile(
				{ profile: "abhishek", userId: "user-a", companyId: "company-1" },
				{ userId: "user-b", companyId: "company-1" },
			),
		/does not match pinned profile/,
	);
});

test("login fails closed when the browser authenticates the wrong expected email", () => {
	assert.doesNotThrow(() =>
		assertExpectedLogin(
			{ email: "anishsuman2305@gmail.com" },
			{},
			"AnishSuman2305@gmail.com",
		),
	);
	assert.throws(
		() =>
			assertExpectedLogin(
				{ email: "abhishek@emiactech.com" },
				{},
				"anishsuman2305@gmail.com",
			),
		/Authenticated as .* expected/,
	);
});

test("credential reads are serialized and time out", async () => {
	let releaseFirst;
	let releaseSecond;
	const started = [];
	const readToken = (profile) => {
		started.push(profile);
		return new Promise((resolve) => {
			if (profile === "abhishek") releaseFirst = () => resolve("token-a");
			else releaseSecond = () => resolve("token-b");
		});
	};
	const first = loadToken("abhishek", readToken, 1_000);
	const second = loadToken("anish", readToken, 1_000);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(started, ["abhishek"]);
	releaseFirst();
	assert.equal(await first, "token-a");
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(started, ["abhishek", "anish"]);
	releaseSecond();
	assert.equal(await second, "token-b");
	await assert.rejects(
		loadToken("stuck", () => new Promise(() => {}), 10),
		/Keychain read timed out/,
	);
});
