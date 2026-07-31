/** Local-time greeting, split at the usual civil boundaries. */
export function greetingForHour(hour: number): string {
  if (hour < 5) return 'Good evening'
  if (hour < 12) return 'Good morning'
  if (hour < 17) return 'Good afternoon'
  return 'Good evening'
}

/**
 * "Abhishek Verma" → "Abhishek". Falls back to an email's local part, so a
 * member with no display name still gets addressed by something human.
 * Returns '' when there is nothing usable, letting callers drop the name.
 */
export function firstNameFrom(source: {
  name?: string | null
  email?: string | null
}): string {
  const raw = source.name?.trim() || source.email?.split('@')[0] || ''
  const first = raw.split(/[\s._-]+/).filter(Boolean)[0] ?? ''
  if (!first) return ''
  return first.charAt(0).toUpperCase() + first.slice(1)
}
