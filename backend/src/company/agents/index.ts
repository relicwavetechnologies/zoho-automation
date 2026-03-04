import { LarkResponseAgent, ResponseAgent, RiskCheckAgent, ZohoReadAgent } from './implementations';
import { AgentRegistry } from './registry';

export const AGENTS_BOUNDARY = {
  key: 'agents',
  responsibility: 'Agent registry and agent implementations using shared contracts.',
};

export * from './base';
export * from './implementations';
export * from './registry';

const registry = new AgentRegistry();
registry.register(new ResponseAgent());
registry.register(new RiskCheckAgent());
registry.register(new ZohoReadAgent());
registry.register(new LarkResponseAgent());

export const agentRegistry = registry;
