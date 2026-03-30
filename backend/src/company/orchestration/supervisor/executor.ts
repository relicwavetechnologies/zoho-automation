import type { DelegatedStepResult, SupervisorExecutionResult, SupervisorStep } from './types';

const nextWave = (
  remaining: SupervisorStep[],
  completed: Set<string>,
): SupervisorStep[] =>
  remaining.filter((step) => step.dependsOn.every((dependency) => completed.has(dependency)));

export const executeSupervisorPlan = async (input: {
  steps: SupervisorStep[];
  executeStep: (step: SupervisorStep) => Promise<DelegatedStepResult>;
  onWaveStart?: (wave: SupervisorStep[], index: number) => Promise<void> | void;
  onWaveComplete?: (waveResults: DelegatedStepResult[], index: number) => Promise<void> | void;
}): Promise<SupervisorExecutionResult> => {
  const remaining = [...input.steps];
  const completed = new Set<string>();
  const stepResults: DelegatedStepResult[] = [];
  let waveCount = 0;

  while (remaining.length > 0) {
    const wave = nextWave(remaining, completed);
    if (wave.length === 0) {
      throw new Error('Supervisor plan contains an unsatisfied dependency cycle.');
    }
    waveCount += 1;
    await input.onWaveStart?.(wave, waveCount);
    const waveResults = await Promise.all(wave.map((step) => input.executeStep(step)));
    stepResults.push(...waveResults);
    await input.onWaveComplete?.(waveResults, waveCount);

    for (const step of wave) {
      completed.add(step.stepId);
    }
    for (const step of wave) {
      const index = remaining.findIndex((entry) => entry.stepId === step.stepId);
      if (index >= 0) {
        remaining.splice(index, 1);
      }
    }

    const haltedBy = waveResults.find((result) => result.status !== 'success');
    if (haltedBy) {
      return {
        stepResults,
        haltedBy,
        completedStepIds: Array.from(completed),
        waveCount,
      };
    }
  }

  return {
    stepResults,
    completedStepIds: Array.from(completed),
    waveCount,
  };
};

export const executeSupervisorDag = executeSupervisorPlan;
