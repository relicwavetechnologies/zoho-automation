/**
 * Four questions, asked one at a time, between a typed sentence and an answer.
 *
 * The old signup was one form with four fields on it, which is the same four
 * questions arranged so that none of them can be answered until all of them
 * can. That is fine for somebody who arrived intending to sign up. It is wrong
 * for somebody who arrived intending to *ask Divo something* and hit a wall,
 * because the wall is now the product's entire first impression and it is a
 * form.
 *
 * So: one card, one question, and the order matters. Email first, because the
 * domain in it answers the third question before anybody types it. Role second,
 * because it is the only one that can end the flow early — somebody joining a
 * company that already exists cannot sign themselves into it, and finding that
 * out on card two is much better than finding it out after choosing a password.
 *
 * All of this is here rather than in the view because it is the part worth
 * testing, and none of it needs a DOM to be true.
 */

/**
 * Which of the two things you are.
 *
 * Deliberately not a permission. Both land on `COMPANY_ADMIN` or on nothing at
 * all, and the card says so — a role picker that quietly means nothing is worse
 * than no role picker. What it decides is whether this flow can finish: a
 * founder creates the company, and a member has to be let into one.
 */
export type Role = 'founder' | 'member'

export type Draft = {
  email: string
  role: Role | null
  company: string
  name: string
  password: string
}

export const EMPTY_DRAFT: Draft = { email: '', role: null, company: '', name: '', password: '' }

/**
 * `invite` is where the member path stops.
 *
 * Not an error and not a failure. Divo genuinely cannot do anything for them
 * here, and the card that says so carries the one link that can.
 */
export type Step = 'email' | 'role' | 'company' | 'password' | 'invite'

export const FIRST_STEP: Step = 'email'

/**
 * Addresses that cannot own a company workspace.
 *
 * A judgement call, and the whole of it is this list, so it is one line to
 * soften if it turns out to cost more signups than it saves. The reason to have
 * it: the first user of a company becomes its only admin, and a workspace owned
 * by an address nobody at the company controls is a workspace nobody can
 * recover.
 */
const PERSONAL_HOSTS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'hotmail.com',
  'outlook.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'aol.com',
  'proton.me', 'protonmail.com', 'gmx.com', 'mail.com', 'yandex.com',
  'rediffmail.com', 'zoho.com',
])

/** Labels that are part of the suffix rather than part of the name. */
const SUFFIX_LABELS = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac'])

/** Everything after the `@`, lowercased. Empty when there is no `@`. */
export function hostOf(email: string): string {
  const at = email.lastIndexOf('@')
  if (at === -1) return ''
  return email.slice(at + 1).trim().toLowerCase()
}

export function isPersonalHost(email: string): boolean {
  return PERSONAL_HOSTS.has(hostOf(email))
}

/**
 * Deliberately loose.
 *
 * The address is proved by the backend accepting it, not by a regular
 * expression here. All this catches is the typo somebody can see the moment it
 * is pointed at, which is the only thing a client-side check is good for.
 */
export function looksLikeEmail(email: string): boolean {
  const value = email.trim()
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)
}

/**
 * A company name worth pre-filling, from the address they just typed.
 *
 * `abhishek@emiactech.com` gives "Emiactech"; `me@mail.acme-tech.co.uk` gives
 * "Acme Tech". Wrong sometimes, and that is fine — it lands in an editable
 * field with the caret in it, so the cost of a bad guess is one backspace and
 * the cost of a good one is the whole card.
 */
export function companyFromEmail(email: string): string {
  const labels = hostOf(email).split('.').filter(Boolean)
  if (labels.length === 0) return ''
  /* Drop the public suffix: the last label always, plus a `co`-style label that
     was only ever there to carry it. */
  const trimmed = labels.slice(0, -1)
  while (trimmed.length > 1 && SUFFIX_LABELS.has(trimmed[trimmed.length - 1] ?? '')) {
    trimmed.pop()
  }
  const stem = trimmed[trimmed.length - 1]
  if (!stem) return ''
  return stem
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/** Shortest password the backend will take. Kept here so the card can say it. */
export const MIN_PASSWORD = 8

/**
 * What is stopping this card, in words the person can act on.
 *
 * `null` means the card is answered. Every message names the thing to change
 * rather than the rule that was broken, because "Enter a valid email" tells
 * somebody staring at a valid-looking email precisely nothing.
 */
export function problem(step: Step, draft: Draft): string | null {
  if (step === 'email') {
    if (!draft.email.trim()) return null
    if (!looksLikeEmail(draft.email)) return 'That does not look like an email address yet.'
    if (isPersonalHost(draft.email)) {
      return `Divo needs your work address. A workspace owned by a ${hostOf(draft.email)} account is one nobody at the company can recover.`
    }
    return null
  }
  if (step === 'password' && draft.password && draft.password.length < MIN_PASSWORD) {
    return `${MIN_PASSWORD} characters or more.`
  }
  return null
}

/** Whether this card has enough to move on. */
export function answered(step: Step, draft: Draft): boolean {
  if (step === 'email') {
    return looksLikeEmail(draft.email) && !isPersonalHost(draft.email)
  }
  if (step === 'role') return draft.role !== null
  if (step === 'company') return draft.company.trim().length > 0 && draft.name.trim().length > 0
  if (step === 'password') return draft.password.length >= MIN_PASSWORD
  /* The invite card is the end of the road, not a question. */
  return false
}

/**
 * The next card, or `submit` when the last question has been answered.
 *
 * Returns the same step back when the current one is unanswered, so a caller
 * can drive this straight from a button without testing `answered` first.
 */
export function advance(step: Step, draft: Draft): Step | 'submit' {
  if (!answered(step, draft)) return step
  if (step === 'email') return 'role'
  if (step === 'role') return draft.role === 'member' ? 'invite' : 'company'
  if (step === 'company') return 'password'
  if (step === 'password') return 'submit'
  return step
}

/** The card behind this one, or `null` at the front. */
export function retreat(step: Step): Step | null {
  if (step === 'email') return null
  if (step === 'role') return 'email'
  /* Both branches of the role card go back to it. */
  return step === 'invite' ? 'role' : step === 'company' ? 'role' : 'company'
}

/**
 * How far along, for the dots at the top of the modal.
 *
 * Four, always, even on the member path — the flow does not get shorter when it
 * ends early, it stops, and drawing two dots would tell somebody they are
 * halfway through something they have actually been turned away from.
 */
export const TOTAL_STEPS = 4

export function stepIndex(step: Step): number {
  if (step === 'email') return 0
  if (step === 'role') return 1
  if (step === 'company') return 2
  if (step === 'password') return 3
  return 1
}
