import { argString } from '../invoke-args'
import type { DescriptorTable } from './types'

/**
 * Gmail operations → subject (from the native input) and count noun.
 *
 * Result counts, titles and previews are extracted generically from the output
 * by `summarizeToolResult`; a descriptor only supplies what the request knows
 * (the subject) and what to call the things counted.
 */
export const GMAIL_DESCRIPTORS: DescriptorTable = {
  search_gmail_messages: {
    subject: (a) => argString(a, 'query', 'q'),
    countNoun: 'message',
  },
  get_gmail_message_content: {
    verb: { present: 'Opening', past: 'Read message' },
    subject: (a) => argString(a, 'subject', 'message_id', 'messageId'),
  },
  get_gmail_thread_content: {
    verb: { present: 'Opening', past: 'Read thread' },
    subject: (a) => argString(a, 'subject', 'thread_id', 'threadId'),
  },
  send_gmail_message: {
    verb: { present: 'Sending email', past: 'Sent email' },
    action: 'send',
    subject: (a) => {
      const to = argString(a, 'to', 'recipient')
      const subject = argString(a, 'subject')
      return subject ? (to ? `“${subject}” → ${to}` : `“${subject}”`) : to
    },
  },
  draft_gmail_message: {
    verb: { present: 'Drafting email', past: 'Drafted email' },
    action: 'create',
    subject: (a) => {
      const subject = argString(a, 'subject')
      return subject ? `“${subject}”` : argString(a, 'to', 'recipient')
    },
  },
  modify_gmail_message_labels: {
    verb: { present: 'Relabelling', past: 'Relabelled message' },
    action: 'update',
    subject: (a) => argString(a, 'add_label_names', 'labels', 'label'),
  },
  list_gmail_labels: {
    verb: { present: 'Listing labels', past: 'Listed labels' },
    countNoun: 'label',
  },
}
