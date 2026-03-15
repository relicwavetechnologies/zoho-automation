import { createHash } from 'crypto';

import { extractJsonObject } from '../langchain/json-output';
import { buildDecisionPrompt, normalizeActionKind } from './objective-contract';
import type {
  ArtifactRecord,
  ControllerDecision,
  ControllerRuntimeHooks,
  ControllerRuntimeResult,
  ControllerRuntimeState,
  LocalActionRecord,
  ObjectiveOutput,
  VerificationResult,
  WorkerCapability,
  WorkerInvocation,
  WorkerObservation,
} from './types';

const MAX_CONTROLLER_STEPS = 10;

const stableStringify = (value: unknown): string => {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
};

const hashInput = (value: unknown): string =>
  createHash('sha1').update(stableStringify(value)).digest('hex');

const hashLocalAction = (value: unknown): string => hashInput(value);

const artifactKey = (artifact: ArtifactRecord): string => artifact.id || artifact.url || artifact.title || JSON.stringify(artifact);

const collectKnownFacts = (state: ControllerRuntimeState<unknown>): Set<string> =>
  new Set(state.observations.flatMap((observation) => observation.facts));

const collectKnownArtifacts = (state: ControllerRuntimeState<unknown>): Set<string> =>
  new Set(state.observations.flatMap((observation) => observation.artifacts.map(artifactKey)));

const hasCitation = (state: ControllerRuntimeState<unknown>): boolean =>
  state.observations.some((observation) => observation.citations.length > 0);

const findArtifact = (state: ControllerRuntimeState<unknown>, predicate: (artifact: ArtifactRecord) => boolean): ArtifactRecord | null => {
  for (const observation of state.observations) {
    const artifact = observation.artifacts.find(predicate);
    if (artifact) return artifact;
  }
  return null;
};

const collectArtifacts = (state: ControllerRuntimeState<unknown>, predicate: (artifact: ArtifactRecord) => boolean): ArtifactRecord[] =>
  state.observations.flatMap((observation) => observation.artifacts.filter(predicate));

const buildVerificationDetail = (output: ObjectiveOutput, evidence: string[]): string =>
  evidence.length > 0
    ? `${output.description}: ${evidence.join(' | ')}`
    : `${output.description}: pending`;

export const evaluateVerifications = (state: ControllerRuntimeState<unknown>): VerificationResult[] =>
  state.objective.requestedOutputs.map((output) => {
    const evidence: string[] = [];
    let satisfied = true;

    if (output.kind === 'direct_reply') {
      return {
        outputId: output.id,
        status: 'satisfied',
        detail: output.description,
        evidence: [output.description],
      };
    }

    if (output.kind === 'research_answer') {
      const hasResearch = state.observations.some((observation) =>
        observation.ok && (observation.actionKind === 'QUERY_REMOTE_SYSTEM' || observation.workerKey === 'search'));
      satisfied = hasResearch && hasCitation(state);
      if (hasResearch) evidence.push('grounded research observation');
      if (hasCitation(state)) evidence.push('source citation');
    }

    if (output.kind === 'remote_artifact') {
      const artifactType = typeof output.metadata?.artifactType === 'string' ? output.metadata.artifactType : 'repository_file';
      const artifact = findArtifact(state, (item) => item.type === artifactType || item.type.endsWith('_file') || item.type === 'file');
      if (artifact) {
        evidence.push(`artifact:${artifact.title ?? artifact.id}`);
      } else {
        satisfied = false;
      }
      if (output.verification.includes('source_citation') && !hasCitation(state)) {
        satisfied = false;
      } else if (output.verification.includes('source_citation')) {
        evidence.push('source citation');
      }
      if (output.verification.includes('non_empty_content')) {
        const hasContent = state.observations.some((observation) => {
          const raw = observation.rawOutput && typeof observation.rawOutput === 'object'
            ? observation.rawOutput as Record<string, unknown>
            : null;
          const artifactRecord = raw?.artifact && typeof raw.artifact === 'object'
            ? raw.artifact as Record<string, unknown>
            : null;
          return typeof artifactRecord?.content === 'string' && artifactRecord.content.trim().length > 0;
        });
        if (!hasContent) {
          satisfied = false;
        } else {
          evidence.push('non-empty content');
        }
      }
    }

    if (output.kind === 'workspace_mutation') {
      const writeObservation = state.observations.find((observation) =>
        observation.ok && observation.actionKind === 'MUTATE_WORKSPACE' && observation.workerKey === 'workspace');
      satisfied = Boolean(writeObservation);
      if (writeObservation) {
        evidence.push(writeObservation.summary);
      }
    }

    if (output.kind === 'terminal_result') {
      const terminalObservation = state.observations.find((observation) =>
        observation.actionKind === 'EXECUTE_COMMAND' && observation.workerKey === 'terminal');
      satisfied = Boolean(terminalObservation?.ok);
      if (terminalObservation) {
        evidence.push(terminalObservation.summary);
        const raw = terminalObservation.rawOutput && typeof terminalObservation.rawOutput === 'object'
          ? terminalObservation.rawOutput as Record<string, unknown>
          : null;
        if (output.verification.includes('terminal_exit')) {
          const hasExit = typeof raw?.exitCode === 'number' || raw?.exitCode === null;
          if (!hasExit) satisfied = false;
          else evidence.push(`exit:${String(raw?.exitCode)}`);
        }
        if (output.verification.includes('terminal_output')) {
          const hasOutput = typeof raw?.stdout === 'string' || typeof raw?.stderr === 'string';
          if (!hasOutput) satisfied = false;
          else evidence.push('captured output');
        }
      }
    }

    if (output.kind === 'remote_entity') {
      const entityEvidence = state.observations.some((observation) => observation.ok && observation.entities.length > 0);
      satisfied = entityEvidence;
      if (entityEvidence) {
        evidence.push('entity evidence');
      }
    }

    return {
      outputId: output.id,
      status: satisfied ? 'satisfied' : 'pending',
      detail: buildVerificationDetail(output, evidence),
      evidence,
    };
  });

const allOutputsSatisfied = (state: ControllerRuntimeState<unknown>): boolean =>
  evaluateVerifications(state).every((verification) => verification.status === 'satisfied');

const summarizeOutputs = (state: ControllerRuntimeState<unknown>): string =>
  evaluateVerifications(state)
    .map((verification) => `- ${verification.status}: ${verification.detail}`)
    .join('\n');

const classifyNoProgress = (
  state: ControllerRuntimeState<unknown>,
  invocation: WorkerInvocation,
): { repeatedNoProgress: boolean; attemptCount: number } => {
  const inputHash = hashInput(invocation.input);
  const signature = `${invocation.workerKey}:${invocation.actionKind}:${inputHash}`;
  const matches = state.progressLedger.filter((record) => record.actionSignature === signature);
  return {
    repeatedNoProgress: matches.some((record) => !record.madeProgress),
    attemptCount: matches.length,
  };
};

const summarizeProgressLedger = (state: ControllerRuntimeState<unknown>): string =>
  state.progressLedger.slice(-4).map((record) => (
    `- step=${record.step} worker=${record.workerKey} progress=${String(record.madeProgress)} artifacts=${record.artifactsAdded.join(', ') || 'none'} facts=${record.factsAdded.join(', ') || 'none'}`
  )).join('\n');

const normalizeState = <LocalAction>(
  state: ControllerRuntimeState<LocalAction>,
): ControllerRuntimeState<LocalAction> => ({
  ...state,
  lifecyclePhase: state.lifecyclePhase ?? 'running',
  localActionHistory: Array.isArray(state.localActionHistory) ? state.localActionHistory : [],
  pendingLocalAction: state.pendingLocalAction
    ? {
      ...state.pendingLocalAction,
      id: state.pendingLocalAction.id ?? `local-action:${hashLocalAction(state.pendingLocalAction.localAction)}`,
      actionHash: state.pendingLocalAction.actionHash ?? hashLocalAction(state.pendingLocalAction.localAction),
      requestedAtStep: typeof state.pendingLocalAction.requestedAtStep === 'number'
        ? state.pendingLocalAction.requestedAtStep
        : state.stepCount,
    }
    : undefined,
});

const buildStateSummary = (state: ControllerRuntimeState<unknown>, workers: WorkerCapability[]): string => {
  const recentObservations = state.observations.slice(-4).map((observation, index) => {
    const citations = observation.citations.map((citation) => citation.url ?? citation.title).filter(Boolean).join(' | ');
    return [
      `${index + 1}. worker=${observation.workerKey} action=${observation.actionKind} ok=${String(observation.ok)}`,
      `summary: ${observation.summary}`,
      observation.facts.length > 0 ? `facts: ${observation.facts.slice(0, 3).join(' | ')}` : '',
      citations ? `citations: ${citations}` : '',
      observation.blockingReason ? `blocking: ${observation.blockingReason}` : '',
    ].filter(Boolean).join('\n');
  }).join('\n\n');

  const workerSummary = workers
    .map((worker) => `- ${worker.workerKey}: actions=${worker.actionKinds.join(', ')} domains=${worker.domains.join(', ') || 'general'}`)
    .join('\n');

  return [
    `Objective: ${state.objective.objectiveSummary}`,
    `User request: ${state.userRequest}`,
    `Outputs:\n${summarizeOutputs(state)}`,
    state.objective.blockingQuestions.length > 0
      ? `Known blocking questions: ${state.objective.blockingQuestions.join(' | ')}`
      : '',
    state.progressLedger.length > 0 ? `Recent progress ledger:\n${summarizeProgressLedger(state)}` : 'Recent progress ledger: none',
    recentObservations ? `Recent observations:\n${recentObservations}` : 'Recent observations: none',
    `Available worker capabilities:\n${workerSummary}`,
  ].filter(Boolean).join('\n\n');
};

const parseDecision = <LocalAction>(raw: string | null): ControllerDecision<LocalAction> | null => {
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed.decision !== 'string') return null;

  if (parsed.decision === 'CALL_WORKER') {
    const invocation = parsed.invocation && typeof parsed.invocation === 'object'
      ? parsed.invocation as Record<string, unknown>
      : null;
    const actionKind = normalizeActionKind(invocation?.actionKind);
    if (
      invocation
      && typeof invocation.workerKey === 'string'
      && actionKind
      && actionKind !== 'ASK_USER'
      && actionKind !== 'COMPLETE'
      && actionKind !== 'FAIL'
    ) {
      return {
        decision: 'CALL_WORKER',
        invocation: {
          workerKey: invocation.workerKey.trim(),
          actionKind,
          input: invocation.input && typeof invocation.input === 'object'
            ? invocation.input as Record<string, unknown>
            : {},
        },
        reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : undefined,
      };
    }
  }

  if (
    parsed.decision === 'REQUEST_LOCAL_ACTION'
    && (parsed.actionKind === 'MUTATE_WORKSPACE' || parsed.actionKind === 'EXECUTE_COMMAND')
    && parsed.localAction
  ) {
    return {
      decision: 'REQUEST_LOCAL_ACTION',
      actionKind: parsed.actionKind,
      localAction: parsed.localAction as LocalAction,
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : undefined,
    };
  }

  if (parsed.decision === 'ASK_USER' && typeof parsed.question === 'string' && parsed.question.trim()) {
    return { decision: 'ASK_USER', question: parsed.question.trim() };
  }

  if (parsed.decision === 'COMPLETE' && typeof parsed.reply === 'string' && parsed.reply.trim()) {
    return { decision: 'COMPLETE', reply: parsed.reply.trim() };
  }

  if (parsed.decision === 'FAIL' && typeof parsed.reason === 'string' && parsed.reason.trim()) {
    return { decision: 'FAIL', reason: parsed.reason.trim() };
  }

  return null;
};

const findRequestedOutput = (
  state: ControllerRuntimeState<unknown>,
  kind: ObjectiveOutput['kind'],
): ObjectiveOutput | undefined =>
  state.objective.requestedOutputs.find((output) => output.kind === kind);

const isOutputSatisfied = (
  state: ControllerRuntimeState<unknown>,
  output: ObjectiveOutput | undefined,
): boolean => {
  if (!output) return true;
  return state.verifications.some((verification) => verification.outputId === output.id && verification.status === 'satisfied');
};

const collectUninspectedCandidates = (state: ControllerRuntimeState<unknown>): ArtifactRecord[] => {
  const inspectedRepoIds = new Set(
    state.progressLedger
      .filter((record) => record.workerKey === 'repo' && record.actionSignature.includes('INSPECT_CANDIDATE'))
      .map((record) => record.inputHash),
  );

  return collectArtifacts(state, (artifact) => artifact.type === 'repository_candidate')
    .filter((artifact) => !inspectedRepoIds.has(hashInput({ repoRef: artifact.metadata?.repoFullName ?? artifact.id })));
};

const collectFileCandidates = (state: ControllerRuntimeState<unknown>): ArtifactRecord[] =>
  collectArtifacts(state, (artifact) => artifact.type === 'repository_file_candidate');

const hasNewNonLocalProgressSince = <LocalAction>(
  state: ControllerRuntimeState<LocalAction>,
  step: number,
): boolean =>
  state.progressLedger.some((record) =>
    record.step > step
    && record.madeProgress
    && record.workerKey !== 'workspace'
    && record.workerKey !== 'terminal');

const findLatestLocalActionRecord = <LocalAction>(
  state: ControllerRuntimeState<LocalAction>,
  actionKind: 'MUTATE_WORKSPACE' | 'EXECUTE_COMMAND',
  actionHash: string,
): LocalActionRecord<LocalAction> | null => {
  const matches = state.localActionHistory.filter((record) => record.actionKind === actionKind && record.actionHash === actionHash);
  return matches.length > 0 ? matches[matches.length - 1] ?? null : null;
};

const shouldBlockRepeatedLocalAction = <LocalAction>(
  state: ControllerRuntimeState<LocalAction>,
  actionKind: 'MUTATE_WORKSPACE' | 'EXECUTE_COMMAND',
  localAction: LocalAction,
): boolean => {
  const actionHash = hashLocalAction(localAction);
  if (state.pendingLocalAction?.actionHash === actionHash && state.pendingLocalAction.actionKind === actionKind) {
    return true;
  }
  const previous = findLatestLocalActionRecord(state, actionKind, actionHash);
  if (!previous || previous.status === 'pending') return false;
  return !hasNewNonLocalProgressSince(state, previous.resolvedAtStep ?? previous.requestedAtStep);
};

const buildRepeatedLocalActionQuestion = (
  actionKind: 'MUTATE_WORKSPACE' | 'EXECUTE_COMMAND',
): string =>
  actionKind === 'MUTATE_WORKSPACE'
    ? 'The same local workspace action was already attempted and no new evidence has appeared since then. I need a different strategy or clarification before changing the workspace again.'
    : 'The same terminal action was already attempted and no new evidence has appeared since then. I need a different strategy or clarification before running it again.';

const buildFallbackDecision = <LocalAction>(
  state: ControllerRuntimeState<LocalAction>,
  workers: WorkerCapability[],
  buildLocalAction: (state: ControllerRuntimeState<LocalAction>, kind: 'MUTATE_WORKSPACE' | 'EXECUTE_COMMAND') => LocalAction | null,
): ControllerDecision<LocalAction> => {
  if (allOutputsSatisfied(state)) {
    return {
      decision: 'COMPLETE',
      reply: state.observations.map((observation) => observation.summary).join('\n\n') || state.objective.directReply || 'Completed the verified request.',
    };
  }

  if (state.objective.directReply && state.objective.requestedOutputs.every((output) => output.kind === 'direct_reply')) {
    return { decision: 'COMPLETE', reply: state.objective.directReply };
  }

  const remoteArtifactOutput = findRequestedOutput(state, 'remote_artifact');
  const workspaceOutput = findRequestedOutput(state, 'workspace_mutation');
  const terminalOutput = findRequestedOutput(state, 'terminal_result');
  const researchOutput = findRequestedOutput(state, 'research_answer');
  const entityOutput = findRequestedOutput(state, 'remote_entity');
  const remoteArtifactPending = !isOutputSatisfied(state, remoteArtifactOutput);
  const workspacePending = !isOutputSatisfied(state, workspaceOutput);
  const terminalPending = !isOutputSatisfied(state, terminalOutput);
  const researchPending = !isOutputSatisfied(state, researchOutput);
  const entityPending = !isOutputSatisfied(state, entityOutput);

  if (remoteArtifactOutput && remoteArtifactPending) {
    const retrievedArtifact = findArtifact(state, (artifact) => artifact.type === 'repository_file' || artifact.type === 'file');
    if (!retrievedArtifact) {
      const fileCandidates = collectFileCandidates(state);
      if (fileCandidates.length > 0) {
        const candidate = fileCandidates[0];
        return {
          decision: 'CALL_WORKER',
          invocation: {
            workerKey: 'repo',
            actionKind: 'RETRIEVE_ARTIFACT',
            input: {
              repoRef: candidate.metadata?.repoFullName ?? candidate.id,
              filePath: candidate.metadata?.filePath ?? candidate.title,
              targetFileName: remoteArtifactOutput.metadata?.targetFileName,
            },
          },
        };
      }

      const candidates = collectUninspectedCandidates(state);
      if (candidates.length > 0) {
        const candidate = candidates[0];
        return {
          decision: 'CALL_WORKER',
          invocation: {
            workerKey: 'repo',
            actionKind: 'INSPECT_CANDIDATE',
            input: {
              repoRef: candidate.metadata?.repoFullName ?? candidate.id,
              targetFileName: remoteArtifactOutput.metadata?.targetFileName,
              targetFilePath: remoteArtifactOutput.metadata?.targetFilePath,
              requireRoot: remoteArtifactOutput.metadata?.requireRoot,
            },
          },
        };
      }

      const canUseRepo = workers.some((worker) => worker.workerKey === 'repo');
      if (canUseRepo) {
        return {
          decision: 'CALL_WORKER',
          invocation: {
            workerKey: 'repo',
            actionKind: 'DISCOVER_CANDIDATES',
            input: {
              query: remoteArtifactOutput.metadata?.domainQuery ?? state.userRequest,
              targetFileName: remoteArtifactOutput.metadata?.targetFileName,
            },
          },
        };
      }
    }
  }

  if (workspaceOutput && workspacePending) {
    const localAction = buildLocalAction(state, 'MUTATE_WORKSPACE');
    if (localAction) {
      if (shouldBlockRepeatedLocalAction(state, 'MUTATE_WORKSPACE', localAction)) {
        return {
          decision: 'ASK_USER',
          question: buildRepeatedLocalActionQuestion('MUTATE_WORKSPACE'),
        };
      }
      return {
        decision: 'REQUEST_LOCAL_ACTION',
        actionKind: 'MUTATE_WORKSPACE',
        localAction,
      };
    }
    return { decision: 'ASK_USER', question: 'I need a selected workspace before I can complete the local file change.' };
  }

  if (terminalOutput && terminalPending) {
    const localAction = buildLocalAction(state, 'EXECUTE_COMMAND');
    if (localAction) {
      if (shouldBlockRepeatedLocalAction(state, 'EXECUTE_COMMAND', localAction)) {
        return {
          decision: 'ASK_USER',
          question: buildRepeatedLocalActionQuestion('EXECUTE_COMMAND'),
        };
      }
      return {
        decision: 'REQUEST_LOCAL_ACTION',
        actionKind: 'EXECUTE_COMMAND',
        localAction,
      };
    }
    return { decision: 'ASK_USER', question: 'I need a selected workspace before I can run the required command.' };
  }

  if (entityOutput && entityPending) {
    const domain = state.objective.domains.find((item) => item === 'zoho' || item === 'lark');
    const workerKey = domain === 'zoho'
      ? 'zoho'
      : domain === 'lark'
        ? 'larkTask'
        : 'search';
    return {
      decision: 'CALL_WORKER',
      invocation: {
        workerKey,
        actionKind: 'QUERY_REMOTE_SYSTEM',
        input: { query: state.userRequest },
      },
    };
  }

  if (researchOutput && researchPending) {
    return {
      decision: 'CALL_WORKER',
      invocation: {
        workerKey: 'search',
        actionKind: 'QUERY_REMOTE_SYSTEM',
        input: { query: state.userRequest },
      },
    };
  }

  return {
    decision: 'COMPLETE',
    reply: state.observations.map((observation) => observation.summary).join('\n\n') || state.objective.directReply || 'Completed the request.',
  };
};

const applyProgress = (
  state: ControllerRuntimeState<unknown>,
  invocation: WorkerInvocation,
  observation: WorkerObservation,
): ControllerRuntimeState<unknown> => {
  const knownFacts = collectKnownFacts(state);
  const knownArtifacts = collectKnownArtifacts(state);
  const factsAdded = observation.facts.filter((fact) => !knownFacts.has(fact));
  const artifactsAdded = observation.artifacts
    .map((artifact) => artifactKey(artifact))
    .filter((key) => !knownArtifacts.has(key));
  const nextState: ControllerRuntimeState<unknown> = {
    ...state,
    observations: [...state.observations, observation],
    stepCount: state.stepCount + 1,
  };
  const nextVerifications = evaluateVerifications(nextState);
  const verificationStateChanges = nextVerifications
    .filter((verification) => {
      const previous = state.verifications.find((item) => item.outputId === verification.outputId);
      return previous?.status !== verification.status;
    })
    .map((verification) => `${verification.outputId}:${verification.status}`);
  const madeProgress = observation.ok && (factsAdded.length > 0 || artifactsAdded.length > 0 || verificationStateChanges.length > 0);
  const inputHash = hashInput(invocation.input);
  return {
    ...nextState,
    verifications: nextVerifications,
    progressLedger: [
      ...state.progressLedger,
      {
        step: state.stepCount + 1,
        actionSignature: `${invocation.workerKey}:${invocation.actionKind}:${inputHash}`,
        workerKey: invocation.workerKey,
        inputHash,
        artifactsAdded,
        factsAdded,
        verificationStateChanges,
        blockerClassification: observation.blockingReason ? 'blocking_reason' : undefined,
        madeProgress,
      },
    ],
  };
};

export const applyLocalObservation = <LocalAction>(
  state: ControllerRuntimeState<LocalAction>,
  observation: WorkerObservation,
): ControllerRuntimeState<LocalAction> => {
  const normalizedState = normalizeState(state);
  const pendingLocalAction = normalizedState.pendingLocalAction;
  const normalizedObservation = (() => {
    if (!pendingLocalAction) return observation;
    const rawOutput =
      observation.rawOutput && typeof observation.rawOutput === 'object'
        ? observation.rawOutput as Record<string, unknown>
        : {};
    return {
      ...observation,
      rawOutput: {
        ...rawOutput,
        localActionRequestId: pendingLocalAction.id,
        localActionHash: pendingLocalAction.actionHash,
      },
    };
  })();

  const invocation: WorkerInvocation = {
    workerKey: normalizedObservation.workerKey,
    actionKind: normalizedObservation.actionKind,
    input: normalizedObservation.rawOutput && typeof normalizedObservation.rawOutput === 'object'
      ? normalizedObservation.rawOutput as Record<string, unknown>
      : { summary: normalizedObservation.summary },
  };
  const baseState: ControllerRuntimeState<LocalAction> = {
    ...normalizedState,
    lifecyclePhase: 'resuming',
    pendingLocalAction: undefined,
    localActionHistory: pendingLocalAction
      ? normalizedState.localActionHistory.map((record) =>
        record.id === pendingLocalAction.id
          ? {
            ...record,
            status: normalizedObservation.ok ? 'succeeded' : 'failed',
            resolvedAtStep: normalizedState.stepCount,
            observationSummary: normalizedObservation.summary,
          }
          : record)
      : normalizedState.localActionHistory,
  };
  const nextState = applyProgress(baseState, invocation, normalizedObservation) as ControllerRuntimeState<LocalAction>;
  return {
    ...nextState,
    lifecyclePhase: 'running',
  };
};

export const runControllerRuntime = async <LocalAction, PlanView>(input: {
  initialState: ControllerRuntimeState<LocalAction>;
  workers: WorkerCapability[];
  invokeController: (prompt: string) => Promise<string | null>;
  executeWorker: (invocation: WorkerInvocation) => Promise<WorkerObservation>;
  buildLocalAction: (state: ControllerRuntimeState<LocalAction>, kind: 'MUTATE_WORKSPACE' | 'EXECUTE_COMMAND') => LocalAction | null;
  hooks?: ControllerRuntimeHooks<LocalAction, PlanView>;
  maxSteps?: number;
}): Promise<ControllerRuntimeResult<LocalAction>> => {
  let state = normalizeState({
    ...input.initialState,
    verifications: evaluateVerifications(input.initialState),
  });
  const hooks = input.hooks;
  const maxSteps = input.maxSteps ?? MAX_CONTROLLER_STEPS;

  if (hooks?.onObjective) {
    await hooks.onObjective(state, hooks.projectPlan ? hooks.projectPlan(state) : null);
  }
  if (hooks?.onCheckpoint) {
    await hooks.onCheckpoint('controller.objective.ready', state);
  }

  if (allOutputsSatisfied(state) && state.objective.directReply) {
    return { kind: 'answer', text: state.objective.directReply, state };
  }

  for (let index = 0; index < maxSteps; index += 1) {
    state = {
      ...state,
      verifications: evaluateVerifications(state),
    };

    if (hooks?.onVerification) {
      await hooks.onVerification(state, hooks.projectPlan ? hooks.projectPlan(state) : null);
    }

    if (allOutputsSatisfied(state)) {
      return {
        kind: 'answer',
        text: state.observations.map((observation) => observation.summary).join('\n\n') || state.objective.directReply || 'Completed the verified request.',
        state,
      };
    }

    const rawDecision = await input.invokeController(buildDecisionPrompt({
      stateSummary: buildStateSummary(state, input.workers),
      workers: input.workers,
    }));

    let decision = parseDecision<LocalAction>(rawDecision) ?? buildFallbackDecision(state, input.workers, input.buildLocalAction);

    if (decision.decision === 'CALL_WORKER') {
      const progressInfo = classifyNoProgress(state, decision.invocation);
      if (progressInfo.repeatedNoProgress || progressInfo.attemptCount > 1) {
        decision = buildFallbackDecision(state, input.workers, input.buildLocalAction);
      }
    }
    if (
      decision.decision === 'REQUEST_LOCAL_ACTION'
      && shouldBlockRepeatedLocalAction(state, decision.actionKind, decision.localAction)
    ) {
      decision = buildFallbackDecision(state, input.workers, input.buildLocalAction);
      if (
        decision.decision === 'REQUEST_LOCAL_ACTION'
        && shouldBlockRepeatedLocalAction(state, decision.actionKind, decision.localAction)
      ) {
        decision = {
          decision: 'ASK_USER',
          question: buildRepeatedLocalActionQuestion(decision.actionKind),
        };
      }
    }

    const plan = hooks?.projectPlan ? hooks.projectPlan(state) : null;
    if (hooks?.onDecision) {
      await hooks.onDecision(state, decision, plan);
    }
    if (hooks?.onCheckpoint) {
      await hooks.onCheckpoint(`controller.step.${state.stepCount + 1}`, state, { decision });
    }

    if (decision.decision === 'ASK_USER') {
      return { kind: 'answer', text: decision.question, state };
    }
    if (decision.decision === 'FAIL') {
      return { kind: 'answer', text: decision.reason, state };
    }
    if (decision.decision === 'REQUEST_LOCAL_ACTION') {
      const actionHash = hashLocalAction(decision.localAction);
      const actionRequestId = `local-action:${state.stepCount + 1}:${actionHash}`;
      const nextState = {
        ...state,
        lifecyclePhase: 'awaiting_local_action' as const,
        localActionHistory: [
          ...state.localActionHistory,
          {
            id: actionRequestId,
            actionKind: decision.actionKind,
            localAction: decision.localAction,
            actionHash,
            status: 'pending' as const,
            requestedAtStep: state.stepCount,
          },
        ],
        pendingLocalAction: {
          id: actionRequestId,
          actionKind: decision.actionKind,
          localAction: decision.localAction,
          actionHash,
          summary: decision.reasoning ?? `Requested ${decision.actionKind.toLowerCase()}`,
          requestedAtStep: state.stepCount,
        },
      };
      if (hooks?.onLocalActionRequest) {
        await hooks.onLocalActionRequest(nextState, decision, hooks.projectPlan ? hooks.projectPlan(nextState) : null);
      }
      if (hooks?.onCheckpoint) {
        await hooks.onCheckpoint('controller.local_action.requested', nextState, { decision });
      }
      return {
        kind: 'action',
        action: decision.localAction,
        state: nextState,
      };
    }
    if (decision.decision === 'COMPLETE') {
      if (allOutputsSatisfied(state) || !state.objective.requestedOutputs.some((output) => output.kind !== 'direct_reply')) {
        return { kind: 'answer', text: decision.reply, state };
      }
      decision = buildFallbackDecision(state, input.workers, input.buildLocalAction);
      if (decision.decision !== 'CALL_WORKER' && decision.decision !== 'REQUEST_LOCAL_ACTION') {
        return {
          kind: 'answer',
          text:
            decision.decision === 'ASK_USER'
              ? decision.question
              : decision.decision === 'FAIL'
                ? decision.reason
                : decision.reply,
          state,
        };
      }
    }

    if (decision.decision === 'CALL_WORKER') {
      if (hooks?.onWorkerStart) {
        await hooks.onWorkerStart(state, decision.invocation, plan);
      }
      const observation = await input.executeWorker(decision.invocation);
      state = applyProgress(state, decision.invocation, observation) as ControllerRuntimeState<LocalAction>;
      if (hooks?.onWorkerResult) {
        await hooks.onWorkerResult(state, decision.invocation, observation, hooks.projectPlan ? hooks.projectPlan(state) : null);
      }
      if (hooks?.onLocalActionResume && (observation.workerKey === 'workspace' || observation.workerKey === 'terminal')) {
        await hooks.onLocalActionResume(state, observation, hooks.projectPlan ? hooks.projectPlan(state) : null);
      }
      if (hooks?.onCheckpoint) {
        await hooks.onCheckpoint('controller.worker.result', state, {
          invocation: decision.invocation,
          observation,
        });
      }
      if (observation.blockingReason) {
        return { kind: 'answer', text: observation.blockingReason, state };
      }
      if (!observation.ok && !observation.retryHint) {
        return { kind: 'answer', text: observation.summary, state };
      }
    }
  }

  const fallbackReply = state.observations.map((observation) => observation.summary).join('\n\n')
    || state.objective.directReply
    || 'I could not confidently complete this request within the controller loop limit.';
  return { kind: 'answer', text: fallbackReply, state };
};
