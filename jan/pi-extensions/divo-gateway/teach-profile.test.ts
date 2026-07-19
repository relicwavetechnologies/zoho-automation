import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { buildTeachAgentPrompt, DIVO_COMPANY_PERSONA_PROMPT } from './index.ts';
import { DIVO_RUN_CONTEXT_PATH_ENV, readDivoRunCorrelation } from './run-correlation.ts';

describe('interactive Teach Pi profile', () => {
	it('teaches normal Divo conversations the direct scheduling route', () => {
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /Scheduling is a direct core capability/);
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /scheduledWorkflows/);
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /list, pause, resume, cancel, and run_now/);
	});

	it('reads trusted desktop metadata and builds the evidence-first agent prompt', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'divo-teach-profile-'));
		const path = join(dir, 'run-context.json');
		await writeFile(path, JSON.stringify({
			version: 1,
			threadId: 'teach-thread-1',
			runId: 'run-1',
			profile: 'teach',
			teachSessionId: '29a63a44-c348-4414-b5eb-25246d7eb13d',
			departmentId: 'department-1',
		}));
		const context = await readDivoRunCorrelation({ [DIVO_RUN_CONTEXT_PATH_ENV]: path });
		assert.equal(context.profile, 'teach');
		assert.equal(context.teachSessionId, '29a63a44-c348-4414-b5eb-25246d7eb13d');

		const prompt = buildTeachAgentPrompt(context.teachSessionId!, context.departmentId!);
		assert.match(prompt, /teach\.context\.get/);
		assert.match(prompt, /teach\.learning\.apply/);
		assert.match(prompt, /pasted design system plus a preference.*BOTH/i);
		assert.match(prompt, /untrusted evidence/);
		assert.match(prompt, /Do not execute the demonstrated business workflow/);
		assert.match(prompt, /divo_teach_clarify/);
		assert.match(prompt, /writePolicy\.minConfidence/);
		assert.match(prompt, /writeContract/);
		assert.match(prompt, /Do not use a validation failure as schema discovery/);
		assert.match(prompt, /learning patch is atomic/);
		assert.match(prompt, /never inflate confidence/);
		assert.match(prompt, /Readiness checklist/);
		assert.match(prompt, /CANONICALIZE/);
		assert.match(prompt, /create, merge, replace, retire, ignore, or clarify/);
		assert.match(prompt, /exact \{ nodeId, kind, scopeKey, ruleKey \}/);
		assert.match(prompt, /unresolvedMaterialQuestions must be \[\]/);
		assert.match(prompt, /same conversation/);
		assert.match(prompt, /scheduledWorkflows/);
		assert.match(prompt, /explicitly requested activation/i);
		assert.match(prompt, /never silently activate inferred automation/i);
		await rm(dir, { recursive: true, force: true });
	});
});
