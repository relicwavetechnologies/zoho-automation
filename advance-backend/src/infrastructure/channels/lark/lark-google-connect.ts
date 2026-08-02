export const googleConnectFallbackText = (input: {
  readonly url: string;
  readonly reason: string;
}): string =>
  `${input.reason}\n\nConnect Google Workspace:\n${input.url}\n\n`
  + "This link expires in 10 minutes. I'll continue this request automatically "
  + 'after Google is connected—no need to send it again.';

export const buildGoogleConnectCard = (input: {
  readonly url: string;
  readonly reason: string;
}): string => {
  const card = buildGoogleConnectCardData(input);

  return JSON.stringify({ msg_type: 'interactive', card: JSON.stringify(card) });
};

export const buildGoogleConnectCardData = (input: {
  readonly url: string;
  readonly reason: string;
}): Record<string, unknown> => ({
    schema: '2.0',
    config: { width_mode: 'fill', update_multi: false, enable_forward: false },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: 'Connect Google Workspace' },
    },
    body: {
      vertical_spacing: '8px',
      padding: '12px 12px 12px 12px',
      elements: [
        { tag: 'markdown', content: input.reason },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: 'Connect Google' },
          type: 'primary',
          width: 'default',
          behaviors: [{ type: 'open_url', default_url: input.url }],
        },
        {
          tag: 'markdown',
          content:
            '<font color="grey">This link expires in 10 minutes. '
            + "I'll continue this request automatically after Google is connected—"
            + 'no need to send it again.</font>',
        },
      ],
    },
  });
