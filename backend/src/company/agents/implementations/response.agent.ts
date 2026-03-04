import type { AgentInvokeInputDTO } from '../../contracts';
import { BaseAgent } from '../base';

export class ResponseAgent extends BaseAgent {
  readonly key = 'response';

  async invoke(input: AgentInvokeInputDTO) {
    const objective = input.objective.trim();
    if (objective.toLowerCase().includes('force_fail')) {
      return this.failure(
        input,
        'Response agent failed due to forced failure token',
        'forced_failure_token_detected',
      );
    }

    return this.success(
      input,
      'Response agent completed',
      {
        summary: objective.slice(0, 240),
      },
      { latencyMs: 2, apiCalls: 1 },
    );
  }
}
