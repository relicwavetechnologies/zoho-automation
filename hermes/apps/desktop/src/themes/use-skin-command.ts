import { useCallback } from 'react'

/**
 * The desktop look is locked to a single skin (see themes/context.tsx), so
 * `/skin` no longer switches themes. It's kept as a no-op that returns a clear
 * message rather than failing as an unknown command.
 */
export function useSkinCommand() {
  return useCallback(() => 'The desktop appearance is locked and can’t be changed.', [])
}
