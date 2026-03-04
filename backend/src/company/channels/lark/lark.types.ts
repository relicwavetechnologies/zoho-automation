export type LarkWebhookEnvelope = {
  schema?: string;
  type?: string;
  challenge?: string;
  token?: string;
  header?: {
    token?: string;
    event_type?: string;
    event_id?: string;
  };
  event?: {
    sender?: {
      sender_id?: {
        open_id?: string;
        user_id?: string;
      };
      employee_id?: string;
    };
    message?: {
      msg_type?: string;
      message_id?: string;
      chat_id?: string;
      chat_type?: 'p2p' | 'group' | string;
      create_time?: string;
      content?: string;
    };
  };
};
