import type { AgentInvokeInputDTO, AgentResultDTO, ErrorDTO } from '../../contracts';

export interface Agent {
  readonly key: string;
  invoke(input: AgentInvokeInputDTO): Promise<AgentResultDTO>;
}

const buildError = (classifiedReason: string, rawMessage?: string): ErrorDTO => ({
  type: 'TOOL_ERROR',
  classifiedReason,
  rawMessage,
  retriable: false,
});

export abstract class BaseAgent implements Agent {
  public abstract readonly key: string;

  public abstract invoke(input: AgentInvokeInputDTO): Promise<AgentResultDTO>;

  protected success(
    input: AgentInvokeInputDTO,
    message: string,
    result?: Record<string, unknown>,
    metrics?: AgentResultDTO['metrics'],
  ): AgentResultDTO {
    return {
      taskId: input.taskId,
      agentKey: this.key,
      status: 'success',
      message,
      result,
      metrics,
    };
  }

  protected failure(
    input: AgentInvokeInputDTO,
    message: string,
    classifiedReason: string,
    rawMessage?: string,
    retriable = false,
    metrics?: AgentResultDTO['metrics'],
  ): AgentResultDTO {
    return {
      taskId: input.taskId,
      agentKey: this.key,
      status: 'failed',
      message,
      error: {
        ...buildError(classifiedReason, rawMessage),
        retriable,
      },
      metrics,
    };
  }
}
