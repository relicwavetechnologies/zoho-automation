import type { SupervisorGraphStateValue } from '../dynamic-supervisor.state';

export async function formatResponse(
  state: SupervisorGraphStateValue,
): Promise<Partial<SupervisorGraphStateValue>> {
  return {
    supervisorResult: (state.supervisorResult ?? 'Done.').trim() || 'Done.',
  };
}
