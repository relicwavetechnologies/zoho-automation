import { legacyOrchestrationEngine } from './legacy-orchestration.engine';
import type { OrchestrationEngine } from './types';

// The first Vercel rollout is desktop-owned. Non-desktop orchestration paths
// keep legacy behavior until they are migrated to the Vercel runtime too.
export const vercelOrchestrationEngine: OrchestrationEngine = {
  id: 'vercel',
  buildTask: (...args) => legacyOrchestrationEngine.buildTask(...args),
  executeTask: (...args) => legacyOrchestrationEngine.executeTask(...args),
};
