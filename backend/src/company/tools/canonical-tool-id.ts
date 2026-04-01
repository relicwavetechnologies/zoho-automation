import { CONSOLIDATED_TOOL_ALIAS_MAP } from './tool-registry';

declare const __canonicalToolIdBrand: unique symbol;

/**
 * Branded string type that represents a canonical tool ID — i.e. a key that
 * exists in TOOL_REGISTRY, not a deprecated alias.
 *
 * Obtain one via `toCanonicalToolId(anyId)`.  Never cast raw string literals
 * directly; always go through the resolver so aliases are collapsed at the
 * call site and TypeScript flags unresolved raw strings at compile time.
 */
export type CanonicalToolId = string & { [__canonicalToolIdBrand]: true };

/**
 * Resolves any tool ID (canonical or deprecated alias) to its canonical form.
 *
 * - If `id` appears as a key in `CONSOLIDATED_TOOL_ALIAS_MAP`, the mapped
 *   value (canonical) is returned.
 * - Otherwise the input is assumed to already be canonical and returned as-is.
 *
 * This is the single entry point for all tool-ID normalization at runtime.
 */
export const toCanonicalToolId = (id: string): CanonicalToolId =>
  (CONSOLIDATED_TOOL_ALIAS_MAP[id] ?? id) as CanonicalToolId;
