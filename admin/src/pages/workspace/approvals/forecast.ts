/**
 * "If I ask for this, will Divo stop and check with somebody?"
 *
 * Mirrors `advance-backend/src/domain/approval/gate-forecast.ts`. The two trees
 * do not share types, the same arrangement as `Decision`, and the backend keeps
 * a test that walks both this shape and the live gating rule through the same
 * cases so they cannot quietly disagree.
 *
 * Four rules decide this and three of them were invisible: whether the action
 * is gated, whether you happen to be the approver, whether your channel asks
 * you to confirm your own work, and whether an identical call was already
 * approved. This is all four, arranged to be read rather than executed.
 */
import { personallyGated, type PersonalGate } from './personal-gate'

export type GateOutcome =
  | { kind: 'immediate'; because: 'read' | 'not_listed' | 'no_policy' | 'self_bypass' }
  | { kind: 'you_confirm'; because: 'you_picked' | 'channel' }
  | { kind: 'approver_says_yes' }
  | { kind: 'blocked'; because: 'no_approver' }

export type GatePolicy = {
  enabled: boolean
  requiredActions: { toolId: string; actions: string[] }[]
  requiredActionGroups?: string[]
  requiredToolIds?: string[]
}

export type ForecastInput = {
  toolId: string
  action: string
  policy: GatePolicy | null
  channel: 'web' | 'lark' | 'desktop'
  askerIsApprover: boolean
  selfBypassDisabled: boolean
  approverExists: boolean
  /** The reader's own "ask me before Divo does this", per action. */
  personal: PersonalGate | null
}

export function forecastGate(input: ForecastInput): GateOutcome {
  if (input.action === 'read') return { kind: 'immediate', because: 'read' }
  /* The person's own picks first, because they are the ones they can see and
     change. Desktop confirms by default; web and Lark only ever confirm
     because somebody asked to be asked about this action. */
  if (personallyGated(input.personal, input.toolId, input.action)) {
    return { kind: 'you_confirm', because: 'you_picked' }
  }
  if (input.channel !== 'lark' && input.channel !== 'web') {
    return { kind: 'you_confirm', because: 'channel' }
  }
  if (!input.policy?.enabled) return { kind: 'immediate', because: 'no_policy' }
  if (!isGated(input.policy, input.toolId, input.action)) {
    return { kind: 'immediate', because: 'not_listed' }
  }
  /* After the gating test: somebody who is the approver for an action nobody
     gated is not bypassing anything, and saying so implies a rule that is not
     there. */
  if (input.askerIsApprover && !input.selfBypassDisabled) {
    return { kind: 'immediate', because: 'self_bypass' }
  }
  if (!input.approverExists) return { kind: 'blocked', because: 'no_approver' }
  return { kind: 'approver_says_yes' }
}

function isGated(policy: GatePolicy, toolId: string, action: string): boolean {
  return policy.requiredActions.some((e) => e.toolId === toolId && e.actions.includes(action))
    || (policy.requiredActionGroups?.includes(action) ?? false)
    || (policy.requiredToolIds?.includes(toolId) ?? false)
}

/**
 * The phrase on the row. One wording everywhere it appears.
 *
 * "Asks you" and "Asks your manager" are deliberately parallel: they are the
 * same event with a different person in it, and a reader comparing two rows
 * should not have to translate between "You confirm" and "Manager approves" to
 * notice that. The band titles and the zone headers use the same two verbs.
 */
export function outcomeLabel(outcome: GateOutcome): string {
  if (outcome.kind === 'you_confirm') return 'Asks you'
  if (outcome.kind === 'approver_says_yes') return 'Asks your manager'
  if (outcome.kind === 'blocked') return 'Blocked'
  return 'Runs straight away'
}

/** Why, in one sentence somebody can act on. */
export function outcomeReason(outcome: GateOutcome, approverName?: string): string {
  if (outcome.kind === 'you_confirm') {
    return outcome.because === 'you_picked'
      ? 'You asked to be checked with on this.'
      : 'This channel always checks with whoever asked.'
  }
  if (outcome.kind === 'approver_says_yes') {
    return approverName
      ? `${approverName} is asked before this happens.`
      : 'Your department manager is asked before this happens.'
  }
  if (outcome.kind === 'blocked') {
    return 'Set to need approval, but nobody holds the approver role. Divo can neither run it nor ask anyone.'
  }
  if (outcome.because === 'read') return 'Looking something up never needs approval.'
  if (outcome.because === 'not_listed') return 'Your team gates some actions. This is not one of them.'
  if (outcome.because === 'no_policy') return 'Your team has not switched on approvals.'
  return 'This needs the manager to say yes, and that is you, so it runs.'
}

/**
 * How a row should read, at a glance, before anybody reads the words.
 *
 * `blocked` is the only one that spends red. `stop` is deliberately not red:
 * being asked is the system working, and colouring it as a fault is how people
 * learn to resent the thing that is protecting them.
 */
export function outcomeTone(outcome: GateOutcome): 'go' | 'stop' | 'fault' {
  if (outcome.kind === 'blocked') return 'fault'
  if (outcome.kind === 'immediate') return 'go'
  return 'stop'
}

/**
 * An action that cannot be taken back once Divo has done it.
 *
 * Deleting destroys the thing; sending puts it in somebody else's hands. The
 * other verbs leave something to edit or restore. Coarse on purpose: the point
 * is not to rank risk precisely, it is to separate "you can fix this" from
 * "you cannot", because only the second kind is worth interrupting somebody
 * over before they have decided they want it.
 */
export function irreversible(action: string): boolean {
  return action === 'delete' || action === 'send'
}

/**
 * Which band on the page a row belongs in.
 *
 * The page used to be one list of every action in one order, which is why
 * nobody could find anything: the four rows that interrupt you sat among the
 * fifty that do not, sorted but not separated.
 *
 * `watched` exists because "gated, and it runs anyway because you are the
 * approver" is neither stopping nor plainly running, and reading it as "runs
 * straight away" is exactly the confusion that started all of this.
 *
 * `exposed` was added after a real miss. Somebody picked create and update on
 * their calendar, saw three rows under "stops and asks", and reasonably read
 * the page as covering their calendar. Delete was not among them, so Divo
 * deleted an event without asking — correctly, and to their complete surprise.
 * It was in the hundred-and-eleven-row fold, alphabetised among the harmless.
 *
 * Alphabetical order is not a safety model. An irreversible action that nothing
 * gates is the one thing this page has to volunteer, because it is precisely
 * the thing nobody thinks to go looking for.
 */
export type Band = 'stops' | 'watched' | 'exposed' | 'runs'

export function bandFor(outcome: GateOutcome, action: string): Band {
  if (outcome.kind !== 'immediate') return 'stops'
  if (outcome.because === 'self_bypass') return 'watched'
  if (outcome.because !== 'read' && irreversible(action)) return 'exposed'
  return 'runs'
}
