export type LarkWebhookEnvelope = {
  event?: {
    sender?: {
      sender_id?: {
        open_id?: string;
        user_id?: string;
      };
      employee_id?: string;
    };
    message?: {
      message_id?: string;
      chat_id?: string;
      chat_type?: 'p2p' | 'group' | string;
      create_time?: string;
      content?: string;
    };
  };
};
