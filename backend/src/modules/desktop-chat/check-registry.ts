import type { ControllerRuntimeState, VerificationResult } from '../../company/orchestration/controller-runtime/types';
import { getRequiredSkillTools } from '../../company/orchestration/controller-runtime/skill-tool-requirements';

const MIN_SKILL_GUIDANCE_CHARS = 500;

type Check = {
  id: string;
  label: string;
  evaluate: (state: ControllerRuntimeState<unknown>) => 'satisfied' | 'pending' | 'failed';
  detail: (state: ControllerRuntimeState<unknown>) => string;
  evidence?: (state: ControllerRuntimeState<unknown>) => string[];
};

const hasSubstantiveSkillContent = (state: ControllerRuntimeState<unknown>): boolean =>
  typeof state.loadedSkillContent === 'string' && state.loadedSkillContent.trim().length > MIN_SKILL_GUIDANCE_CHARS;

const hasGroundedNonSkillEvidence = (state: ControllerRuntimeState<unknown>): boolean =>
  (state.workerResults ?? []).some((result) => {
    if (!result.success) return false;
    if (!result.hasSubstantiveContent) return false;
    if (result.workerKey === 'skills') return false;
    const lower = String(result.summary ?? '').toLowerCase().trim();
    const isEmpty =
      (lower.startsWith('no ') && (lower.includes('found') || lower.includes('matched') || lower.includes('result')))
      || lower === ''
      || lower.includes('no results')
      || lower.includes('nothing found')
      || lower.includes('no records');
    return !isEmpty;
  });

const getAttemptedNonSkillWorkers = (state: ControllerRuntimeState<unknown>): Set<string> =>
  new Set(
    (state.workerResults ?? [])
      .filter((result) => result.workerKey !== 'skills')
      .map((result) => result.workerKey),
  );

const getSubstantiveNonSkillResults = (state: ControllerRuntimeState<unknown>) =>
  (state.workerResults ?? []).filter(
    (result) => result.success && result.hasSubstantiveContent && result.workerKey !== 'skills',
  );

const checks: Check[] = [
  {
    id: 'skill_metadata_loaded',
    label: 'Relevant skill metadata',
    evaluate: (state) =>
      state.bootstrap?.shouldUseSkills
        ? state.availableSkills?.some((skill) => skill.id === state.resolvedSkillId) ? 'satisfied' : 'pending'
        : 'satisfied',
    detail: (state) =>
      state.bootstrap?.shouldUseSkills
        ? state.availableSkills?.some((skill) => skill.id === state.resolvedSkillId)
          ? 'Relevant skill metadata is available'
          : 'Relevant skill metadata is still pending'
        : 'No skill metadata needed',
    evidence: (state) => state.resolvedSkillId ? [state.resolvedSkillId] : [],
  },
  {
    id: 'skill_guidance_loaded',
    label: 'Full skill guidance loaded',
    evaluate: (state) =>
      state.bootstrap?.shouldUseSkills
        ? hasSubstantiveSkillContent(state) ? 'satisfied' : 'pending'
        : 'satisfied',
    detail: (state) =>
      state.bootstrap?.shouldUseSkills
        ? hasSubstantiveSkillContent(state)
          ? 'Full skill guidance is loaded'
          : 'Full skill guidance is still pending'
        : 'No skill guidance needed',
    evidence: (state) => hasSubstantiveSkillContent(state) ? ['substantive SKILL.md loaded'] : [],
  },
  {
    id: 'required_inputs',
    label: 'Required inputs',
    evaluate: (state) => state.profile.missingInputs.length === 0 ? 'satisfied' : 'pending',
    detail: (state) =>
      state.profile.missingInputs.length === 0
        ? 'Required inputs are available'
        : `Still missing: ${state.profile.missingInputs.join(' | ')}`,
    evidence: (state) => state.profile.missingInputs.length === 0 ? ['no blocking input gaps'] : [],
  },
  {
    id: 'grounded_evidence',
    label: 'Grounded work evidence',
    evaluate: (state) => {
      if (!state.todoList?.initialized) {
        return hasGroundedNonSkillEvidence(state) ? 'satisfied' : 'pending';
      }
      const requiredTools = getRequiredSkillTools(state.loadedSkillContent);
      if (requiredTools.length <= 1) {
        return hasGroundedNonSkillEvidence(state) ? 'satisfied' : 'pending';
      }
      return getSubstantiveNonSkillResults(state).length >= 2 ? 'satisfied' : 'pending';
    },
    detail: (state) =>
      (() => {
        if (!state.todoList?.initialized) {
          return hasGroundedNonSkillEvidence(state)
            ? 'Grounded work evidence is present'
            : 'Grounded work evidence is still pending';
        }
        const requiredTools = getRequiredSkillTools(state.loadedSkillContent);
        if (requiredTools.length <= 1) {
          return hasGroundedNonSkillEvidence(state)
            ? 'Grounded work evidence is present'
            : 'Grounded work evidence is still pending';
        }
        const substantiveCount = getSubstantiveNonSkillResults(state).length;
        return substantiveCount >= 2
          ? 'Grounded work evidence is present'
          : `Grounded work evidence is still pending (${substantiveCount}/2 substantive results)`;
      })(),
    evidence: (state) =>
      getSubstantiveNonSkillResults(state)
        .map((result) => `${result.workerKey}/${result.actionKind}`),
  },
  {
    id: 'required_tools_complete',
    label: 'All required tools attempted',
    evaluate: (state) => {
      const requiredTools = getRequiredSkillTools(state.loadedSkillContent);
      if (requiredTools.length === 0) return 'satisfied';
      if (!state.todoList?.initialized) return 'satisfied';
      return state.todoList.required.length === 0 ? 'satisfied' : 'pending';
    },
    detail: (state) => {
      const requiredTools = getRequiredSkillTools(state.loadedSkillContent);
      if (requiredTools.length === 0) return 'No required tools declared';
      if (!state.todoList?.initialized) return 'Execution plan not created yet';
      const pending = state.todoList.required;
      const failed = state.todoList?.failed ?? [];
      return pending.length === 0
        ? failed.length > 0
          ? `All required tools attempted (${failed.length} failed: ${failed.join(', ')})`
          : 'All required tools attempted'
        : `Still pending: ${pending.join(', ')}`;
    },
    evidence: (state) => {
      if (!state.todoList?.initialized) return [];
      return [...state.todoList.completed, ...state.todoList.failed];
    },
  },
  {
    id: 'local_action',
    label: 'Local action',
    evaluate: (state) =>
      state.pendingLocalAction
        ? 'pending'
        : state.localActionHistory.some((record) => record.status === 'succeeded')
          ? 'satisfied'
          : 'satisfied',
    detail: (state) =>
      state.pendingLocalAction
        ? `Awaiting local action: ${state.pendingLocalAction.summary}`
        : 'No pending local action',
    evidence: (state) =>
      state.localActionHistory.some((record) => record.status === 'succeeded')
        ? ['local action completed']
        : [],
  },
];

export const evaluateCheckRegistry = (state: ControllerRuntimeState<unknown>): VerificationResult[] =>
  checks
    .filter((check) => check.id !== 'local_action' || state.pendingLocalAction || state.localActionHistory.length > 0)
    .map((check) => ({
      checkId: check.id,
      status: check.evaluate(state),
      detail: check.detail(state),
      evidence: check.evidence ? check.evidence(state) : [],
    }));
