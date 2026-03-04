import type { AgentInvokeInputDTO, AgentResultDTO } from '../../contracts';
import type { Agent } from '../base';

export class AgentRegistry {
  private readonly agents = new Map<string, Agent>();

  register(agent: Agent): void {
    this.agents.set(agent.key, agent);
  }

  get(agentKey: string): Agent | undefined {
    return this.agents.get(agentKey);
  }

  has(agentKey: string): boolean {
    return this.agents.has(agentKey);
  }

  list(): string[] {
    return [...this.agents.keys()].sort();
  }

  async invoke(input: AgentInvokeInputDTO): Promise<AgentResultDTO> {
    const agent = this.get(input.agentKey);
    if (!agent) {
      return {
        taskId: input.taskId,
        agentKey: input.agentKey,
        status: 'failed',
        message: `Agent key not registered: ${input.agentKey}`,
        error: {
          type: 'TOOL_ERROR',
          classifiedReason: 'agent_not_registered',
          rawMessage: `No agent found for key: ${input.agentKey}`,
          retriable: false,
        },
      };
    }

    return agent.invoke(input);
  }
}
