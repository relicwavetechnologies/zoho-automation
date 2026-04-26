/** Mature, emoji-free label map for supervisor tool calls. Replaces status-labels.ts. */

export interface ToolLabels {
  readonly verb:   string;  // live label between calls, e.g. "Reading Zoho…"
  readonly called: string;  // [run] line text
  readonly done:   string;  // [done] line stem (preview appended after "—")
}

const LABELS: Record<string, ToolLabels> = {
  contextAgent:        { verb: 'Searching context…',   called: 'Searching context',    done: 'Context'     },
  zohoAgent:           { verb: 'Reading Zoho…',         called: 'Reading Zoho',          done: 'Zoho'        },
  larkAgent:           { verb: 'Updating Lark…',        called: 'Updating Lark',         done: 'Lark'        },
  googleAgent:         { verb: 'Reading Google…',       called: 'Reading Google',         done: 'Google'      },
  manageTodos:         { verb: 'Updating plan…',        called: 'Updating plan',          done: 'Plan'        },
  scheduleTask:        { verb: 'Scheduling…',           called: 'Scheduling task',        done: 'Scheduled'   },
  listScheduledTasks:  { verb: 'Loading schedules…',   called: 'Loading schedules',      done: 'Schedules'   },
  cancelScheduledTask: { verb: 'Cancelling schedule…', called: 'Cancelling schedule',    done: 'Cancelled'   },
  runScheduledTaskNow: { verb: 'Triggering schedule…', called: 'Triggering schedule',    done: 'Triggered'   },
};

const FALLBACK: ToolLabels = { verb: 'Working…', called: 'Working', done: 'Done' };

export function getToolLabels(toolName: string): ToolLabels {
  return LABELS[toolName] ?? FALLBACK;
}
