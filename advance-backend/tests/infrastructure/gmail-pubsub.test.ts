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
    assert.match(recoveryListUrl, /q=in%3Ainbox\+newer_than%3A1d/);
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
