import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	auditTurnSurface,
	planTurnSurface,
	type ObservedTurnSurface,
} from "./turn-surface.ts";

const CATALOGUE = [
	{ name: "divo_google_sheets", schemaBytes: 2_184 },
	{ name: "divo_google_gmail", schemaBytes: 1_319 },
	{ name: "divo_zoho_books", schemaBytes: 1_613 },
	{ name: "divo_lark_task", schemaBytes: 900 },
];

function observed(overrides: Partial<ObservedTurnSurface> = {}): ObservedTurnSurface {
	return {
		toolNames: ["divo_google_sheets", "divo_google_gmail"],
		toolSchemaBytes: 3_503,
		systemPromptBytes: 1_000,
		messagesBytes: 1_200,
		...overrides,
	};
}

describe("planTurnSurface", () => {
	it("splits catalogue bytes into what is shown and what is withheld", () => {
		const plan = planTurnSurface({
			mode: "retrieved",
			catalogue: CATALOGUE,
			visibleToolNames: ["divo_google_sheets", "divo_google_gmail"],
		});
		assert.equal(plan.ledger.plannedToolSchemaBytes, 3_503);
		assert.equal(plan.ledger.deferredToolSchemaBytes, 2_513);
	});

	it("keeps the eager fallback a plan so its bytes stay measured", () => {
		const plan = planTurnSurface({ mode: "eager", catalogue: CATALOGUE, visibleToolNames: [] });
		assert.deepEqual(plan.visibleToolNames, CATALOGUE.map(entry => entry.name));
		assert.equal(plan.ledger.plannedToolSchemaBytes, 6_016);
		assert.equal(plan.ledger.deferredToolSchemaBytes, 0);
	});

	it("ignores a requested name the catalogue does not govern", () => {
		const plan = planTurnSurface({
			mode: "retrieved",
			catalogue: CATALOGUE,
			visibleToolNames: ["divo_google_sheets", "bash"],
		});
		assert.deepEqual(plan.visibleToolNames, ["divo_google_sheets"]);
	});
});

describe("auditTurnSurface", () => {
	const plan = planTurnSurface({
		mode: "retrieved",
		catalogue: CATALOGUE,
		visibleToolNames: ["divo_google_sheets", "divo_google_gmail"],
	});

	it("passes when the request matches the plan", () => {
		const drift = auditTurnSurface(plan, observed());
		assert.equal(drift.withinPlan, true);
		assert.deepEqual(drift.reasons, []);
	});

	it("leaves Pi built-ins out of the audit", () => {
		const drift = auditTurnSurface(plan, observed({
			toolNames: ["divo_google_sheets", "divo_google_gmail", "bash", "read"],
		}));
		assert.equal(drift.withinPlan, true);
		assert.deepEqual(drift.unplannedToolNames, []);
	});

	// The measured defect: retrieval planned 5 governed tools worth 18,691 bytes
	// and contract enrichment put 55 tools worth 148,048 bytes on the wire.
	it("catches governed tools that reached the model outside the plan", () => {
		const drift = auditTurnSurface(plan, observed({
			toolNames: ["divo_google_sheets", "divo_google_gmail", "divo_zoho_books", "divo_lark_task"],
		}));
		assert.equal(drift.withinPlan, false);
		assert.deepEqual(drift.unplannedToolNames, ["divo_zoho_books", "divo_lark_task"]);
	});

	it("catches a visible schema that grew after the plan was costed", () => {
		const drift = auditTurnSurface(plan, observed({ toolSchemaBytes: 148_048 }));
		assert.equal(drift.withinPlan, false);
		assert.deepEqual(drift.unplannedToolNames, []);
		assert.equal(drift.overBudgetBytes, 148_048 - plan.ledger.maxToolSchemaBytes);
		assert.equal(drift.plannedToolSchemaBytes, 3_503);
	});

	it("catches a planned tool that never reached the model", () => {
		const drift = auditTurnSurface(plan, observed({ toolNames: ["divo_google_sheets"] }));
		assert.equal(drift.withinPlan, false);
		assert.deepEqual(drift.missingToolNames, ["divo_google_gmail"]);
	});
});
