/**
 * What a person sees the very first time they talk to Divo on Lark.
 *
 * Every branch here ends in something the user can read. That is the whole
 * point of the module: the paths this replaces exited silently, and a new
 * customer in a workspace nobody has connected yet is exactly the person who
 * hit them — so Divo's first impression was indistinguishable from being down.
 */

export const SIGN_IN_LINK_TTL_MINUTES = 10;

/**
 * The workspace itself has never been connected to a Divo company.
 *
 * Addressed to the person in front of us, not to the admin who has to fix it —
 * they cannot act on "no active LarkTenantBinding", but they can forward one
 * sentence to whoever set Divo up.
 */
export const SIGN_IN_WORKSPACE_NOT_CONNECTED =
  "I'm not connected to this Lark workspace yet, so I can't look you up.\n\n"
  + 'Ask whoever set Divo up to connect this workspace in the Divo admin, then message me again.';

/** Divo cannot see the directory, so it cannot confirm who this is. */
export const SIGN_IN_DIRECTORY_UNAVAILABLE =
  "I couldn't verify your account against this workspace's directory just now.\n\n"
  + 'This is on my side, not yours. Try again in a minute — if it keeps happening, ask an admin to check the Divo app permissions in Lark.';

/** Sign-in exists but this deployment has no OAuth credentials configured. */
export const SIGN_IN_NOT_CONFIGURED =
  "I know who you are, but sign-in isn't configured on this Divo deployment yet, so I can't connect your account.\n\n"
  + 'Ask an admin to finish the Lark app setup in Divo.';

/** Recognised in the workspace, but with no email address to key an account on. */
export const SIGN_IN_MISSING_EMAIL =
  'I found your Lark profile, but it has no email address synced into Divo, so I have nothing to connect your account to.\n\n'
  + 'Ask an admin to sync or invite your account, then message me again.';

/**
 * Plain-text sign-in prompt.
 *
 * Kept as the fallback for when the card fails to send: a working link in an
 * ugly message beats a button nobody received.
 */
export const signInFallbackText = (input: {
  readonly name: string;
  readonly url: string;
  readonly reason?: string;
}): string =>
  `${input.reason ?? `Hi ${input.name} — one quick step before I can work for you.`}\n\n`
  + `Connect your Lark account:\n${input.url}\n\n`
  + `The link expires in ${SIGN_IN_LINK_TTL_MINUTES} minutes. `
  + "I'll answer your message as soon as you're connected — no need to send it again.";

/**
 * Sign-in card with a single button.
 *
 * `open_url` rather than a callback: there is no state to mutate here, and a
 * callback button would need a live run to answer it. The URL already carries a
 * signed, single-use state that the callback validates against the authorising
 * Lark account, so the button is safe to render even in a group where other
 * people can see it.
 */
export const buildSignInCard = (input: {
  readonly name: string;
  readonly url: string;
  readonly reason?: string;
}): string => {
  const card = {
    schema: '2.0',
    config: { width_mode: 'fill', update_multi: false, enable_forward: false },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: 'Connect your Lark account' },
    },
    body: {
      vertical_spacing: '8px',
      padding: '12px 12px 12px 12px',
      elements: [
        {
          tag: 'markdown',
          content: input.reason ?? `Hi ${input.name} — one quick step before I can work for you.`,
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: 'Connect Lark' },
          type: 'primary',
          width: 'default',
          behaviors: [{ type: 'open_url', default_url: input.url }],
        },
        {
          tag: 'markdown',
          content:
            `<font color="grey">Link expires in ${SIGN_IN_LINK_TTL_MINUTES} minutes. `
            + "I'll answer your message as soon as you're connected — no need to send it again.</font>",
        },
      ],
    },
  };

  return JSON.stringify({ msg_type: 'interactive', card: JSON.stringify(card) });
};
