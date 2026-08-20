/**
 * What to tell somebody whose run did not finish.
 *
 * Every failure used to arrive as one of three sentences, and the one people
 * actually hit was the least true of them: "Divo lost the model connection
 * while finishing this request. Please try again." A brand-new workspace with
 * no model key got that, three times over ten seconds, when the gateway had
 * already said the useful thing on the first attempt — *there is no DeepSeek
 * key; add one in Guardrails* — and that sentence was thrown away one layer
 * below the person who needed it.
 *
 * The reason is in the detail string. It arrives wrapped, roughly:
 *
 *   Assistant error: 503: {"message":"…","type":"not_configured"}
 *
 * because Pi prefixes the gateway's own JSON body with its own summary. So the
 * job here is to find that body, read the `type` the gateway set deliberately,
 * and say the thing that type means — including what the reader can do about
 * it, which is the half a generic message can never carry.
 *
 * The `type` is the contract, not the prose. Prose is written for a person and
 * will be rewritten by one; `not_configured` is a decision the gateway made.
 */

/** The gateway's own account of why it refused. */
type ProviderRefusal = {
  readonly type: string
  readonly message: string
}

export type RuntimeFailure = {
  /** Shown to whoever asked. Says what happened and, where there is one, what to do. */
  readonly message: string
  /**
   * Whether asking again could plausibly work.
   *
   * Carried so a caller can stop inviting somebody to retry a thing that will
   * refuse identically. "Please try again" under a missing API key is the
   * product wasting the reader's time and its own credibility.
   */
  readonly retryable: boolean
}

export const GENERIC_RUNTIME_FAILURE_MESSAGE =
  'Divo hit a temporary problem while finishing this request. Please try again.'

const MODEL_CONNECTION_LOST_MESSAGE =
  'Divo lost the model connection while finishing this request. Please try again.'

const MODEL_CONNECTION_LOST_AFTER_ACTION_MESSAGE =
  'Divo lost the model connection while handling a company-action step. It did not retry automatically, '
  + 'so it would not duplicate the action. Check the latest result before trying again.'

/**
 * The gateway's JSON body, dug out of whatever wrapped it.
 *
 * Scanned for rather than parsed from the front, because the detail is a
 * human-readable summary with the body appended, and that summary's shape is
 * not something to depend on. Returns null rather than throwing on anything
 * unexpected: a failure message is the worst possible place for a second
 * failure.
 */
function refusalIn(detail: string | undefined): ProviderRefusal | null {
  if (!detail) return null
  const start = detail.indexOf('{')
  if (start === -1) return null
  const body = detail.slice(start, detail.lastIndexOf('}') + 1)
  if (!body) return null
  try {
    const parsed: unknown = JSON.parse(body)
    const record = parsed as { type?: unknown; message?: unknown; error?: { type?: unknown; message?: unknown } }
    /* The gateway sends `{error: {…}}` over HTTP and Pi sometimes forwards the
       inner object alone. Both spellings mean the same thing. */
    const inner = record.error ?? record
    const type = typeof inner.type === 'string' ? inner.type : null
    if (!type) return null
    return { type, message: typeof inner.message === 'string' ? inner.message : '' }
  } catch {
    return null
  }
}

/**
 * A refusal, in words that name the fix.
 *
 * `null` for a type with nothing specific to say, so the caller falls through
 * to whatever its code-level message is.
 */
function explainRefusal(refusal: ProviderRefusal): RuntimeFailure | null {
  if (refusal.type === 'not_configured') {
    /* The gateway names the provider inside its own message. Reusing that
       sentence keeps one source of truth for which key is missing, and adds
       where to go — the gateway says "in Guardrails" without saying where
       Guardrails is. */
    return {
      message: `${refusal.message || 'Divo has no model key configured.'} `
        + 'A company admin can add one under Settings → Company → Guardrails. '
        + 'Nothing was sent to a model.',
      retryable: false,
    }
  }
  if (refusal.type === 'guardrails') {
    return {
      message: refusal.message
        ? `Divo was not allowed to run this: ${refusal.message}`
        : 'Your workspace guardrails do not allow this model right now.',
      retryable: false,
    }
  }
  if (refusal.type === 'auth') {
    return {
      message: 'Divo could not prove who was asking. Sign out and back in, then try again.',
      retryable: false,
    }
  }
  if (refusal.type === 'upstream') {
    return {
      message: 'The model provider could not be reached. Please try again.',
      retryable: true,
    }
  }
  return null
}

/**
 * The whole mapping, from a controller failure to something worth reading.
 *
 * Order matters: the gateway's own `type` beats the controller's code, because
 * the controller code describes the *shape* of the failure ("the continuation
 * failed") while the type describes its *cause* ("there is no key"). A reader
 * can act on a cause.
 */
export function explainRuntimeFailure(code: string, detail?: string): RuntimeFailure {
  const refusal = refusalIn(detail)
  if (refusal) {
    const explained = explainRefusal(refusal)
    if (explained) return explained
  }

  if (code === 'capacity_full') {
    return { message: 'Divo is at full capacity right now. Please try again shortly.', retryable: true }
  }
  if (code === 'user_busy') {
    return { message: 'Divo is finishing your previous request. This one will start automatically.', retryable: true }
  }
  if (code === 'model_continuation_failed') {
    if (detail && /company action|duplicate action/i.test(detail)) {
      return { message: MODEL_CONNECTION_LOST_AFTER_ACTION_MESSAGE, retryable: false }
    }
    return { message: MODEL_CONNECTION_LOST_MESSAGE, retryable: true }
  }
  return { message: GENERIC_RUNTIME_FAILURE_MESSAGE, retryable: true }
}
