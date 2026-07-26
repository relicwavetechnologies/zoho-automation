import { localStorageKey } from '@/constants/localStorage'

/**
 * The scope the Tools screens are working in.
 *
 * Opening a tool used to lose the department you had chosen, so a manager of
 * two departments could configure the wrong one without noticing. The choice
 * lives outside the router because it survives a reload and a route change
 * equally, and there is exactly one of it.
 */
export type ToolAccessScopeId = string

export function readToolAccessScope(): ToolAccessScopeId | null {
  try {
    return window.localStorage.getItem(localStorageKey.toolAccessScope) || null
  } catch {
    return null
  }
}

export function writeToolAccessScope(scopeId: ToolAccessScopeId): void {
  try {
    window.localStorage.setItem(localStorageKey.toolAccessScope, scopeId)
  } catch {
    // A browser that refuses storage just gets the default scope.
  }
}
