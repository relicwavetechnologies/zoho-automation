import type { ControllerDecision, ControllerRuntimeState } from '../../company/orchestration/controller-runtime/types';

const MAX_HOPS = 12;

export class DecisionRouter<LocalAction = unknown> {
  route(state: ControllerRuntimeState<LocalAction>): ControllerDecision<LocalAction> | null {
    if ((state.hopCount ?? 0) >= MAX_HOPS) {
      return { decision: 'FAIL', reason: 'Execution budget exceeded.' };
    }

    if (
      this.lastActionWas(state, 'skills', 'RETRIEVE_ARTIFACT')
      && this.lastActionFailed(state)
      && (state.retryCount ?? 0) >= 2
    ) {
      return {
        decision: 'FAIL',
        reason: 'Could not load the skill artifact after 2 attempts. Check the worker contract.',
      };
    }

    if (
      this.lastActionWas(state, 'skills', 'RETRIEVE_ARTIFACT')
      && this.lastActionFailed(state)
      && (state.retryCount ?? 0) === 1
      && state.pendingSkillId
    ) {
      return {
        decision: 'CALL_WORKER',
        invocation: {
          workerKey: 'skills',
          actionKind: 'RETRIEVE_ARTIFACT',
          input: { id: state.pendingSkillId },
        },
      };
    }

    return null;
  }

  private lastActionWas(
    state: ControllerRuntimeState<LocalAction>,
    workerKey: string,
    actionKind: string,
  ): boolean {
    return state.lastAction?.workerKey === workerKey && state.lastAction?.actionKind === actionKind;
  }

  private lastActionFailed(state: ControllerRuntimeState<LocalAction>): boolean {
    return state.lastAction?.success === false;
  }
}

export { MAX_HOPS };
