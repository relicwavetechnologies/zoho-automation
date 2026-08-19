/**
 * What to ask, for a thread with nothing in it yet.
 *
 * An empty chat is the hardest screen in the product: it can do a great many
 * things and says none of them, so the reader has to guess at both the
 * capability and the phrasing. These are three real asks, in the words someone
 * would actually type — clicking one puts it in the composer.
 *
 * They are examples and nothing more. They used to be the `prompt` field of
 * three fully scripted runs, hundreds of lines of invented beats that `/chat`
 * replayed on a timer before there was a backend to ask. Nothing has played
 * them since `live.ts` landed, and only these three fields were ever read.
 */
import type { ToolKey } from './tools'

export type Example = {
  id: string
  /** What the reader "typed". */
  prompt: string
  /**
   * The apps the ask ends up in.
   *
   * Only the last one is drawn — one mark, the app the run lands in. The full
   * set was three logos per row across three rows, which read as a logo wall.
   * The rest are kept because they say what the example is *about*, which is
   * what makes it obvious whether this list still covers the product.
   */
  apps: ToolKey[]
}

export const EXAMPLES: Example[] = [
  {
    id: 'export',
    prompt: "Pull July's Menhood purchase orders out of my inbox and put them in a clean Google Sheet",
    apps: ['gmail', 'terminal', 'sheets'],
  },
  {
    id: 'chase',
    prompt: 'Which Zoho invoices are overdue past 30 days, and draft a chase mail for each account owner',
    apps: ['zohoBooks', 'zohoCrm', 'gmail'],
  },
  {
    id: 'brief',
    prompt: "What's on for me today — pull my Lark tasks and calendar, then post the brief back to Lark",
    apps: ['lark', 'lark', 'lark'],
  },
]
