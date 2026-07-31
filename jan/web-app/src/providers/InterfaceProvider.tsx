import { useEffect } from 'react'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import { ACCENT_COLORS } from '@/hooks/useInterfaceSettings'

/**
 * InterfaceProvider ensures interface settings are applied on every page load
 * This component should be mounted at the root level of the application
 */
export function InterfaceProvider() {
  const { fontSize, accentColor } = useInterfaceSettings()

  // Apply interface settings on mount and when they change
  useEffect(() => {
    // Apply font size
    document.documentElement.style.setProperty('--font-size-base', fontSize)
  }, [fontSize])

  // Apply accent color. Accent drives --primary only; the sidebar is a fixed
  // neutral grey owned by index.css, so it no longer varies with the accent.
  useEffect(() => {
    const color = ACCENT_COLORS.find((c) => c.value === accentColor)
    if (!color) return

    document.documentElement.style.setProperty('--primary', color.primary)
  }, [accentColor])

  return null
}
