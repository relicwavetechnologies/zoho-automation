export type LarkWebhookEnvelope = {
  schema?: string;
  type?: string;
  challenge?: string;
  token?: string;
  tenant_key?: string;
  tenantKey?: string;
  tenantKeyId?: string;
  header?: {
    token?: string;
    event_type?: string;
    event_id?: string;
    tenant_key?: string;
    tenantKey?: string;
  };
  event?: {
    tenant_key?: string;
    tenantKey?: string;
    operator?: {
      open_id?: string;
      user_id?: string;
      union_id?: string;
      tenant_key?: string;
      operator_id?: {
        open_id?: string;
        user_id?: string;
      };
    };
    context?: {
      open_message_id?: string;
      open_chat_id?: string;
    };
    action?: {
      value?: Record<string, unknown>;
      tag?: string;
      option?: string;
      input_value?: string;
    };
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
  action?: {
    value?: Record<string, unknown>;
    tag?: string;
    option?: string;
    input_value?: string;
  };
  open_id?: string;
  user_id?: string;
  open_message_id?: string;
  open_chat_id?: string;
};
