/**
 * The vendor half of the decision card: whose product, and what changes in it.
 *
 * Layout only. Which brand, which shape and which colour are decided in
 * `subject.ts`, so this file never asks "is this Zoho?" — it asks the subject
 * for its chrome and draws what it is handed. That is the whole reason a
 * twenty-first brand costs one catalog line.
 *
 * Each preview is drawn in the product's own idiom rather than as a label/value
 * list, because the point of showing it is that a person recognises the object
 * without reading it. An invoice should look like an invoice from across the
 * room.
 */
import { AlertTriangle, CalendarDays, Check, Paperclip } from 'lucide-react'
import { BrandMark } from '@/components/admin/brand-mark'
import {
  chromeFor,
  subjectLine,
  tableTotal,
  type DecisionPreview,
  type DecisionSubject,
} from './subject'

export function SubjectHeader({ subject }: { subject: DecisionSubject }) {
  const chrome = chromeFor(subject)
  return (
    <div
      className="flex items-center gap-2.5 border-b px-4 py-2.5"
      style={{ background: chrome.tint, borderColor: chrome.edge }}
    >
      <BrandMark brand={chrome.brand} size={17} decorative={false} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12.5px] font-medium leading-tight text-ink">
          {subjectLine(subject)}
        </p>
        <p className="mt-0.5 truncate text-[11px] leading-tight text-ink-3">{chrome.label}</p>
      </div>
      {subject.irreversible ? (
        <span
          className="flex shrink-0 items-center gap-1 rounded-chip px-1.5 py-0.5 text-[10.5px] font-medium"
          style={{ background: 'var(--bui-orange-tint)', color: 'var(--bui-orange-ink)' }}
        >
          <AlertTriangle size={10.5} strokeWidth={2.5} />
          Cannot be undone
        </span>
      ) : null}
    </div>
  )
}

export function SubjectPreview({ subject }: { subject: DecisionSubject }) {
  const preview = subject.preview
  if (!preview) return null
  const chrome = chromeFor(subject)
  return (
    <div className="mt-2.5 overflow-hidden rounded-control border border-line bg-inset">
      <Body preview={preview} accent={chrome.accent} />
    </div>
  )
}

function Body({ preview, accent }: { preview: DecisionPreview; accent: string }) {
  if (preview.kind === 'message') return <Message preview={preview} accent={accent} />
  if (preview.kind === 'record') return <Record preview={preview} accent={accent} />
  if (preview.kind === 'money') return <Money preview={preview} accent={accent} />
  if (preview.kind === 'table') return <Table preview={preview} accent={accent} />
  if (preview.kind === 'event') return <Event preview={preview} accent={accent} />
  if (preview.kind === 'file') return <FileCard preview={preview} accent={accent} />
  return <Access preview={preview} accent={accent} />
}

/** A mail client's header block: addressing above, the words below a rule. */
function Message({
  preview, accent,
}: { preview: Extract<DecisionPreview, { kind: 'message' }>; accent: string }) {
  return (
    <div>
      <div className="space-y-1 px-2.5 pt-2.5 pb-2">
        <Addressed label="To" people={preview.to} />
        {preview.cc?.length ? <Addressed label="Cc" people={preview.cc} /> : null}
        {preview.subject ? (
          <p className="pt-0.5 text-[12.5px] font-medium leading-snug text-ink">{preview.subject}</p>
        ) : null}
      </div>
      <div className="border-t border-line px-2.5 py-2">
        <p
          className="whitespace-pre-line border-l-2 pl-2 text-[12px] leading-relaxed text-ink-2"
          style={{ borderColor: accent }}
        >
          {preview.body}
        </p>
      </div>
    </div>
  )
}

function Addressed({ label, people }: { label: string; people: string[] }) {
  return (
    <div className="flex gap-2 text-[11.5px] leading-tight">
      <span className="w-5 shrink-0 text-ink-3">{label}</span>
      <span className="min-w-0 flex-1 truncate text-ink-2">{people.join(', ')}</span>
    </div>
  )
}

/** A database row: field names in a fixed gutter, values against them. */
function Record({
  preview, accent,
}: { preview: Extract<DecisionPreview, { kind: 'record' }>; accent: string }) {
  return (
    <div>
      <Caption>{preview.collection}</Caption>
      <div className="divide-y divide-line">
        {preview.fields.map((field) => (
          <div key={field.name} className="flex items-baseline gap-2 px-2.5 py-1.5">
            <span className="w-24 shrink-0 truncate text-[11px] text-ink-3">{field.name}</span>
            <span className="min-w-0 flex-1 text-[12px] leading-snug text-ink">{field.value}</span>
            {field.changed ? (
              <span
                className="mt-1 size-1.5 shrink-0 rounded-full"
                style={{ background: accent }}
                aria-label="changed"
              />
            ) : null}
          </div>
        ))}
      </div>
    </div>
  )
}

/** A ledger entry: the number is the headline, the breakdown is the receipt. */
function Money({
  preview, accent,
}: { preview: Extract<DecisionPreview, { kind: 'money' }>; accent: string }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 px-2.5 pt-2.5 pb-2">
        <div className="min-w-0">
          <p className="truncate text-[11.5px] leading-tight text-ink-3">{preview.party}</p>
          {preview.due ? (
            <p className="mt-0.5 text-[11px] leading-tight text-ink-3">Due {preview.due}</p>
          ) : null}
        </div>
        <p
          className="shrink-0 text-[17px] font-semibold leading-none tracking-tight"
          style={{ color: accent }}
        >
          {preview.amount}
        </p>
      </div>
      <div className="divide-y divide-line border-t border-line">
        {preview.lines.map((line) => (
          <div key={line.label} className="flex items-baseline justify-between gap-3 px-2.5 py-1.5">
            <span className="min-w-0 flex-1 truncate text-[12px] text-ink-2">{line.label}</span>
            <span className="shrink-0 text-[12px] tabular-nums text-ink">{line.value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** A spreadsheet fragment, drawn as a grid because that is what it is. */
function Table({
  preview, accent,
}: { preview: Extract<DecisionPreview, { kind: 'table' }>; accent: string }) {
  return (
    <div>
      {preview.range ? <Caption>{preview.range}</Caption> : null}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[11.5px]">
          <thead>
            <tr style={{ background: `color-mix(in oklab, ${accent} 12%, var(--bui-inset))` }}>
              {preview.columns.map((column) => (
                <th
                  key={column}
                  className="border-b border-line px-2 py-1.5 text-left font-medium text-ink-2"
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((row, index) => (
              <tr key={index} className="border-b border-line last:border-0">
                {row.map((cell, column) => (
                  <td key={column} className="px-2 py-1.5 tabular-nums text-ink">{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {preview.more ? (
        <p className="border-t border-line px-2.5 py-1.5 text-[11px] text-ink-3">
          {preview.more} more {preview.more === 1 ? 'row' : 'rows'}, {tableTotal(preview)} in total
        </p>
      ) : null}
    </div>
  )
}

/**
 * A calendar entry, with the time as the headline.
 *
 * The time is what an approver checks first — a meeting they would be double
 * booked for is the only reason to say no to most of these — so it is the
 * largest thing here, above the title rather than beside it.
 */
function Event({
  preview, accent,
}: { preview: Extract<DecisionPreview, { kind: 'event' }>; accent: string }) {
  return (
    <div className="px-2.5 py-2.5">
      <div className="flex items-start gap-2.5">
        <span
          className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-chip"
          style={{ background: `color-mix(in oklab, ${accent} 16%, var(--bui-surface))`, color: accent }}
        >
          <CalendarDays size={12} strokeWidth={2.25} />
        </span>
        <div className="min-w-0">
          <p className="text-[12.5px] font-medium leading-tight text-ink">
            {preview.starts}
            {preview.ends ? <span className="text-ink-3"> to {preview.ends}</span> : null}
          </p>
          <p className="mt-0.5 truncate text-[12px] leading-snug text-ink-2">{preview.title}</p>
          {preview.location ? (
            <p className="mt-0.5 truncate text-[11.5px] leading-tight text-ink-3">{preview.location}</p>
          ) : null}
        </div>
      </div>
      {preview.attendees?.length ? (
        <div className="mt-2 flex flex-wrap items-center gap-1 border-t border-line pt-2">
          <span className="mr-0.5 text-[11px] text-ink-3">With</span>
          {preview.attendees.map((person) => (
            <span key={person} className="rounded-chip bg-fill px-1.5 py-0.5 text-[11px] text-ink-2">
              {person}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** A file, with the people it reaches. Sharing is the part worth approving. */
function FileCard({
  preview, accent,
}: { preview: Extract<DecisionPreview, { kind: 'file' }>; accent: string }) {
  return (
    <div className="px-2.5 py-2.5">
      <div className="flex items-start gap-2">
        <span
          className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-chip"
          style={{ background: `color-mix(in oklab, ${accent} 16%, var(--bui-surface))`, color: accent }}
        >
          <Paperclip size={12} strokeWidth={2.25} />
        </span>
        <div className="min-w-0">
          <p className="truncate text-[12.5px] font-medium leading-tight text-ink">{preview.name}</p>
          <p className="mt-0.5 text-[11.5px] leading-snug text-ink-3">{preview.detail}</p>
        </div>
      </div>
      {preview.sharedWith?.length ? (
        <div className="mt-2 flex flex-wrap items-center gap-1 border-t border-line pt-2">
          <span className="mr-0.5 text-[11px] text-ink-3">Reaches</span>
          {preview.sharedWith.map((person) => (
            <span key={person} className="rounded-chip bg-fill px-1.5 py-0.5 text-[11px] text-ink-2">
              {person}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** The connect ask: what Divo will be able to do, in the member's words. */
function Access({
  preview, accent,
}: { preview: Extract<DecisionPreview, { kind: 'access' }>; accent: string }) {
  return (
    <div className="px-2.5 py-2.5">
      {preview.account ? (
        <p className="mb-1.5 truncate text-[11.5px] leading-tight text-ink-3">{preview.account}</p>
      ) : null}
      <ul className="space-y-1">
        {preview.scopes.map((scope) => (
          <li key={scope} className="flex items-start gap-1.5">
            <Check size={12} strokeWidth={2.75} className="mt-0.5 shrink-0" style={{ color: accent }} />
            <span className="text-[12px] leading-snug text-ink-2">{scope}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Caption({ children }: { children: React.ReactNode }) {
  return (
    <p className="border-b border-line px-2.5 py-1.5 text-[11px] font-medium text-ink-3">
      {children}
    </p>
  )
}
