import { agentRegistry } from '../../agents';
import { extractJsonObject } from '../langchain';
import { buildPlanFromIntent } from '../routing-heuristics';
import type { LangGraphPlanSource, LangGraphRouteState } from './langgraph.types';

const REQUIRED_START_STEP = 'route.classify';
const REQUIRED_END_STEP = 'synthesis.compose';
const AGENT_STEP_PREFIX = 'agent.invoke.';

const ALLOWED_BOUNDARY_STEPS = new Set([
  'route.classify',
  'plan.build',
  'hitl.gate',
  'error.classify_retry',
  'synthesis.compose',
  'response.send',
  'finalize.task',
]);

export const buildPlanPrompt = (input: {
  messageText: string;
  route: LangGraphRouteState;
}): string =>
  [
    'You are Odin AI plan generation.',
    'Return JSON only.',
    'Required shape: {"plan":["route.classify","agent.invoke.<agentKey>", "...", "synthesis.compose"]}',
    `Route intent: ${input.route.intent}`,
    `Complexity level: ${input.route.complexityLevel}`,
    `Execution mode: ${input.route.executionMode}`,
    'Rules:',
    '- Start with `route.classify`.',
    '- End with `synthesis.compose`.',
    '- Include at least one `agent.invoke.<agentKey>` step.',
    '- Use only real registered agent keys.',
    '- Use `agent.invoke.risk-check` for write intent plans.',
    'Valid example: {"plan":["route.classify","agent.invoke.response","synthesis.compose"]}',
    'Invalid example to avoid: ["response","done"]',
    `User: ${input.messageText}`,
  ].join('\n');

const normalizeStepList = (value: unknown): string[] | null => {
  if (!Array.isArray(value)) {
    return null;
  }

  const steps = value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0);

  return steps.length > 0 ? steps : null;
};

const parsePlanOutput = (rawLlmOutput: string | null): { plan: string[] | null; parseError?: string } => {
  if (!rawLlmOutput || rawLlmOutput.trim().length === 0) {
    return {
      plan: null,
      parseError: 'planner output is empty',
    };
  }

  const parsed = extractJsonObject(rawLlmOutput);
  if (!parsed) {
    return {
      plan: null,
      parseError: 'planner output is not valid JSON object',
    };
  }

  const directPlan = normalizeStepList(parsed.plan);
  if (directPlan) {
    return {
      plan: directPlan,
    };
  }

  const rootPlan = normalizeStepList(parsed);
  if (rootPlan) {
    return {
      plan: rootPlan,
    };
  }

  return {
    plan: null,
    parseError: 'planner output does not include a non-empty plan array',
  };
};

const parseAgentKey = (step: string): string | null => {
  if (!step.startsWith(AGENT_STEP_PREFIX)) {
    return null;
  }

  const key = step.slice(AGENT_STEP_PREFIX.length).trim();
  return key.length > 0 ? key : null;
};

const validatePlan = (
  plan: string[],
  route: LangGraphRouteState,
): { valid: boolean; errors: string[] } => {
  const errors: string[] = [];

  if (plan[0] !== REQUIRED_START_STEP) {
    errors.push(`plan must start with ${REQUIRED_START_STEP}`);
  }

  if (plan[plan.length - 1] !== REQUIRED_END_STEP) {
    errors.push(`plan must end with ${REQUIRED_END_STEP}`);
  }

  const knownAgentKeys = new Set(agentRegistry.list());
  const agentKeys: string[] = [];

  for (const step of plan) {
    const agentKey = parseAgentKey(step);
    if (agentKey) {
      agentKeys.push(agentKey);
      if (!knownAgentKeys.has(agentKey)) {
        errors.push(`unknown agent in plan: ${agentKey}`);
      }
      continue;
    }

    if (!ALLOWED_BOUNDARY_STEPS.has(step)) {
      errors.push(`unknown step in plan: ${step}`);
    }
  }

  if (agentKeys.length === 0) {
    errors.push('plan must include at least one agent.invoke.* step');
  }

  if (route.intent === 'write_intent' && !agentKeys.includes('risk-check')) {
    errors.push('write_intent plan must include agent.invoke.risk-check');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
};

export type PlanResolution = {
  plan: string[];
  source: LangGraphPlanSource;
  validationErrors: string[];
};

export const resolvePlanContract = (input: {
  rawLlmOutput: string | null;
  route: LangGraphRouteState;
  messageText: string;
}): PlanResolution => {
  const fallbackPlan = buildPlanFromIntent(input.route.intent, input.route.complexityLevel, input.messageText);
  const parsed = parsePlanOutput(input.rawLlmOutput);

  if (!parsed.plan) {
    return {
      plan: fallbackPlan,
      source: 'fallback',
      validationErrors: parsed.parseError ? [parsed.parseError] : ['planner output unavailable'],
    };
  }

  const validation = validatePlan(parsed.plan, input.route);
  if (!validation.valid) {
    return {
      plan: fallbackPlan,
      source: 'fallback',
      validationErrors: validation.errors,
    };
  }

  return {
    plan: parsed.plan,
    source: 'llm',
    validationErrors: [],
  };
};
