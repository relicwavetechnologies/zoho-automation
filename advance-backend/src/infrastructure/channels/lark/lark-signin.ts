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

/**
 * The sign-in link could not be created.
 *
 * This used to mean "no Lark OAuth credentials". Sign-in happens in the web app
 * now and needs none, so the only way to get here is a failure on our side —
 * and the message says that rather than sending an admin to check a setting
 * that is no longer involved.
 */
export const SIGN_IN_UNAVAILABLE =
  "I know who you are, but I couldn't create your sign-in link just now.\n\n"
  + 'This is on my side, not yours. Message me again in a minute.';

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
  + `Sign in to Divo:\n${input.url}\n\n`
  + `The link expires in ${SIGN_IN_LINK_TTL_MINUTES} minutes. `
  + "I'll try to answer your message as soon as you're connected. If nothing appears, send it again.";

/**
 * Sign-in card with a single button.
 *
 * `open_url` rather than a callback: the button opens the web sign-in page.
 * After a successful link, `POST /api/lark/auth/link` PATCHes this card to a
 * connected state using the message id stored on the nonce.
 *
 * The button opens the web sign-in, not Lark's consent screen — one place to
 * sign in, and the identity is mapped afterwards rather than a second session
 * being minted. The URL carries a single-use nonce naming the Lark account that
 * asked, and the link endpoint refuses it if somebody else signs in. That is
 * what makes the button safe to render in a group where other people can see
 * it: following someone else's link gets you told it was not for you.
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
      title: { tag: 'plain_text', content: 'Sign in to Divo' },
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
          text: { tag: 'plain_text', content: 'Sign in' },
          type: 'primary',
          width: 'default',
          behaviors: [{ type: 'open_url', default_url: input.url }],
        },
        {
          tag: 'markdown',
          content:
            `<font color="grey">Link expires in ${SIGN_IN_LINK_TTL_MINUTES} minutes. `
            + "I'll try to answer your message as soon as you're connected. If nothing appears, send it again.</font>",
        },
      ],
    },
  };

  return JSON.stringify({ msg_type: 'interactive', card: JSON.stringify(card) });
};

/**
 * Replaces the sign-in card after the web link succeeds.
 *
 * Sent as a PATCH over the original message so the stale "Sign in" button
 * disappears once the identity is attached.
 */
export const buildSignInConnectedCard = (input: {
  readonly name: string;
  readonly replaying?: boolean;
}): string => {
  const followUp = input.replaying
    ? "I'm working on your earlier message now. If nothing appears in a minute, send it again."
    : "You're connected. You can close this tab and return to Lark.";

  const card = {
    schema: '2.0',
    config: { width_mode: 'fill', update_multi: true, enable_forward: false },
    header: {
      template: 'green',
      title: { tag: 'plain_text', content: 'Connected to Divo' },
    },
    body: {
      vertical_spacing: '8px',
      padding: '12px 12px 12px 12px',
      elements: [
        {
          tag: 'markdown',
          content: `Hi ${input.name} — you're signed in.`,
        },
        {
          tag: 'markdown',
          content: `<font color="grey">${followUp}</font>`,
        },
      ],
    },
  };

  return JSON.stringify({ msg_type: 'interactive', card: JSON.stringify(card) });
};
