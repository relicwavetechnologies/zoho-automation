const assert = require('node:assert/strict');
const test = require('node:test');

const { parseLarkIngressPayload } = require('../dist/company/channels/lark/lark-ingress.contract');

test('parseLarkIngressPayload accepts url_verification payload', () => {
  const result = parseLarkIngressPayload({
    type: 'url_verification',
    challenge: 'challenge-123',
  });

  assert.equal(result.kind, 'url_verification');
  assert.equal(result.challenge, 'challenge-123');
});

test('parseLarkIngressPayload rejects url_verification when challenge missing', () => {
  const result = parseLarkIngressPayload({
    type: 'url_verification',
  });

  assert.equal(result.kind, 'invalid');
  assert.equal(result.reason, 'missing_challenge');
});

test('parseLarkIngressPayload accepts event_callback text message', () => {
  const result = parseLarkIngressPayload({
    type: 'event_callback',
    header: {
      event_type: 'im.message.receive_v1',
      event_id: 'evt_1',
    },
    event: {
      sender: {
        sender_id: {
          open_id: 'ou_1',
        },
      },
      message: {
        msg_type: 'text',
        message_id: 'om_1',
        chat_id: 'oc_1',
        content: JSON.stringify({ text: 'hello world' }),
      },
    },
  });

  assert.equal(result.kind, 'event_callback_message');
  assert.equal(result.eventType, 'im.message.receive_v1');
  assert.equal(result.eventId, 'evt_1');
});

test('parseLarkIngressPayload accepts event_callback raw text content', () => {
  const result = parseLarkIngressPayload({
    type: 'event_callback',
    event: {
      sender: {
        sender_id: {
          user_id: 'u_1',
        },
      },
      message: {
        message_id: 'om_2',
        chat_id: 'oc_2',
        content: 'plain text',
      },
    },
  });

  assert.equal(result.kind, 'event_callback_message');
});

test('parseLarkIngressPayload ignores valid non-message event callback', () => {
  const result = parseLarkIngressPayload({
    type: 'event_callback',
    header: {
      event_type: 'im.chat.member.bot.added_v1',
      event_id: 'evt_2',
    },
    event: {
      operator: {
        open_id: 'ou_operator',
      },
    },
  });

  assert.equal(result.kind, 'event_callback_ignored');
  assert.equal(result.reason, 'unsupported_event_callback');
  assert.equal(result.eventType, 'im.chat.member.bot.added_v1');
});

test('parseLarkIngressPayload ignores non-text message types', () => {
  const result = parseLarkIngressPayload({
    type: 'event_callback',
    event: {
      sender: {
        employee_id: 'e_1',
      },
      message: {
        msg_type: 'image',
        message_id: 'om_3',
        chat_id: 'oc_3',
        content: '{"image_key":"img_1"}',
      },
    },
  });

  assert.equal(result.kind, 'event_callback_ignored');
  assert.equal(result.reason, 'unsupported_message_type');
});

test('parseLarkIngressPayload ignores empty text messages', () => {
  const result = parseLarkIngressPayload({
    type: 'event_callback',
    event: {
      sender: {
        employee_id: 'e_2',
      },
      message: {
        msg_type: 'text',
        message_id: 'om_4',
        chat_id: 'oc_4',
        content: JSON.stringify({ text: '   ' }),
      },
    },
  });

  assert.equal(result.kind, 'event_callback_ignored');
  assert.equal(result.reason, 'empty_text_message');
});

test('parseLarkIngressPayload rejects when sender identity is missing', () => {
  const result = parseLarkIngressPayload({
    type: 'event_callback',
    event: {
      sender: {},
      message: {
        msg_type: 'text',
        message_id: 'om_5',
        chat_id: 'oc_5',
        content: JSON.stringify({ text: 'hello' }),
      },
    },
  });

  assert.equal(result.kind, 'invalid');
  assert.equal(result.reason, 'missing_sender_fields');
});

test('parseLarkIngressPayload rejects unknown payload type', () => {
  const result = parseLarkIngressPayload({
    type: 'something_else',
  });

  assert.equal(result.kind, 'invalid');
  assert.equal(result.reason, 'unknown_type');
});
