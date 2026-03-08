import {
  LarkDocAgent,
  LarkResponseAgent,
  OutreachReadAgent,
  ResponseAgent,
  RiskCheckAgent,
  SearchReadAgent,
  ZohoActionAgent,
  ZohoReadAgent,
} from './implementations';
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
registry.register(new OutreachReadAgent());
registry.register(new SearchReadAgent());
registry.register(new ZohoActionAgent());
registry.register(new LarkResponseAgent());
registry.register(new LarkDocAgent());

export const agentRegistry = registry;
