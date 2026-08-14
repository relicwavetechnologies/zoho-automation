import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
	fetchMemberSession,
	fetchRuntimeContext,
	fetchRuntimeSession,
	normalizeBackendUrl,
	readSessionEnvironment,
	selectDepartment,
	signInWithLark,
} from "../auth.mjs";

let server;
let backendUrl;
const requests = [];

before(async () => {
	server = http.createServer((request, response) => {
		requests.push({ method: request.method, url: request.url });
		response.setHeader("Content-Type", "application/json");
		if (request.url === "/api/desktop/auth/lark/authorize-url") {
			response.end(
				JSON.stringify({
					success: true,
					data: { authorizeUrl: "https://open.larksuite.com/login", nonce: "nonce-1" },
				}),
			);
			return;
		}
		if (request.url === "/api/desktop/auth/lark/poll?nonce=nonce-1") {
			response.end(
				JSON.stringify({
					success: true,
					data: { code: "oauth-code", state: "signed-state" },
				}),
			);
			return;
		}
		if (request.url === "/api/desktop/auth/lark/exchange") {
			response.end(
				JSON.stringify({
					success: true,
					data: {
						token: "member-token",
						session: {
							userId: "user-1",
							departments: [{ id: "department-1", name: "Finance" }],
						},
					},
				}),
			);
			return;
		}
		if (
			request.url ===
			"/api/desktop/auth/runtime-context?capabilityVersion=3&departmentId=department-1"
		) {
			assert.equal(request.headers.authorization, "Bearer member-token");
			response.end(
				JSON.stringify({
					success: true,
					data: {
						departmentId: "department-1",
						departmentName: "Finance",
						personaPrompt: "Finance persona",
					},
				}),
			);
			return;
		}
		if (request.url === "/api/desktop/auth/runtime-session") {
			// A lease, never a member token: the two are different questions asked
			// by different callers, and only this one is on a turn's critical path.
			if (request.headers.authorization !== "Bearer runtime-lease") {
				response.statusCode = 403;
				response.end(JSON.stringify({ success: false, message: "A Pi runtime lease is required" }));
				return;
			}
			response.end(
				JSON.stringify({
					success: true,
					data: {
						userId: "user-1",
						companyId: "company-1",
						role: "MEMBER",
						runtime: {
							channel: "lark",
							instanceId: "instance-1",
							threadId: "oc_chat:thread:om_root",
							runId: "run-1",
							chatId: "oc_chat",
							contextAudience: "private",
							departmentId: "department-1",
						},
						departments: [{ id: "department-1", name: "Finance" }],
					},
				}),
			);
			return;
		}
		if (request.url === "/api/desktop/auth/me") {
			assert.equal(request.headers.authorization, "Bearer member-token");
			response.end(
				JSON.stringify({
					success: true,
					data: {
						userId: "user-1",
						companyId: "company-1",
						name: "Test User",
						departments: [{ id: "department-1", name: "Finance" }],
					},
				}),
			);
			return;
		}
		response.statusCode = 404;
		response.end(JSON.stringify({ message: "Not found" }));
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	backendUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
	await new Promise((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
});

describe("Divo browser authentication", () => {
	it("normalizes backend URLs", () => {
		assert.equal(normalizeBackendUrl("localhost:8000/"), "http://localhost:8000");
		assert.equal(normalizeBackendUrl("https://divo.example.com///"), "https://divo.example.com");
	});

	it("completes authorize, poll, and exchange without exposing the token", async () => {
		let authorizeUrl;
		const result = await signInWithLark({
			backendUrl,
			launchBrowser: false,
			pollIntervalMs: 1,
			timeoutMs: 100,
			onAuthorizeUrl: (url) => {
				authorizeUrl = url;
			},
		});
		assert.equal(authorizeUrl, "https://open.larksuite.com/login");
		assert.equal(result.token, "member-token");
		assert.equal(result.session.userId, "user-1");
		assert.deepEqual(
			requests.slice(0, 3).map((request) => request.url),
			[
				"/api/desktop/auth/lark/authorize-url",
				"/api/desktop/auth/lark/poll?nonce=nonce-1",
				"/api/desktop/auth/lark/exchange",
			],
		);
	});

	it("selects a department and fetches capability version 3 context", async () => {
		const departments = [{ id: "department-1", name: "Finance" }];
		const department = selectDepartment(departments, "finance");
		assert.equal(department.id, "department-1");
		const context = await fetchRuntimeContext({
			backendUrl,
			token: "member-token",
			department,
			departments,
		});
		assert.equal(context.personaPrompt, "Finance persona");
		assert.deepEqual(context.departments, ["Finance"]);
	});

	it("safely reads and validates an existing desktop member session", async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "divo-session-"));
		const sessionPath = path.join(directory, "divo.env");
		fs.writeFileSync(
			sessionPath,
			[
				`DIVO_BACKEND_URL=${backendUrl}`,
				"DIVO_MEMBER_TOKEN=member-token",
				"DIVO_DEPARTMENT_ID=department-1",
				"IGNORED_VALUE=$(should-not-run)",
			].join("\n"),
			{ mode: 0o600 },
		);
		const existing = readSessionEnvironment(sessionPath);
		assert.equal(existing.token, "member-token");
		assert.equal(existing.departmentId, "department-1");
		assert.equal(existing.mode, 0o600);
		const session = await fetchMemberSession(existing);
		assert.equal(session.userId, "user-1");
		assert.equal(session.companyId, "company-1");
		fs.rmSync(directory, { recursive: true });
	});

	it("resolves a run's own facts without asking for the member's desktop payload", async () => {
		requests.length = 0;
		const session = await fetchRuntimeSession({ backendUrl, lease: "runtime-lease" });
		assert.equal(session.userId, "user-1");
		assert.equal(session.companyId, "company-1");
		assert.equal(session.runtime.runId, "run-1");
		assert.deepEqual(session.departments, [{ id: "department-1", name: "Finance" }]);
		// The point of the route. `/me` answers the same identity question but
		// assembles a desktop shell's boot payload to do it — the member's mail
		// accounts included — and a turn pays for that on its critical path.
		assert.deepEqual(
			requests.map((entry) => entry.url),
			["/api/desktop/auth/runtime-session"],
		);
	});

	it("reports the backend's refusal rather than a generic failure", async () => {
		await assert.rejects(
			fetchRuntimeSession({ backendUrl, lease: "not-a-lease" }),
			/A Pi runtime lease is required/,
		);
	});
});
