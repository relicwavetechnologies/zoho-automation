import { Router } from 'express';
import type { GooglePubSubPushVerifier } from '../../infrastructure/google/google-pubsub-push-auth';
import type { MailOpsRepository } from '../../infrastructure/persistence/mail-ops.repository';
import type { Logger } from '../../shared/logger';

export function createGmailPubSubRoutes(deps: {
  verifier: Pick<GooglePubSubPushVerifier, 'verifyAuthorizationHeader'>;
  expectedSubscription: string;
  mailOpsRepo: Pick<MailOpsRepository, 'signalMailbox'>;
  logger: Logger;
}): Router {
  const router = Router();
  const log = deps.logger.child({ route: 'gmail-pubsub-push' });

  router.post('/push', async (req, res) => {
    try {
      await deps.verifier.verifyAuthorizationHeader(req.get('authorization'));
      const envelope = readEnvelope(req.body);
      if (envelope.subscription !== deps.expectedSubscription) {
        res.status(403).json({ success: false });
        return;
      }
      const notification = decodeNotification(envelope.data);
      const signalled = await deps.mailOpsRepo.signalMailbox({
        mailboxEmail: notification.emailAddress,
        historyId: notification.historyId,
        messageId: envelope.messageId,
      });
      if (!signalled.ok) throw signalled.error;
      log.info('gmail.pubsub.notification_admitted', {
        messageId: envelope.messageId,
        mailboxCount: signalled.value,
      });
      res.status(204).send();
    } catch (error) {
      log.warn('gmail.pubsub.notification_rejected', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(400).json({ success: false });
    }
  });

  return router;
}

function readEnvelope(value: unknown): {
  subscription: string;
  data: string;
  messageId: string;
} {
  if (!value || typeof value !== 'object') throw new Error('Invalid Pub/Sub envelope.');
  const record = value as Record<string, unknown>;
  const message = record['message'];
  if (!message || typeof message !== 'object') {
    throw new Error('Invalid Pub/Sub message.');
  }
  const fields = message as Record<string, unknown>;
  if (
    typeof record['subscription'] !== 'string'
    || typeof fields['data'] !== 'string'
    || typeof fields['messageId'] !== 'string'
  ) {
    throw new Error('Incomplete Pub/Sub message.');
  }
  return {
    subscription: record['subscription'],
    data: fields['data'],
    messageId: fields['messageId'],
  };
}

function decodeNotification(value: string): {
  emailAddress: string;
  historyId: string;
} {
  const decoded = JSON.parse(
    Buffer.from(value, 'base64url').toString('utf8'),
  ) as Record<string, unknown>;
  if (
    typeof decoded['emailAddress'] !== 'string'
    || !decoded['emailAddress'].includes('@')
    || typeof decoded['historyId'] !== 'string'
    || !/^\d+$/.test(decoded['historyId'])
  ) {
    throw new Error('Invalid Gmail Pub/Sub notification.');
  }
  return {
    emailAddress: decoded['emailAddress'].trim().toLocaleLowerCase(),
    historyId: decoded['historyId'],
  };
}
