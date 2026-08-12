/**
 * What belongs in the work log, and what belongs in the conversation.
 *
 * One rule, and the whole readability of a turn rests on it: **everything the
 * run did while it was working goes in the log; what it hands back does not.**
 * The log folds itself away the moment there is an answer, so the reader ends
 * up with a reply and a receipt rather than a transcript.
 *
 * The line runs between kinds of prose, not between prose and machinery. A tool
 * row is obviously the run's own business. So is "let me check the invoices
 * first" — it is the model thinking out loud, and it reads as an answer only
 * because it is written in the same voice as one. Printed in the column beside
 * the reply, three of those make a turn that ends in four paragraphs with no
 * indication which is the conclusion. That is the complaint this file answers.
 *
 * Adjacent log beats coalesce into one block rather than one per beat, so the
 * fold is a single gesture over the whole stretch of work. Anything else — a
 * table, a chart, an approval — stays exactly where the run put it, because
 * ordering carries meaning: the invoice run draws its ageing chart *before* it
 * asks permission to send anything, and a layout that sorted by kind printed
 * the chart underneath the approval it existed to inform.
 */
import type { Beat } from './transcripts'

export type BeatAt = { beat: Beat; index: number }

export type BeatGroup =
  /** A run of consecutive work — tool steps and the model's asides. */
  | { kind: 'log'; items: BeatAt[] }
  /** Anything that stands on its own in the conversation. */
  | { kind: 'beat'; item: BeatAt }

/** Whether a beat is part of the working, rather than part of the reply. */
export function isWorkBeat(beat: Beat): boolean {
  if (beat.t === 'step') return true
  return beat.t === 'say' && beat.narration === true
}

export function groupBeats(beats: readonly Beat[]): BeatGroup[] {
  const groups: BeatGroup[] = []
  beats.forEach((beat, index) => {
    if (!isWorkBeat(beat)) {
      groups.push({ kind: 'beat', item: { beat, index } })
      return
    }
    const tail = groups[groups.length - 1]
    if (tail?.kind === 'log') tail.items.push({ beat, index })
    else groups.push({ kind: 'log', items: [{ beat, index }] })
  })
  return groups
}
