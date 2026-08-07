import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { createSign, generateKeyPairSync } from 'node:crypto';
import express from 'express';
import type { Server } from 'node:http';
import { GmailHistoryClient } from '../../src/infrastructure/google/gmail-history.client.ts';
import { GooglePubSubPushVerifier } from '../../src/infrastructure/google/google-pubsub-push-auth.ts';
import { createGmailPubSubRoutes } from '../../src/http/google/gmail-pubsub.routes.ts';
import { getGmailPubSubConfig } from '../../src/config/env.ts';

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: function() { return this; },
} as any;

describe('Gmail Pub/Sub ingestion', () => {
  it('enables watches and push only when all four settings are present', () => {
    const complete = {
      GOOGLE_PUBSUB_TOPIC: 'projects/test/topics/gmail',
      GOOGLE_PUBSUB_SUBSCRIPTION: 'projects/test/subscriptions/gmail',
      GOOGLE_PUBSUB_PUSH_AUDIENCE: 'https://divo.example/api/google/gmail-pubsub/push',
      GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT: 'gmail-push@example.iam.gserviceaccount.com',
    };

    assert.deepEqual(getGmailPubSubConfig(complete), {
      topic: complete.GOOGLE_PUBSUB_TOPIC,
      subscription: complete.GOOGLE_PUBSUB_SUBSCRIPTION,
      pushAudience: complete.GOOGLE_PUBSUB_PUSH_AUDIENCE,
      pushServiceAccount: complete.GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT,
    });
    for (const missing of Object.keys(complete)) {
      assert.equal(getGmailPubSubConfig({
        ...complete,
        [missing]: undefined,
      }), null);
    }
  });

  it('registers watch and discovers actual messages through history.list', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = new GmailHistoryClient(async (url, init) => {
      const text = String(url);
      requests.push({ url: text, init });
      if (text.endsWith('/watch')) {
        return json({ historyId: '100', expiration: '1785906000000' });
      }
      if (text.includes('/history?')) {
        return json({
          historyId: '105',
          history: [{
            messagesAdded: [
              { message: { id: 'message-1' } },
              { message: { id: 'message-1' } },
            ],
          }],
        });
      }
      if (text.includes('/messages/message-1?')) {
        return json({
          id: 'message-1',
          threadId: 'thread-1',
          historyId: '104',
          internalDate: '1785301200000',
          snippet: 'Your OTP is 123456',
          payload: {
            headers: [
              { name: 'From', value: 'alerts@example.com' },
              { name: 'To', value: 'user@example.com' },
              { name: 'Subject', value: 'Login OTP' },
            ],
            mimeType: 'text/plain',
            body: {
              data: Buffer.from('Your OTP is 123456').toString('base64url'),
            },
          },
        });
      }
      throw new Error(`Unexpected request: ${text}`);
    });

    const watch = await client.watch({
      accessToken: 'access',
      topicName: 'projects/test/topics/gmail',
    });
    const sync = await client.sync({ accessToken: 'access', historyId: '100' });

    assert.equal(watch.historyId, '100');
    assert.equal(sync.nextHistoryId, '105');
    assert.equal(sync.events.length, 1);
    assert.equal(sync.events[0]?.metadata['from'], 'alerts@example.com');
    assert.equal(sync.events[0]?.metadata['bodyText'], 'Your OTP is 123456');
    assert.match(
      requests.find(request => request.url.includes('/history?'))?.url ?? '',
      /labelId=INBOX/,
    );
    const watchBody = JSON.parse(String(requests[0]?.init?.body));
    assert.deepEqual(watchBody, {
      topicName: 'projects/test/topics/gmail',
      labelIds: ['INBOX'],
      labelFilterBehavior: 'include',
    });
  });

  it('uses one bounded recent-message reconciliation only for a stale cursor', async () => {
    let recoveryListUrl = '';
    const client = new GmailHistoryClient(async (url) => {
      const text = String(url);
      if (text.includes('/history?')) return json({ error: {} }, 404);
      if (text.endsWith('/profile')) return json({ historyId: '500' });
      if (text.includes('/messages?')) {
        recoveryListUrl = text;
        return json({ messages: [] });
      }
      throw new Error(`Unexpected request: ${text}`);
    });

    const sync = await client.sync({ accessToken: 'access', historyId: '1' });

    assert.equal(sync.staleCursorRecovered, true);
    assert.equal(sync.nextHistoryId, '500');
    assert.deepEqual(sync.events, []);
    // Seven days, not one: Gmail keeps roughly a week of history, so a cursor
    // is only ever rejected after a gap of about that long, and the old
    // one-day sweep silently dropped everything older.
    assert.match(recoveryListUrl, /q=in%3Ainbox\+newer_than%3A7d/);
  });

  it('forwards the original MIME body with HTML, inline images, and attachments', async () => {
    const originalRaw = Buffer.from([
      'From: Anthropic <no-reply@mail.anthropic.com>',
      'To: user@example.com',
      'Subject: Claude login',
      'DKIM-Signature: source-signature',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="source-mixed"',
      '',
      '--source-mixed',
      'Content-Type: multipart/related; boundary="source-related"',
      '',
      '--source-related',
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      '<html><img src=3D"cid:logo">Sign in</html>',
      '--source-related',
      'Content-Type: image/png',
      'Content-Transfer-Encoding: base64',
      'Content-ID: <logo>',
      '',
      'aW1hZ2U=',
      '--source-related--',
      '--source-mixed',
      'Content-Type: application/pdf',
      'Content-Disposition: attachment; filename="invoice.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      'cGRm',
      '--source-mixed--',
      '',
    ].join('\r\n'));
    let sentRaw: Buffer | undefined;
    const client = new GmailHistoryClient(async (url, init) => {
      const text = String(url);
      if (text.endsWith('/messages/source-message?format=raw')) {
        return json({ raw: originalRaw.toString('base64url') });
      }
      if (text.endsWith('/drafts')) {
        const body = JSON.parse(String(init?.body)) as { message: { raw: string } };
        sentRaw = Buffer.from(body.message.raw, 'base64url');
        return json({ id: 'draft-1' });
      }
      throw new Error(`Unexpected request: ${text}`);
    });

    const draftId = await client.createForwardDraft({
      accessToken: 'access',
      destination: 'owner@example.com',
      mailboxEmail: 'user@example.com',
      sourceMessageId: 'source-message',
      source: {
        from: 'Anthropic <no-reply@mail.anthropic.com>',
        to: 'user@example.com',
        subject: 'Claude login',
        snippet: 'Sign in',
        bodyText: 'Sign in',
        hasAttachment: true,
      },
      idempotencyKey: 'mail:idempotency',
      ruleId: 'rule-1',
    });

    assert.equal(draftId, 'draft-1');
    assert.ok(sentRaw);
    const rendered = sentRaw.toString('latin1');
    const originalBody = originalRaw.subarray(originalRaw.indexOf('\r\n\r\n') + 4);
    // The mailbox sends, so the address must be the mailbox or the message
    // fails DMARC; the original sender rides in the display name and in
    // Reply-To, which is where a reply has to land.
    assert.match(rendered, /^From: Anthropic via Divo <user@example\.com>\r\n/);
    assert.match(rendered, /\r\nReply-To: Anthropic <no-reply@mail\.anthropic\.com>\r\n/);
    assert.match(rendered, /\r\nTo: owner@example\.com\r\n/);
    assert.match(rendered, /\r\nSubject: Fwd: Claude login\r\n/);
    assert.doesNotMatch(rendered, /DKIM-Signature: source-signature/);
    // The original's own structure, at the top level rather than nested inside
    // a container of Divo's — which is what makes it render as itself.
    assert.match(rendered, /Content-Type: multipart\/mixed; boundary="source-mixed"/);
    assert.equal(sentRaw.includes(originalBody), true);
  });

  it('verifies Google-signed push JWT claims before admitting the notification', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });
    const publicJwk = publicKey.export({ format: 'jwk' });
    const now = Math.floor(Date.now() / 1_000);
    const header = encode({ alg: 'RS256', kid: 'key-1' });
    const claims = encode({
      iss: 'https://accounts.google.com',
      aud: 'https://app.example/api/google/gmail-pubsub/push',
      exp: now + 300,
      iat: now,
      email: 'pubsub-push@example.iam.gserviceaccount.com',
      email_verified: true,
    });
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${claims}`);
    const signature = signer.sign(privateKey).toString('base64url');
    const verifier = new GooglePubSubPushVerifier({
      audience: 'https://app.example/api/google/gmail-pubsub/push',
      serviceAccountEmail: 'pubsub-push@example.iam.gserviceaccount.com',
    }, async () => json({
      keys: [{ ...publicJwk, kid: 'key-1', alg: 'RS256' }],
    }, 200, { 'cache-control': 'max-age=3600' }));

    await verifier.verifyAuthorizationHeader(
      `Bearer ${header}.${claims}.${signature}`,
    );
    await assert.rejects(
      new GooglePubSubPushVerifier({
        audience: 'https://wrong.example/push',
        serviceAccountEmail: 'pubsub-push@example.iam.gserviceaccount.com',
      }, async () => json({
        keys: [{ ...publicJwk, kid: 'key-1', alg: 'RS256' }],
      })).verifyAuthorizationHeader(`Bearer ${header}.${claims}.${signature}`),
      /audience/,
    );
  });

  describe('push route', () => {
    let server: Server | undefined;
    after(() => server?.close());

    it('acks only after the mailbox signal is durably admitted', async () => {
      let signal: any;
      const operations: string[] = [];
      const app = express();
      app.use(express.json());
      app.use(createGmailPubSubRoutes({
        verifier: { verifyAuthorizationHeader: async () => {} },
        expectedSubscription: 'projects/test/subscriptions/gmail',
        mailOpsRepo: {
          signalMailbox: async input => {
            operations.push('signal');
            signal = input;
            return { ok: true, value: 1 };
          },
        } as any,
        wakeMailOps: () => operations.push('wake'),
        logger: noopLogger,
      }));
      server = app.listen(0);
      await new Promise(resolve => server!.once('listening', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No test port.');
      const response = await fetch(`http://127.0.0.1:${address.port}/push`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer verified',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          subscription: 'projects/test/subscriptions/gmail',
          message: {
            messageId: 'pubsub-1',
            data: Buffer.from(JSON.stringify({
              emailAddress: 'USER@example.com',
              historyId: '700',
            })).toString('base64url'),
          },
        }),
      });

      assert.equal(response.status, 204);
      assert.deepEqual(signal, {
        mailboxEmail: 'user@example.com',
        historyId: '700',
        messageId: 'pubsub-1',
      });
      assert.deepEqual(operations, ['signal', 'wake']);
    });

    it('normalizes a safe numeric Gmail history ID before admission', async () => {
      let signal: any;
      const app = express();
      app.use(express.json());
      app.use(createGmailPubSubRoutes({
        verifier: { verifyAuthorizationHeader: async () => {} },
        expectedSubscription: 'projects/test/subscriptions/gmail',
        mailOpsRepo: {
          signalMailbox: async input => {
            signal = input;
            return { ok: true, value: 1 };
          },
        } as any,
        wakeMailOps: () => {},
        logger: noopLogger,
      }));
      const numericServer = app.listen(0);
      await new Promise(resolve => numericServer.once('listening', resolve));
      const address = numericServer.address();
      if (!address || typeof address === 'string') throw new Error('No test port.');
      try {
        const response = await fetch(`http://127.0.0.1:${address.port}/push`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer verified',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            subscription: 'projects/test/subscriptions/gmail',
            message: {
              messageId: 'pubsub-numeric',
              data: Buffer.from(JSON.stringify({
                emailAddress: 'USER@example.com',
                historyId: 700,
              })).toString('base64url'),
            },
          }),
        });

        assert.equal(response.status, 204);
        assert.deepEqual(signal, {
          mailboxEmail: 'user@example.com',
          historyId: '700',
          messageId: 'pubsub-numeric',
        });
      } finally {
        numericServer.close();
      }
    });

    it('logs safe field diagnostics when a Gmail history ID is unsafe', async () => {
      const warnings: Array<{
        event: string;
        data?: Record<string, unknown>;
      }> = [];
      const logger = {
        ...noopLogger,
        warn: (event: string, data?: Record<string, unknown>) => {
          warnings.push({ event, data });
        },
        child: function() { return this; },
      };
      const app = express();
      app.use(express.json());
      app.use(createGmailPubSubRoutes({
        verifier: { verifyAuthorizationHeader: async () => {} },
        expectedSubscription: 'projects/test/subscriptions/gmail',
        mailOpsRepo: {
          signalMailbox: async () => {
            throw new Error('Unsafe history IDs must not be admitted.');
          },
        } as any,
        wakeMailOps: () => {},
        logger: logger as any,
      }));
      const invalidServer = app.listen(0);
      await new Promise(resolve => invalidServer.once('listening', resolve));
      const address = invalidServer.address();
      if (!address || typeof address === 'string') throw new Error('No test port.');
      try {
        const response = await fetch(`http://127.0.0.1:${address.port}/push`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer verified',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            subscription: 'projects/test/subscriptions/gmail',
            message: {
              messageId: 'pubsub-unsafe',
              data: Buffer.from(JSON.stringify({
                emailAddress: 'user@example.com',
                historyId: Number.MAX_SAFE_INTEGER + 1,
              })).toString('base64url'),
            },
          }),
        });

        assert.equal(response.status, 400);
        assert.deepEqual(warnings, [{
          event: 'gmail.pubsub.notification_rejected',
          data: {
            error: 'Invalid Gmail Pub/Sub notification.',
            messageId: 'pubsub-unsafe',
            reason: 'invalid_history_id',
            emailAddressType: 'string',
            historyIdType: 'number',
          },
        }]);
      } finally {
        invalidServer.close();
      }
    });

    it('does not ack when durable mailbox admission fails', async () => {
      const app = express();
      app.use(express.json());
      app.use(createGmailPubSubRoutes({
        verifier: { verifyAuthorizationHeader: async () => {} },
        expectedSubscription: 'projects/test/subscriptions/gmail',
        mailOpsRepo: {
          signalMailbox: async () => ({
            ok: false,
            error: new Error('database unavailable'),
          }),
        } as any,
        wakeMailOps: () => {},
        logger: noopLogger,
      }));
      const failureServer = app.listen(0);
      await new Promise(resolve => failureServer.once('listening', resolve));
      const address = failureServer.address();
      if (!address || typeof address === 'string') throw new Error('No test port.');
      try {
        const response = await fetch(`http://127.0.0.1:${address.port}/push`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer verified',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            subscription: 'projects/test/subscriptions/gmail',
            message: {
              messageId: 'pubsub-2',
              data: Buffer.from(JSON.stringify({
                emailAddress: 'user@example.com',
                historyId: '701',
              })).toString('base64url'),
            },
          }),
        });
        assert.notEqual(response.status, 204);
      } finally {
        failureServer.close();
      }
    });
  });
});

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function json(
  value: unknown,
  status = 200,
  headers?: HeadersInit,
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}
