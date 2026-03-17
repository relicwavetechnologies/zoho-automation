import type { CheckpointDTO } from '../contracts';
import type { HitlActionStatus, OrchestrationTaskStatus } from '../contracts/status';

export type RecoveryMode = 'resume_from_checkpoint' | 'requeue_from_start';

export type CheckpointRecoveryDecision = {
  recoveryMode: RecoveryMode;
  resumeDecisionReason: string;
  recoveredFromNode?: string;
  shouldReturnCompleted: boolean;
  shouldFinalizeOnly: boolean;
  shouldReusePendingHitlAction: boolean;
};

const readString = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const isTaskStatus = (value: unknown): value is OrchestrationTaskStatus =>
  value === 'pending'
  || value === 'running'
  || value === 'hitl'
  || value === 'done'
  || value === 'failed'
  || value === 'cancelled';

const isHitlStatus = (value: unknown): value is HitlActionStatus =>
  value === 'pending'
  || value === 'confirmed'
  || value === 'cancelled'
  || value === 'expired';

export const readCheckpointStatus = (checkpoint: CheckpointDTO): OrchestrationTaskStatus | null => {
  if (isTaskStatus(checkpoint.state.status)) {
    return checkpoint.state.status;
  }

  if (isTaskStatus(checkpoint.state.finalStatus)) {
    return checkpoint.state.finalStatus;
  }

  return null;
};

export const readCheckpointSynthesisText = (checkpoint: CheckpointDTO): string | null =>
  readString(checkpoint.state.text);

export const readCheckpointHitlActionId = (checkpoint: CheckpointDTO): string | null =>
  readString(checkpoint.state.actionId);

const hasPendingHitlState = (checkpoint: CheckpointDTO): boolean => {
  if (checkpoint.node !== 'hitl.requested') {
    return false;
  }
  if (isHitlStatus(checkpoint.state.status)) {
    return checkpoint.state.status === 'pending';
  }
  return Boolean(readCheckpointHitlActionId(checkpoint));
};

export const decideCheckpointRecovery = (input: {
  latestCheckpoint: CheckpointDTO | null;
  hasPendingHitlAction?: boolean;
}): CheckpointRecoveryDecision => {
  const checkpoint = input.latestCheckpoint;
  if (!checkpoint) {
    return {
      recoveryMode: 'requeue_from_start',
      resumeDecisionReason: 'checkpoint_absent',
      shouldReturnCompleted: false,
      shouldFinalizeOnly: false,
      shouldReusePendingHitlAction: false,
    };
  }

  if (checkpoint.node === 'finalize.task') {
    return {
      recoveryMode: 'resume_from_checkpoint',
      resumeDecisionReason: 'already_finalized',
      recoveredFromNode: checkpoint.node,
      shouldReturnCompleted: true,
      shouldFinalizeOnly: false,
      shouldReusePendingHitlAction: false,
    };
  }

  if (checkpoint.node === 'synthesis.complete') {
    return {
      recoveryMode: 'resume_from_checkpoint',
      resumeDecisionReason: 'synthesis_complete_no_duplicate_send',
      recoveredFromNode: checkpoint.node,
      shouldReturnCompleted: true,
      shouldFinalizeOnly: false,
      shouldReusePendingHitlAction: false,
    };
  }

  if (checkpoint.node === 'response.send' && checkpoint.state.sent === true) {
    return {
      recoveryMode: 'resume_from_checkpoint',
      resumeDecisionReason: 'response_already_sent_finalize_only',
      recoveredFromNode: checkpoint.node,
      shouldReturnCompleted: false,
      shouldFinalizeOnly: true,
      shouldReusePendingHitlAction: false,
    };
  }

  if (hasPendingHitlState(checkpoint) && input.hasPendingHitlAction) {
    return {
      recoveryMode: 'resume_from_checkpoint',
      resumeDecisionReason: 'resume_waiting_existing_hitl_action',
      recoveredFromNode: checkpoint.node,
      shouldReturnCompleted: false,
      shouldFinalizeOnly: false,
      shouldReusePendingHitlAction: true,
    };
  }

  return {
    recoveryMode: 'requeue_from_start',
    resumeDecisionReason: 'checkpoint_requeue_from_start',
    recoveredFromNode: checkpoint.node,
    shouldReturnCompleted: false,
    shouldFinalizeOnly: false,
    shouldReusePendingHitlAction: false,
  };
};
