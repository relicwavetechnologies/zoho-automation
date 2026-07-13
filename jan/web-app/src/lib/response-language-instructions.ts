export const RESPONSE_LANGUAGE_INSTRUCTIONS = `Response language rules:
- If the latest user message is in Hindi or mixes Hindi and English, reply in natural Hinglish written only in the Roman/Latin alphabet.
- Do not use Devanagari script for Hindi or Hinglish unless the user explicitly asks for Hindi in Devanagari.
- Keep common business and product terms in English where that sounds natural.
- If the latest user message is mostly English, reply in English.
- Do not translate the user's content unless they ask for a translation.`

export function appendResponseLanguageInstructions(
  systemMessage?: string
): string {
  const base = systemMessage?.trim()
  return base
    ? `${base}\n\n${RESPONSE_LANGUAGE_INSTRUCTIONS}`
    : RESPONSE_LANGUAGE_INSTRUCTIONS
}
