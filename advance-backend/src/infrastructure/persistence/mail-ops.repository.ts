/**
 * Mail Ops persistence, as one object over four aggregates.
 *
 * The four live in `./mail-ops/`: the mailbox subscription, the rules, the
 * events read off Gmail, and the deliveries sent from them. They were one
 * fourteen-hundred-line class, which meant the rate-limit window and the watch
 * renewal cadence sat close enough together to read as one subject, and the
 * blast radius of any edit was every caller of any of them.
 *
 * This stays a single class because splitting the callers is a different change
 * from splitting the code, and doing both at once would make each harder to
 * review. Each method is the one on the aggregate's own repository, bound to
 * it — so the signature you see in an editor is that repository's signature,
 * and a change there cannot silently disagree with this file.
 */
import type { MailOpsDb } from './mail-ops/shared';
import {
  MailAutomationRuleRepository,
} from './mail-ops/rule.repository';
import { MailEventRepository } from './mail-ops/event.repository';
import { MailDeliveryRepository } from './mail-ops/delivery.repository';
import { MailBriefRepository } from './mail-ops/brief.repository';
import {
  MailboxSubscriptionRepository,
} from './mail-ops/subscription.repository';

export type {
  MailboxSyncClaim,
  MailboxWatchClaim,
} from './mail-ops/subscription.repository';
export type {
  CreateMailAutomationRuleInput,
  MailAutomationRuleSummary,
  MailRuleReplacement,
} from './mail-ops/rule.repository';
export type { PersistedMailEvent } from './mail-ops/event.repository';
export type {
  ClaimedMailDelivery,
  MailDeliveryReservation,
} from './mail-ops/delivery.repository';
export type { ClaimedMailBrief } from './mail-ops/brief.repository';
export {
  MailAutomationRuleRepository,
  MailDeliveryRepository,
  MailEventRepository,
  MailboxSubscriptionRepository,
};

export class MailOpsRepository {
  private readonly subscriptions: MailboxSubscriptionRepository;
  private readonly rules: MailAutomationRuleRepository;
  private readonly events: MailEventRepository;
  private readonly deliveries: MailDeliveryRepository;
  private readonly briefs: MailBriefRepository;

  // The mailbox.
  readonly claimNextDueMailbox: MailboxSubscriptionRepository['claimNextDueMailbox'];
  readonly advanceCursor: MailboxSubscriptionRepository['advanceCursor'];
  readonly signalMailbox: MailboxSubscriptionRepository['signalMailbox'];
  readonly claimNextWatchRenewal: MailboxSubscriptionRepository['claimNextWatchRenewal'];
  readonly completeWatchRenewal: MailboxSubscriptionRepository['completeWatchRenewal'];
  readonly failWatchRenewal: MailboxSubscriptionRepository['failWatchRenewal'];
  readonly markSyncFailed: MailboxSubscriptionRepository['markSyncFailed'];
  readonly recordNotifiedMailboxState: MailboxSubscriptionRepository['recordNotifiedMailboxState'];
  readonly requestReconciliation: MailboxSubscriptionRepository['requestReconciliation'];
  readonly recordReconciliation: MailboxSubscriptionRepository['recordReconciliation'];

  // The rules.
  readonly createRuleForMailbox: MailAutomationRuleRepository['createRuleForMailbox'];
  readonly listRulesForUser: MailAutomationRuleRepository['listRulesForUser'];
  readonly replaceRule: MailAutomationRuleRepository['replaceRule'];
  readonly setRuleStatus: MailAutomationRuleRepository['setRuleStatus'];
  readonly listActiveRules: MailAutomationRuleRepository['listActiveRules'];
  readonly isRuleSendable: MailAutomationRuleRepository['isRuleSendable'];

  // The mail they saw.
  readonly recordEvents: MailEventRepository['recordEvents'];
  readonly stripEventBodies: MailEventRepository['stripEventBodies'];
  readonly deleteEventsBefore: MailEventRepository['deleteEventsBefore'];

  // What they sent.
  readonly reserveDelivery: MailDeliveryRepository['reserveDelivery'];
  readonly countRecentDeliveries: MailDeliveryRepository['countRecentDeliveries'];
  readonly recordBlockedDelivery: MailDeliveryRepository['recordBlockedDelivery'];
  readonly claimNextDueDelivery: MailDeliveryRepository['claimNextDueDelivery'];
  readonly recordJudgeVerdict: MailDeliveryRepository['recordJudgeVerdict'];
  readonly markDeliveryHeld: MailDeliveryRepository['markDeliveryHeld'];
  readonly stageDeliveryDraft: MailDeliveryRepository['stageDeliveryDraft'];
  readonly markDeliveryDelivered: MailDeliveryRepository['markDeliveryDelivered'];
  readonly markDeliveryFailed: MailDeliveryRepository['markDeliveryFailed'];
  readonly rescheduleDelivery: MailDeliveryRepository['rescheduleDelivery'];
  readonly markDeliveryAbandoned: MailDeliveryRepository['markDeliveryAbandoned'];
  readonly dropTerminalPayloads: MailDeliveryRepository['dropTerminalPayloads'];

  // The standing summary of a mailbox, sent to its owner twice a day.
  readonly claimNextDueBrief: MailBriefRepository['claimNextDueBrief'];
  readonly ensureBrief: MailBriefRepository['ensureBrief'];
  readonly completeBrief: MailBriefRepository['completeBrief'];
  readonly releaseBrief: MailBriefRepository['releaseBrief'];
  readonly readBriefWindow: MailBriefRepository['readBriefWindow'];
  readonly readBriefForUser: MailBriefRepository['readBriefForUser'];
  readonly updateBriefForUser: MailBriefRepository['updateBriefForUser'];

  constructor(db: MailOpsDb) {
    this.subscriptions = new MailboxSubscriptionRepository(db);
    this.rules = new MailAutomationRuleRepository(db);
    this.events = new MailEventRepository(db);
    this.deliveries = new MailDeliveryRepository(db);
    this.briefs = new MailBriefRepository(db);

    const { subscriptions, rules, events, deliveries, briefs } = this;
    this.claimNextDueMailbox = subscriptions.claimNextDueMailbox.bind(subscriptions);
    this.advanceCursor = subscriptions.advanceCursor.bind(subscriptions);
    this.signalMailbox = subscriptions.signalMailbox.bind(subscriptions);
    this.claimNextWatchRenewal = subscriptions.claimNextWatchRenewal.bind(subscriptions);
    this.completeWatchRenewal = subscriptions.completeWatchRenewal.bind(subscriptions);
    this.failWatchRenewal = subscriptions.failWatchRenewal.bind(subscriptions);
    this.markSyncFailed = subscriptions.markSyncFailed.bind(subscriptions);
    this.recordNotifiedMailboxState =
      subscriptions.recordNotifiedMailboxState.bind(subscriptions);
    this.requestReconciliation =
      subscriptions.requestReconciliation.bind(subscriptions);
    this.recordReconciliation =
      subscriptions.recordReconciliation.bind(subscriptions);

    this.createRuleForMailbox = rules.createRuleForMailbox.bind(rules);
    this.listRulesForUser = rules.listRulesForUser.bind(rules);
    this.replaceRule = rules.replaceRule.bind(rules);
    this.setRuleStatus = rules.setRuleStatus.bind(rules);
    this.listActiveRules = rules.listActiveRules.bind(rules);
    this.isRuleSendable = rules.isRuleSendable.bind(rules);

    this.recordEvents = events.recordEvents.bind(events);
    this.stripEventBodies = events.stripEventBodies.bind(events);
    this.deleteEventsBefore = events.deleteEventsBefore.bind(events);

    this.reserveDelivery = deliveries.reserveDelivery.bind(deliveries);
    this.countRecentDeliveries = deliveries.countRecentDeliveries.bind(deliveries);
    this.recordBlockedDelivery = deliveries.recordBlockedDelivery.bind(deliveries);
    this.claimNextDueDelivery = deliveries.claimNextDueDelivery.bind(deliveries);
    this.recordJudgeVerdict = deliveries.recordJudgeVerdict.bind(deliveries);
    this.markDeliveryHeld = deliveries.markDeliveryHeld.bind(deliveries);
    this.stageDeliveryDraft = deliveries.stageDeliveryDraft.bind(deliveries);
    this.markDeliveryDelivered = deliveries.markDeliveryDelivered.bind(deliveries);
    this.markDeliveryFailed = deliveries.markDeliveryFailed.bind(deliveries);
    this.rescheduleDelivery = deliveries.rescheduleDelivery.bind(deliveries);
    this.markDeliveryAbandoned = deliveries.markDeliveryAbandoned.bind(deliveries);
    this.dropTerminalPayloads = deliveries.dropTerminalPayloads.bind(deliveries);

    this.claimNextDueBrief = briefs.claimNextDueBrief.bind(briefs);
    this.ensureBrief = briefs.ensureBrief.bind(briefs);
    this.completeBrief = briefs.completeBrief.bind(briefs);
    this.releaseBrief = briefs.releaseBrief.bind(briefs);
    this.readBriefWindow = briefs.readBriefWindow.bind(briefs);
    this.readBriefForUser = briefs.readBriefForUser.bind(briefs);
    this.updateBriefForUser = briefs.updateBriefForUser.bind(briefs);
  }
}
