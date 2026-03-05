import type { HitlActionStatus } from '../../contracts/status';

const TERMINAL_STATUSES = new Set<HitlActionStatus>(['confirmed', 'cancelled', 'expired']);
const ALLOWED_TRANSITIONS: Record<HitlActionStatus, HitlActionStatus[]> = {
  pending: ['confirmed', 'cancelled', 'expired'],
  confirmed: [],
  cancelled: [],
  expired: [],
};

export type HitlTransitionResult = {
  allowed: boolean;
  from: HitlActionStatus;
  to: HitlActionStatus;
  terminal: boolean;
  reasonCode?: 'invalid_transition' | 'already_terminal';
};

export const isHitlTerminalStatus = (status: HitlActionStatus): boolean => TERMINAL_STATUSES.has(status);

export const resolveHitlTransition = (from: HitlActionStatus, to: HitlActionStatus): HitlTransitionResult => {
  if (from === to && isHitlTerminalStatus(from)) {
    return {
      allowed: false,
      from,
      to,
      terminal: true,
      reasonCode: 'already_terminal',
    };
  }

  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    return {
      allowed: false,
      from,
      to,
      terminal: isHitlTerminalStatus(from),
      reasonCode: isHitlTerminalStatus(from) ? 'already_terminal' : 'invalid_transition',
    };
  }

  return {
    allowed: true,
    from,
    to,
    terminal: isHitlTerminalStatus(to),
  };
};
