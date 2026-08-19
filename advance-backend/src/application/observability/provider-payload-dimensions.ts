export interface ProviderPayloadDimensions {
  readonly toolSchemaBytes: number;
  readonly systemPromptBytes: number;
  readonly messagesBytes: number;
}

/** Measure provider payload shape without retaining prompts, messages, or schemas. */
export function providerPayloadDimensions(
  payload: Record<string, unknown>,
  responsesApi: boolean,
): ProviderPayloadDimensions {
  const tools = Array.isArray(payload['tools']) ? payload['tools'] : [];
  let toolSchemaBytes = 0;
  for (const candidate of tools) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const tool = candidate as Record<string, unknown>;
    const fn = tool['function'];
    const nestedParameters = fn && typeof fn === 'object' && !Array.isArray(fn)
      ? (fn as Record<string, unknown>)['parameters']
      : undefined;
    toolSchemaBytes += byteLength(nestedParameters ?? tool['parameters']);
  }

  const messageValue = responsesApi ? payload['input'] : payload['messages'];
  const messages = Array.isArray(messageValue) ? messageValue : [];
  let systemPromptBytes = responsesApi ? byteLength(payload['instructions']) : 0;
  for (const message of messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
    const record = message as Record<string, unknown>;
    if (record['role'] === 'system') systemPromptBytes += byteLength(record['content']);
  }

  return {
    toolSchemaBytes,
    systemPromptBytes,
    messagesBytes: byteLength(messageValue),
  };
}

function byteLength(value: unknown): number {
  if (value === undefined) return 0;
  try {
    return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value));
  } catch {
    return 0;
  }
}
