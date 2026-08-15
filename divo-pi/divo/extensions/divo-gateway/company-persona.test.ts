import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DIVO_COMPANY_PERSONA_PROMPT } from './run-prompt.ts';

describe('Divo company persona prompt', () => {
	it('teaches normal Divo conversations the direct scheduling route', () => {
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /Scheduling is a direct core capability/);
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /Read the native Schedule Divo Work skill first/);
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /scheduledWorkflows/);
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /skill is guidance, not an authorization token/i);
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /list, pause, resume, cancel, and run_now/);
	});

	it('teaches the primary agent selective company-wide subagent orchestration', () => {
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /silently evaluate whether subagents would create a clear advantage/i);
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /company-wide workstreams such as research, retrieval from separate systems/i);
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /Subagents do not receive the parent conversation automatically/i);
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /business objective.*department.*persona.*skill context/i);
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /do not delegate approval authority, external mutations, messages/i);
		assert.match(DIVO_COMPANY_PERSONA_PROMPT, /Keep this orchestration private/i);
		assert.doesNotMatch(DIVO_COMPANY_PERSONA_PROMPT, /use subagents whenever possible/i);
	});

});
