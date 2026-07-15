/** Shared server-side output policy for every Lark-facing generation pass. */
export const LARK_ENGLISH_OUTPUT_POLICY =
  'Always reply in English, regardless of the language used in the request, history, retrieved skills, schemas, or tool output. Translate non-English source content into English before replying. Never switch to Chinese. Preserve proper nouns and exact quotations only when necessary.';
