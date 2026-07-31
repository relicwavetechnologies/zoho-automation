import { argString } from '../invoke-args'
import type { DescriptorTable, Verb } from './types'

/** `manage_event` carries its verb in an `action` field (create/update/delete). */
function manageEventVerb(a: Record<string, unknown>): Verb | undefined {
  const action = argString(a, 'action')?.toLowerCase()
  if (action === 'create') return { present: 'Creating event', past: 'Created event' }
  if (action === 'delete') return { present: 'Deleting event', past: 'Deleted event' }
  if (action === 'update' || action === 'modify') {
    return { present: 'Updating event', past: 'Updated event' }
  }
  return undefined
}

export const CALENDAR_DESCRIPTORS: DescriptorTable = {
  list_calendars: {
    verb: { present: 'Listing calendars', past: 'Listed calendars' },
    countNoun: 'calendar',
  },
  get_events: {
    verb: { present: 'Checking calendar', past: 'Checked calendar' },
    subject: (a) => argString(a, 'time_min', 'timeMin', 'calendar_id', 'calendarId'),
    countNoun: 'event',
  },
  manage_event: {
    verb: { present: 'Updating event', past: 'Updated event' },
    action: 'update',
    subject: (a) => argString(a, 'summary', 'title', 'event_id', 'eventId'),
  },
  create_calendar: {
    verb: { present: 'Creating calendar', past: 'Created calendar' },
    action: 'create',
    subject: (a) => argString(a, 'summary', 'title', 'name'),
  },
  query_freebusy: {
    verb: { present: 'Checking availability', past: 'Checked availability' },
    subject: (a) => argString(a, 'time_min', 'timeMin'),
  },
}

/**
 * The verb for a calendar call, honouring `manage_event`'s action field before
 * the static table. Exported so the resolver can special-case it without
 * teaching the generic path about calendar internals.
 */
export function calendarVerbOverride(
  op: string,
  input: Record<string, unknown> | null
): Verb | undefined {
  if (op === 'manage_event' && input) return manageEventVerb(input)
  return undefined
}
