import { logger } from '../../utils/logger';
import type { ChatResponse, EngineTerminalState } from './orchestrator.types';

export class PresentationAdapter {
  adapt(input: { terminal: EngineTerminalState; executionId: string }): ChatResponse {
    switch (input.terminal.type) {
      case 'COMPLETE':
        return { role: 'assistant', content: input.terminal.reply };
      case 'ASK_USER':
        return { role: 'assistant', content: input.terminal.question };
      case 'FAIL':
        logger.error('engine.fail', {
          executionId: input.executionId,
          reason: input.terminal.reason,
        }, { always: true });
        return {
          role: 'assistant',
          content: "I ran into an issue completing that — let me know if you'd like me to try again or take a different approach.",
        };
      case 'UNKNOWN':
      default:
        logger.error('engine.unknown_terminal', {
          executionId: input.executionId,
          state: input.terminal,
        }, { always: true });
        return {
          role: 'assistant',
          content: 'Something went wrong on my end. Please try again.',
        };
    }
  }
}
