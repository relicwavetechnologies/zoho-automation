/** Mature, emoji-free label map for supervisor tool calls. Replaces status-labels.ts. */

export interface ToolLabels {
  readonly verb:   string;  // live label between calls, e.g. "Reading Zoho…"
  readonly called: string;  // [run] line text
  readonly done:   string;  // [done] line stem (preview appended after "—")
}

const LABELS: Record<string, ToolLabels> = {
  // Legacy agent dispatcher names
  contextAgent:        { verb: 'Searching context…',   called: 'Searching context',    done: 'Searched context'    },
  zohoAgent:           { verb: 'Reading Zoho…',         called: 'Reading Zoho',          done: 'Read Zoho'          },
  larkAgent:           { verb: 'Updating Lark…',        called: 'Updating Lark',         done: 'Updated Lark'       },
  googleAgent:         { verb: 'Reading Google…',       called: 'Reading Google',         done: 'Read Google'        },
  // Dynamic graph agent names
  agent_zoho_ops:      { verb: 'Reading Zoho…',         called: 'Reading Zoho',          done: 'Read Zoho'          },
  agent_lark_ops:      { verb: 'Updating Lark…',        called: 'Updating Lark',         done: 'Updated Lark'       },
  agent_google_ops:    { verb: 'Reading Google…',       called: 'Reading Google',         done: 'Read Google'        },
  agent_context_agent: { verb: 'Searching context…',   called: 'Searching context',    done: 'Searched context'    },
  // Orchestration tools
  manageTodos:         { verb: 'Updating plan…',        called: 'Updating plan',          done: 'Updated plan'       },
  scheduleTask:        { verb: 'Scheduling…',           called: 'Scheduling task',        done: 'Scheduled task'     },
  listScheduledTasks:  { verb: 'Loading schedules…',   called: 'Loading schedules',      done: 'Loaded schedules'   },
  cancelScheduledTask: { verb: 'Cancelling schedule…', called: 'Cancelling schedule',    done: 'Cancelled schedule' },
  runScheduledTaskNow: { verb: 'Triggering schedule…', called: 'Triggering schedule',    done: 'Triggered schedule' },
};

const FALLBACK: ToolLabels = { verb: 'Working…', called: 'Working', done: 'Worked' };

export function getToolLabels(toolName: string): ToolLabels {
  return LABELS[toolName] ?? FALLBACK;
}
