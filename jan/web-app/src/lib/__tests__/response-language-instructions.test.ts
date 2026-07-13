import { describe, expect, it } from 'vitest'

import {
  RESPONSE_LANGUAGE_INSTRUCTIONS,
  appendResponseLanguageInstructions,
} from '../response-language-instructions'

describe('response language instructions', () => {
  it('requires Roman-script Hinglish for Hindi messages', () => {
    expect(RESPONSE_LANGUAGE_INSTRUCTIONS).toContain(
      'reply in natural Hinglish written only in the Roman/Latin alphabet'
    )
    expect(RESPONSE_LANGUAGE_INSTRUCTIONS).toContain(
      'Do not use Devanagari script'
    )
  })

  it('appends the rule to an existing persisted assistant prompt', () => {
    const result = appendResponseLanguageInstructions('You are Divo Dex.')

    expect(result).toContain('You are Divo Dex.\n\nResponse language rules:')
    expect(result).toContain('unless the user explicitly asks for Hindi in Devanagari')
  })

  it('still supplies the rule when no assistant prompt is configured', () => {
    expect(appendResponseLanguageInstructions()).toBe(
      RESPONSE_LANGUAGE_INSTRUCTIONS
    )
  })
})
