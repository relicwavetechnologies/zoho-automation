import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, it } from "node:test";
import { clearDivoGatewaySkillCache } from "./gateway-client.ts";
import {
	discoverLocalSkills,
	formatSkillResolveResult,
	resolveDivoSkills,
} from "./skill-resolver.ts";

function writeSkill(root: string, dir: string, frontmatter: string, body = "Body") {
	const skillDir = join(root, dir);
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(join(skillDir, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}\n`);
}

describe("discoverLocalSkills", () => {
	it("discovers hidden local skills but skips the visible Divo router skill", () => {
		const root = mkdtempSync(join(tmpdir(), "divo-skills-"));
		writeSkill(
			root,
			"local-lark",
			[
				"name: local-lark",
				"description: Personal Lark mail skill",
				"disable-model-invocation: true",
			].join("\n"),
		);
		writeSkill(
			root,
			"divo-gateway",
			[
				"name: divo-gateway",
				"description: Visible router skill",
			].join("\n"),
		);

		const skills = discoverLocalSkills({ DIVO_SKILL_DIRS: root });
		assert.equal(skills.length, 1);
		assert.equal(skills[0].name, "local-lark");
		assert.equal(skills[0].disableModelInvocation, true);
	});
});

describe("resolveDivoSkills", () => {
	it("caches the backend skill catalog and reranks it for later resolves", async () => {
		clearDivoGatewaySkillCache();
		let calls = 0;
		const fetchImpl = async () => {
			calls += 1;
			return new Response(
				JSON.stringify({
					ok: true,
					status: "success",
					data: {
						skills: [
							{
								id: "google-workspace",
								name: "Google Workspace",
								description: "Use connected Google Workspace Gmail Drive Calendar accounts.",
								toolIds: ["googleGmail", "googleDrive", "googleCalendar"],
							},
							{
								id: "zoho",
								name: "Zoho",
								description: "Use connected Zoho CRM and Books accounts.",
								toolIds: ["zohoCrm", "zohoBooks"],
							},
						],
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};
		const env = {
			DIVO_BACKEND_URL: "http://localhost:8000",
			DIVO_MEMBER_TOKEN: "token-catalog-cache",
		};

		const first = await resolveDivoSkills({
			query: "gmail",
			env,
			fetchImpl: fetchImpl as typeof fetch,
		});
		const second = await resolveDivoSkills({
			query: "calendar",
			env,
			fetchImpl: fetchImpl as typeof fetch,
		});

		assert.equal(calls, 1);
		assert.equal(first.selected?.id, "google-workspace");
		assert.equal(second.selected?.id, "google-workspace");
	});

	it("merges backend and local skills and prefers backend for connected account work", async () => {
		const root = mkdtempSync(join(tmpdir(), "divo-skills-"));
		writeSkill(
			root,
			"local-lark",
			[
				"name: local-lark",
				"description: Personal Lark mail skill",
				"disable-model-invocation: true",
			].join("\n"),
			"Use local lark-cli for explicitly personal Lark mail.",
		);

		const fetchImpl = async () =>
			new Response(
				JSON.stringify({
					ok: true,
					status: "success",
					data: {
						skills: [
							{
								id: "google-workspace",
								name: "Google Workspace",
								description: "Use connected Google Workspace Gmail Drive Calendar accounts.",
								score: 3,
								toolIds: ["googleGmail"],
							},
						],
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);

		const result = await resolveDivoSkills({
			query: "list my connected gmail mails",
			env: {
				DIVO_BACKEND_URL: "http://localhost:8000",
				DIVO_MEMBER_TOKEN: "token",
				DIVO_SKILL_DIRS: root,
			},
			fetchImpl: fetchImpl as typeof fetch,
		});

		assert.equal(result.selected?.source, "backend");
		assert.equal(result.selected?.id, "google-workspace");
		assert.match(result.selected?.nextAction ?? "", /skills\.get/);
	});

	it("falls back to local skills when backend is not configured", async () => {
		const root = mkdtempSync(join(tmpdir(), "divo-skills-"));
		const secondary = mkdtempSync(join(tmpdir(), "divo-skills-"));
		writeSkill(
			secondary,
			"ocr-and-documents",
			[
				"name: ocr-and-documents",
				"description: Extract text from PDF image OCR and document files",
				"disable-model-invocation: true",
			].join("\n"),
			"Use OCR for scanned PDFs and images.",
		);

		const result = await resolveDivoSkills({
			query: "extract OCR text from this PDF",
			env: {
				DIVO_SKILL_DIRS: [root, secondary].join(delimiter),
			},
		});

		assert.equal(result.selected?.source, "local");
		assert.equal(result.selected?.name, "ocr-and-documents");
		assert.ok(result.notes.some((note) => /not configured/i.test(note)));
		assert.match(formatSkillResolveResult(result), /Read .*SKILL\.md/);
	});

	it("selects the local image skill for image inspection when backend is unavailable", async () => {
		const root = mkdtempSync(join(tmpdir(), "divo-skills-"));
		writeSkill(
			root,
			"image-analysis",
			[
				"name: image-analysis",
				"description: Analyze local images screenshots receipts photos metadata conversion resize crop OCR",
				"disable-model-invocation: true",
			].join("\n"),
			"Use native image input and local image scripts for screenshots and photos.",
		);
		writeSkill(
			root,
			"ocr-and-documents",
			[
				"name: ocr-and-documents",
				"description: Extract text from PDF OCR and document files",
				"disable-model-invocation: true",
			].join("\n"),
			"Use OCR for scanned PDFs and documents.",
		);

		const result = await resolveDivoSkills({
			query: "inspect this image metadata and dominant colors",
			env: {
				DIVO_SKILL_DIRS: root,
			},
		});

		assert.equal(result.selected?.source, "local");
		assert.equal(result.selected?.name, "image-analysis");
	});
});
