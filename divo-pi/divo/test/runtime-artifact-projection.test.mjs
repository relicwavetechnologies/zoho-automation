import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { projectRuntimeArtifact, projectRuntimeProgress } from "../runtime-progress.mjs";

/**
 * When a finished document is announced, and when it must not be.
 *
 * The failure this guards is quiet and one-directional: announcing an artifact
 * that was never stored opens an empty panel beside the reader's conversation,
 * and nothing downstream can tell that from a document that failed to load.
 */

const end = (overrides = {}) => ({
	type: "tool_execution_end",
	toolCallId: "call-1",
	toolName: "divo_artifact",
	isError: false,
	result: {
		details: {
			version: 2,
			artifactId: "q3-review-9f1c2a",
			title: "Q3 review",
			mime: "text/markdown",
			path: "/data/workspace/artifacts/q3-review.md",
			storedVersion: 3,
		},
	},
	...overrides,
});

describe("artifact projection", () => {
	it("announces a document that was actually filed", () => {
		assert.deepEqual(projectRuntimeArtifact(end()), {
			type: "artifact",
			artifactId: "q3-review-9f1c2a",
			title: "Q3 review",
			mime: "text/markdown",
			version: 3,
		});
	});

	it("says nothing when the badge failed", () => {
		// The tool fails when the store refused it. A frame here would open a
		// panel onto a document that does not exist.
		assert.equal(projectRuntimeArtifact(end({ isError: true })), undefined);
	});

	it("says nothing for any other tool, or for a call that has not ended", () => {
		assert.equal(projectRuntimeArtifact(end({ toolName: "write" })), undefined);
		assert.equal(projectRuntimeArtifact({ ...end(), type: "tool_execution_start" }), undefined);
		assert.equal(projectRuntimeArtifact(undefined), undefined);
	});

	it("says nothing when the details do not name a document", () => {
		for (const details of [undefined, {}, { artifactId: "a" }, { artifactId: "a", title: "T" }]) {
			assert.equal(projectRuntimeArtifact(end({ result: { details } })), undefined);
		}
	});

	it("falls back to a first version when the store did not report one", () => {
		const details = { artifactId: "a", title: "T", mime: "text/markdown" };
		assert.equal(projectRuntimeArtifact(end({ result: { details } }))?.version, 1);
	});

	it("leaves the work-log row to the ordinary projection", () => {
		// Two frames from one Pi event, on purpose: the log row settles the step,
		// and the artifact frame carries the result. Neither may swallow the other.
		const progress = projectRuntimeProgress(end());
		assert.equal(progress?.type, "tool_end");
		assert.equal(progress?.toolName, "divo_artifact");
	});
});
