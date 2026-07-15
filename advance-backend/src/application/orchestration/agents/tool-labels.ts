/** Mature, emoji-free label map for supervisor tool calls. Replaces status-labels.ts. */

export interface ToolLabels {
  readonly verb:   string;  // live label between calls, e.g. "Reading Zoho…"
  readonly called: string;  // [run] line text
  readonly done:   string;  // [done] line stem (preview appended after "—")
  /** Past-tense label for completed activity rows, e.g. "Read", "Searched", "Listed". */
  readonly past:   string;
}

const LABELS: Record<string, ToolLabels> = {
  // Legacy agent dispatcher names
  contextAgent:        { verb: 'Searching context…',   called: 'Searching context',    done: 'Context',    past: 'Searched'  },
  zohoAgent:           { verb: 'Reading Zoho…',         called: 'Reading Zoho',          done: 'Zoho',       past: 'Read'      },
  larkAgent:           { verb: 'Updating Lark…',        called: 'Updating Lark',         done: 'Lark',       past: 'Updated'   },
  googleAgent:         { verb: 'Reading Google…',       called: 'Reading Google',         done: 'Google',     past: 'Read'      },
  // Dynamic graph agent names
  agent_zoho_ops:      { verb: 'Reading Zoho…',         called: 'Reading Zoho',          done: 'Zoho',       past: 'Read'      },
  agent_lark_ops:      { verb: 'Updating Lark…',        called: 'Updating Lark',         done: 'Lark',       past: 'Updated'   },
  agent_google_ops:    { verb: 'Reading Google…',       called: 'Reading Google',         done: 'Google',     past: 'Read'      },
  agent_context_agent: { verb: 'Searching context…',   called: 'Searching context',    done: 'Context',    past: 'Searched'  },
  // Orchestration tools
  manageTodos:         { verb: 'Updating plan…',        called: 'Updating plan',          done: 'Plan',       past: 'Updated plan' },
  scheduleTask:        { verb: 'Scheduling…',           called: 'Scheduling task',        done: 'Scheduled',  past: 'Scheduled' },
  listScheduledTasks:  { verb: 'Loading schedules…',   called: 'Loading schedules',      done: 'Schedules',  past: 'Listed'    },
  cancelScheduledTask: { verb: 'Cancelling schedule…', called: 'Cancelling schedule',    done: 'Cancelled',  past: 'Cancelled' },
  runScheduledTaskNow: { verb: 'Triggering schedule…', called: 'Triggering schedule',    done: 'Triggered',  past: 'Triggered' },
  discover_skill:    { verb: 'Finding capabilities…', called: 'Discovering skills',     done: 'Skills',     past: 'Found'     },
  call_tool:         { verb: 'Running tool…',         called: 'Calling tool',           done: 'Tool',       past: 'Ran'       },
  // Domain tools (direct, not via agent_*)
  larkTask:          { verb: 'Working on tasks…',     called: 'Working on tasks',       done: 'Tasks',      past: 'Listed tasks'    },
  larkMessaging:     { verb: 'Messaging…',            called: 'Sending message',        done: 'Message',    past: 'Sent message'    },
  larkContacts:      { verb: 'Resolving contacts…',   called: 'Resolving contacts',     done: 'Contacts',   past: 'Resolved'        },
  larkCalendar:      { verb: 'Reading calendar…',     called: 'Reading calendar',       done: 'Calendar',   past: 'Read calendar'   },
  larkMeeting:       { verb: 'Reading meetings…',     called: 'Reading meeting',        done: 'Meeting',    past: 'Read meeting'    },
  larkDoc:           { verb: 'Reading doc…',          called: 'Reading doc',            done: 'Doc',        past: 'Read doc'        },
  larkBase:          { verb: 'Reading Base…',         called: 'Reading Base',           done: 'Base',       past: 'Read Base'       },
  larkApproval:      { verb: 'Routing approval…',     called: 'Routing approval',       done: 'Approval',   past: 'Routed'          },
  googleGmail:       { verb: 'Sending email…',        called: 'Sending email',          done: 'Email',      past: 'Sent email'      },
  googleDrive:       { verb: 'Reading Drive…',        called: 'Reading Drive',          done: 'Drive',      past: 'Read Drive'      },
  googleCalendar:    { verb: 'Reading calendar…',     called: 'Reading calendar',       done: 'Calendar',   past: 'Read calendar'   },
  googleDocs:        { verb: 'Working in Docs…',      called: 'Working in Docs',         done: 'Doc',        past: 'Updated Doc'     },
  googleSheets:      { verb: 'Working in Sheets…',    called: 'Working in Sheets',       done: 'Sheet',      past: 'Updated Sheet'   },
  googleSlides:      { verb: 'Working in Slides…',    called: 'Working in Slides',       done: 'Slides',     past: 'Updated Slides'  },
  googleForms:       { verb: 'Working in Forms…',     called: 'Working in Forms',        done: 'Form',       past: 'Updated Form'    },
  googleTasks:       { verb: 'Working on tasks…',     called: 'Working on tasks',        done: 'Tasks',      past: 'Updated tasks'   },
  googleContacts:    { verb: 'Reading contacts…',     called: 'Reading contacts',        done: 'Contacts',   past: 'Read contacts'   },
  googleChat:        { verb: 'Working in Chat…',      called: 'Working in Chat',         done: 'Chat',       past: 'Updated Chat'    },
  googleAppsScript:  { verb: 'Running Apps Script…',  called: 'Running Apps Script',     done: 'Script',     past: 'Ran script'      },
  zohoBooks:         { verb: 'Reading Zoho Books…',  called: 'Reading Zoho Books',    done: 'Books',      past: 'Read Books'      },
  zohoCrm:           { verb: 'Reading Zoho CRM…',    called: 'Reading Zoho CRM',      done: 'CRM',        past: 'Read CRM'        },
  webSearch:         { verb: 'Searching web…',        called: 'Searching web',          done: 'Web',        past: 'Searched web'    },
  contextSearch:     { verb: 'Searching context…',   called: 'Searching context',     done: 'Context',    past: 'Searched'        },
  documentRag:       { verb: 'Reading documents…',   called: 'Reading documents',     done: 'Documents',  past: 'Read documents'  },
};

const FALLBACK: ToolLabels = { verb: 'Working…', called: 'Working', done: 'Done', past: 'Done' };

export function getToolLabels(toolName: string): ToolLabels {
  return LABELS[toolName] ?? FALLBACK;
}
