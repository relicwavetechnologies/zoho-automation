import { Router } from 'express';

import { LarkChannelAdapter } from './lark.adapter';

const larkWebhookRoutes = Router();
const adapter = new LarkChannelAdapter();

larkWebhookRoutes.post('/events', (req, res) => {
  const normalized = adapter.normalizeIncomingEvent(req.body);

  if (!normalized) {
    return res.status(400).json({
      success: false,
      message: 'Unable to normalize Lark event payload',
    });
  }

  return res.status(202).json({
    success: true,
    message: 'Lark event normalized and accepted',
    data: {
      channel: normalized.channel,
      messageId: normalized.messageId,
      chatId: normalized.chatId,
    },
  });
});

export default larkWebhookRoutes;
