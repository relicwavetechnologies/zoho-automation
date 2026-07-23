import {
  API_KEY_PROVIDER_LABELS,
  type ApiKeyProvider,
} from './api-key-exhaustion.classifier';

export function buildApiKeyExhaustionCard(input: {
  provider: ApiKeyProvider;
  code: string;
  message: string;
  detectedAt: string;
}): string {
  const label = API_KEY_PROVIDER_LABELS[input.provider];
  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: 'API key exhausted' },
      template: 'red',
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content:
            `**${label}** hit an exhaustion / quota error.\n\n` +
            `Please replenish credits or rotate the API key in the Divo admin console so members are not blocked.`,
        },
      },
      {
        tag: 'div',
        fields: [
          { is_short: true, text: { tag: 'lark_md', content: `**Provider**\n${label}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**Code**\n${input.code}` } },
          { is_short: false, text: { tag: 'lark_md', content: `**First detected**\n${input.detectedAt}` } },
        ],
      },
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**Detail**\n${truncate(input.message, 400)}`,
        },
      },
    ],
  };

  return JSON.stringify({
    msg_type: 'interactive',
    card: JSON.stringify(card),
  });
}

function truncate(value: string, max: number): string {
  const trimmed = value.trim() || 'No additional detail.';
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}
