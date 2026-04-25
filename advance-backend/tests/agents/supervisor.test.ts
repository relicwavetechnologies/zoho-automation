/**
 * SupervisorAgent — unit tests.
 *
 * Tests cover:
 *   1. Domain routing → correct specialist selected
 *   2. Feedback loop: confidence='none' triggers re-delegation to general
 *   3. Error fallback: specialist hard-error falls back to general
 *   4. agentDef passthrough to SupervisorOutput
 *   5. General domain → no re-delegation (prevent infinite loop)
 *
 * All Prisma, Redis, Planner, and Executor dependencies are mocked.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ok, err } from '../../src/shared/result.ts';
import { OrchestrationError } from '../../src/shared/errors.ts';
import { SupervisorAgent } from '../../src/application/orchestration/agents/supervisor.ts';
import { DomainRouter } from '../../src/application/orchestration/agents/domain-router.ts';
import type { SpecialistAgent } from '../../src/application/orchestration/agents/specialist.contract.ts';
import type { SpecialistDomain, SpecialistInput, SpecialistOutput, SupervisorInput } from '../../src/application/orchestration/agents/agent.types.ts';
import type { AgentResolver } from '../../src/application/orchestration/agents/agent-resolver.ts';
import type { AgentDefinitionView } from '../../src/infrastructure/persistence/agent-definition.repository.ts';
import { noopLogger, noopStatus, makePermissionResult, makeTool } from '../helpers/agent-mocks.ts';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const larkTools   = ['larkTask', 'larkMessaging', 'larkCalendar'].map(makeTool);
const googleTools = ['googleGmail', 'googleDrive'].map(makeTool);
const allTools    = [...larkTools, ...googleTools];

function makeAgentResolver(agentDef: AgentDefinitionView | null): AgentResolver {
  return {
    resolve:    async () => agentDef,
    invalidate: async () => {},
  } as unknown as AgentResolver;
}

function makeSpecialist(
  domain:     SpecialistDomain,
  output:     Partial<SpecialistOutput> | 'error' = {},
): SpecialistAgent {
  const fullOutput: SpecialistOutput = {
    stepResults:   [],
    toolOutcomes:  [],
    domain,
    confidence:    'high',
    failedToolIds: [],
    ...output,
  };

  return {
    domain,
    ownedToolIds: [],
    run: async (_input: SpecialistInput) => {
      if (output === 'error') {
        return err(new OrchestrationError({
          stage: 'execute',
          reason: 'step_failed',
          message: `${domain} specialist mock error`,
        }));
      }
      return ok(fullOutput);
    },
  };
}

function makeSupervisorInput(message: string): SupervisorInput {
  return {
    userMessage:    message,
    history:        { turns: [], truncated: false, tokenEstimate: 0 },
    channelType:    'lark',
    channelId:      'chat-001',
    perm:           makePermissionResult(['larkTask', 'larkMessaging', 'googleGmail']),
    runContext: {
      companyId:   'co1' as any,
      userId:      'usr1' as any,
      companyRole: 'MEMBER' as any,
      channel:     'lark',
    },
    statusChannel: noopStatus,
    permittedTools: allTools,
  };
}

// ─── Routing ──────────────────────────────────────────────────────────────────

describe('SupervisorAgent — routing', () => {
  it('routes a lark task message to the lark specialist', async () => {
    let delegatedTo: SpecialistDomain | null = null;

    const trackingSpecialist = (domain: SpecialistDomain): SpecialistAgent => ({
      domain,
      ownedToolIds: [],
      run: async (input: SpecialistInput) => {
        delegatedTo = domain;
        return ok({ stepResults: [], toolOutcomes: [], domain, confidence: 'high', failedToolIds: [] });
      },
    });

    const supervisor = new SupervisorAgent({
      agentResolver: makeAgentResolver(null),
      domainRouter:  new DomainRouter(),
      specialists:   new Map<SpecialistDomain, SpecialistAgent>([
        ['lark',    trackingSpecialist('lark')],
        ['google',  trackingSpecialist('google')],
        ['general', trackingSpecialist('general')],
      ]),
      logger: noopLogger,
    });

    const result = await supervisor.run(makeSupervisorInput('Create a task on Lark for Alice'));
    assert.equal(result.ok, true);
    assert.equal(delegatedTo, 'lark');
  });

  it('routes a gmail message to the google specialist', async () => {
    let delegatedTo: SpecialistDomain | null = null;

    const trackingSpecialist = (domain: SpecialistDomain): SpecialistAgent => ({
      domain,
      ownedToolIds: [],
      run: async () => {
        delegatedTo = domain;
        return ok({ stepResults: [], toolOutcomes: [], domain, confidence: 'high', failedToolIds: [] });
      },
    });

    const supervisor = new SupervisorAgent({
      agentResolver: makeAgentResolver(null),
      domainRouter:  new DomainRouter(),
      specialists:   new Map<SpecialistDomain, SpecialistAgent>([
        ['lark',    trackingSpecialist('lark')],
        ['google',  trackingSpecialist('google')],
        ['general', trackingSpecialist('general')],
      ]),
      logger: noopLogger,
    });

    const result = await supervisor.run(makeSupervisorInput('Send a Gmail to the sales team'));
    assert.equal(result.ok, true);
    assert.equal(delegatedTo, 'google');
  });

  it("routes ambiguous message to 'general'", async () => {
    let delegatedTo: SpecialistDomain | null = null;

    const trackingSpecialist = (domain: SpecialistDomain): SpecialistAgent => ({
      domain,
      ownedToolIds: [],
      run: async () => {
        delegatedTo = domain;
        return ok({ stepResults: [], toolOutcomes: [], domain, confidence: 'high', failedToolIds: [] });
      },
    });

    const supervisor = new SupervisorAgent({
      agentResolver: makeAgentResolver(null),
      domainRouter:  new DomainRouter(),
      specialists:   new Map<SpecialistDomain, SpecialistAgent>([
        ['lark',    trackingSpecialist('lark')],
        ['google',  trackingSpecialist('google')],
        ['general', trackingSpecialist('general')],
      ]),
      logger: noopLogger,
    });

    const result = await supervisor.run(makeSupervisorInput('What is the weather today?'));
    assert.equal(result.ok, true);
    assert.equal(delegatedTo, 'general');
  });
});

// ─── Feedback loop ────────────────────────────────────────────────────────────

describe('SupervisorAgent — feedback loop (re-delegation)', () => {
  it("re-delegates to general when primary specialist returns confidence='none'", async () => {
    const delegationOrder: SpecialistDomain[] = [];

    const larkSpecialist: SpecialistAgent = {
      domain: 'lark',
      ownedToolIds: [],
      run: async () => {
        delegationOrder.push('lark');
        return ok({
          stepResults:   [],
          toolOutcomes:  [],
          domain:        'lark',
          confidence:    'none',    // ← triggers re-delegation
          failedToolIds: ['larkTask'],
        });
      },
    };

    const generalSpecialist: SpecialistAgent = {
      domain: 'general',
      ownedToolIds: [],
      run: async () => {
        delegationOrder.push('general');
        return ok({
          stepResults:   [],
          toolOutcomes:  [],
          domain:        'general',
          confidence:    'high',
          failedToolIds: [],
        });
      },
    };

    const supervisor = new SupervisorAgent({
      agentResolver: makeAgentResolver(null),
      domainRouter:  new DomainRouter(),
      specialists: new Map<SpecialistDomain, SpecialistAgent>([
        ['lark',    larkSpecialist],
        ['general', generalSpecialist],
      ]),
      logger: noopLogger,
    });

    const result = await supervisor.run(makeSupervisorInput('Create a lark task'));
    assert.equal(result.ok, true);
    // Primary was tried, then general was tried
    assert.deepEqual(delegationOrder, ['lark', 'general']);
    if (!result.ok) return;
    assert.equal(result.value.confidence, 'high');
  });

  it("does NOT re-delegate when confidence='partial'", async () => {
    const delegationOrder: SpecialistDomain[] = [];

    const larkSpecialist: SpecialistAgent = {
      domain: 'lark',
      ownedToolIds: [],
      run: async () => {
        delegationOrder.push('lark');
        return ok({
          stepResults:   [],
          toolOutcomes:  [],
          domain:        'lark',
          confidence:    'partial',   // ← partial = some success, no re-delegation
          failedToolIds: ['larkDoc'],
        });
      },
    };

    const supervisor = new SupervisorAgent({
      agentResolver: makeAgentResolver(null),
      domainRouter:  new DomainRouter(),
      specialists: new Map<SpecialistDomain, SpecialistAgent>([
        ['lark',    larkSpecialist],
        ['general', makeSpecialist('general')],
      ]),
      logger: noopLogger,
    });

    const result = await supervisor.run(makeSupervisorInput('Create a lark task'));
    assert.equal(result.ok, true);
    assert.deepEqual(delegationOrder, ['lark']);   // only lark, no re-delegation
    if (!result.ok) return;
    assert.equal(result.value.confidence, 'partial');
  });

  it("does NOT re-delegate when general itself has confidence='none' (no infinite loop)", async () => {
    let callCount = 0;

    const generalSpecialist: SpecialistAgent = {
      domain: 'general',
      ownedToolIds: [],
      run: async () => {
        callCount++;
        return ok({
          stepResults:   [],
          toolOutcomes:  [],
          domain:        'general',
          confidence:    'none',   // even general fails
          failedToolIds: [],
        });
      },
    };

    const supervisor = new SupervisorAgent({
      agentResolver: makeAgentResolver(null),
      domainRouter:  new DomainRouter(),
      specialists: new Map<SpecialistDomain, SpecialistAgent>([
        ['general', generalSpecialist],
      ]),
      logger: noopLogger,
    });

    // Pass NO permitted tools so the router scores 0 on all domains → routes to 'general'.
    // With domain='general', the feedback-loop guard (domain !== 'general') is false → no re-delegation.
    const input: SupervisorInput = {
      ...makeSupervisorInput('What can you do for me?'),
      permittedTools: [],   // ← empty: router gets no tool-score boost, routes 'general'
    };

    const result = await supervisor.run(input);
    assert.equal(result.ok, true);
    assert.equal(callCount, 1);   // called exactly once, no loop
  });

  it('re-delegates to general when primary specialist throws an error', async () => {
    const delegationOrder: SpecialistDomain[] = [];

    const larkSpecialist: SpecialistAgent = {
      domain: 'lark',
      ownedToolIds: [],
      run: async () => {
        delegationOrder.push('lark');
        return err(new OrchestrationError({
          stage: 'execute',
          reason: 'step_failed',
          message: 'lark executor exploded',
        }));
      },
    };

    const generalSpecialist: SpecialistAgent = {
      domain: 'general',
      ownedToolIds: [],
      run: async () => {
        delegationOrder.push('general');
        return ok({
          stepResults:   [],
          toolOutcomes:  [],
          domain:        'general',
          confidence:    'high',
          failedToolIds: [],
        });
      },
    };

    const supervisor = new SupervisorAgent({
      agentResolver: makeAgentResolver(null),
      domainRouter:  new DomainRouter(),
      specialists: new Map<SpecialistDomain, SpecialistAgent>([
        ['lark',    larkSpecialist],
        ['general', generalSpecialist],
      ]),
      logger: noopLogger,
    });

    const result = await supervisor.run(makeSupervisorInput('Create a lark task'));
    assert.equal(result.ok, true);
    assert.deepEqual(delegationOrder, ['lark', 'general']);
  });
});

// ─── SupervisorOutput ─────────────────────────────────────────────────────────

describe('SupervisorAgent — output contract', () => {
  it('includes agentDef from the resolver in the output', async () => {
    const agentDef: AgentDefinitionView = {
      id:           'adef-1',
      name:         'Acme Lark Agent',
      systemPrompt: 'You are a Lark assistant',
      children: [],
    };

    const supervisor = new SupervisorAgent({
      agentResolver: makeAgentResolver(agentDef),
      domainRouter:  new DomainRouter(),
      specialists: new Map<SpecialistDomain, SpecialistAgent>([
        ['lark',    makeSpecialist('lark', { confidence: 'high' })],
        ['general', makeSpecialist('general', { confidence: 'high' })],
      ]),
      logger: noopLogger,
    });

    const result = await supervisor.run(makeSupervisorInput('Create a task on Lark'));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.agentDef?.name, 'Acme Lark Agent');
  });

  it('includes confidence and failedToolIds from the specialist', async () => {
    const supervisor = new SupervisorAgent({
      agentResolver: makeAgentResolver(null),
      domainRouter:  new DomainRouter(),
      specialists: new Map<SpecialistDomain, SpecialistAgent>([
        ['lark', makeSpecialist('lark', {
          confidence:    'partial',
          failedToolIds: ['larkDoc'],
        })],
        ['general', makeSpecialist('general')],
      ]),
      logger: noopLogger,
    });

    const result = await supervisor.run(makeSupervisorInput('Create a lark task and doc'));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // partial → not re-delegated, confidence preserved
    assert.equal(result.value.confidence, 'partial');
    assert.ok(result.value.failedToolIds.includes('larkDoc'));
  });

  it('returns error when no specialist is registered and no general fallback', async () => {
    const supervisor = new SupervisorAgent({
      agentResolver: makeAgentResolver(null),
      domainRouter:  new DomainRouter(),
      specialists: new Map<SpecialistDomain, SpecialistAgent>(),   // completely empty
      logger: noopLogger,
    });

    const result = await supervisor.run(makeSupervisorInput('Create a lark task'));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.payload.reason, 'no_specialist');
  });
});
