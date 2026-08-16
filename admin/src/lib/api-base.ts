/**
 * Where the backend is.
 *
 * One module owns this, and it is deliberately not one of the modules that talk
 * to the backend. It was defined twice — privately in `lib/api.ts` and exported
 * from `chat/stream.ts` — which meant anything outside the chat that needed a
 * URL had to import it *through* the chat. The artifact panel did exactly that,
 * and a document panel depending on the chat transport is a dependency nobody
 * chose; it happened because the constant was somewhere convenient rather than
 * somewhere true.
 *
 * `import.meta.env` is Vite's, and only Vite's. Read bare, this throws for
 * anything importing the module outside a Vite build — which is every
 * `node --test` run. Optional chaining costs nothing in the browser, where the
 * object is always there.
 */
export const API_BASE_URL =
  (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_API_BASE_URL
  ?? 'http://localhost:8000'
