import { describe, expect, it } from 'vitest'

import {
  RESPONSE_LANGUAGE_INSTRUCTIONS,
  appendResponseLanguageInstructions,
} from '../response-language-instructions'

describe('response language instructions', () => {
  it('requires English for every user-facing response', () => {
    expect(RESPONSE_LANGUAGE_INSTRUCTIONS).toContain(
      'Respond in English only'
    )
    expect(RESPONSE_LANGUAGE_INSTRUCTIONS).toContain(
      'Never switch to Chinese or another language'
    )
  })

  it('appends the rule to an existing persisted assistant prompt', () => {
    const result = appendResponseLanguageInstructions('You are Divo Dex.')

    expect(result).toContain('You are Divo Dex.\n\nResponse language rules:')
    expect(result).toContain('silently rewrite any non-English generated prose into English')
  })

  it('still supplies the rule when no assistant prompt is configured', () => {
    expect(appendResponseLanguageInstructions()).toBe(
      RESPONSE_LANGUAGE_INSTRUCTIONS
    )
  })
})
