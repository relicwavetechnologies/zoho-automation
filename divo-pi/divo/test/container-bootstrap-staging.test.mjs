import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stageControllerBootstrap } from "../container-entry.mjs";

/**
 * The bootstrap carries the member's bearer token, so the only property that
 * really matters here is the one the file system will not give you for free:
 * nobody but the runtime user may read it, whatever was on the volume before.
 */
function withTempTarget(run) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "divo-bootstrap-"));
	try {
		return run(path.join(directory, "auth", "bootstrap.json"));
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
}

const BOOTSTRAP = JSON.stringify({ backendUrl: "https://divo.example.com", token: "secret" });

test("stages the bootstrap only the runtime user can read", () => {
	withTempTarget((target) => {
		stageControllerBootstrap(BOOTSTRAP, target);
		assert.equal(fs.statSync(target).mode & 0o777, 0o600);
		assert.equal(fs.readFileSync(target, "utf8"), `${BOOTSTRAP}\n`);
	});
});

test("tightens a bootstrap file that was already there with looser permissions", () => {
	withTempTarget((target) => {
		// `writeFileSync`'s `mode` is applied on creation only, so writing over a
		// world-readable file silently keeps it world-readable. This is the whole
		// reason the staging removes the file first rather than trusting the
		// option, and it is the assertion that fails if that removal goes away.
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, "{}\n", { mode: 0o644 });
		fs.chmodSync(target, 0o644);

		stageControllerBootstrap(BOOTSTRAP, target);

		assert.equal(fs.statSync(target).mode & 0o777, 0o600);
	});
});

test("refuses an empty stdin rather than waiting for a file nobody will write", () => {
	withTempTarget((target) => {
		// The controller always sends the bootstrap now. Falling back to polling
		// the volume would turn a missing pipe into a 30-second stall reported as
		// a controller timeout, which names the wrong thing entirely.
		assert.throws(() => stageControllerBootstrap("", target), /requires a bootstrap on stdin/);
		assert.equal(fs.existsSync(target), false);
	});
});
