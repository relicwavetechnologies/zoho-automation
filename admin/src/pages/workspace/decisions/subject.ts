/**
 * What a decision is *about*, as opposed to what it asks.
 *
 * The questions on a decision are already general — pick one of these, type
 * something — and that generality is what lets one card settle every ask in the
 * product. It is also why every ask looked identical: "Approve this?" over a
 * plain sentence, whether Divo was about to email a customer or write a line
 * into a ledger.
 *
 * A subject is the missing half. It names the product being acted on and shows
 * the object that will change, in the shape that product uses for it. The
 * questions stay general; the evidence gets specific.
 *
 * Two axes, deliberately not one:
 *
 *   `brand`   — the skin. Mark, name, accent. Twenty-one values, from the one
 *               catalog that already owns third-party identity.
 *   `preview` — the shape. Seven of them, because a Gmail draft and a Lark message
 *               are the same object wearing different colours, and a Zoho Books
 *               invoice and a Shopify refund are the same object too.
 *
 * Seven shapes across twenty-one brands is why this is a table and not twenty-one
 * cards. Adding Notion is one catalog entry, not a new renderer.
 *
 * Pure on purpose. Everything here is a value or a function over values, so the
 * gallery, the tests and the live card all read the same rules.
 */
import { BRAND_CATALOG, type BrandKey } from '@/components/admin/brand-catalog'

/**
 * The object a decision will create or change, in the vendor's own terms.
 *
 * Each variant is the smallest set of fields a person needs to answer without
 * opening the product. Not a full record: a preview that has to be scrolled has
 * become the task instead of the check on it.
 */
export type DecisionPreview =
  /** A message about to be sent. Gmail, Lark, Google Chat. */
  | {
      kind: 'message'
      to: string[]
      cc?: string[]
      subject?: string
      body: string
    }
  /** A row about to be written. Airtable, Zoho CRM, AITable. */
  | {
      kind: 'record'
      collection: string
      fields: { name: string; value: string; changed?: boolean }[]
    }
  /** Money about to move or be recorded. Zoho Books, Shopify. */
  | {
      kind: 'money'
      amount: string
      party: string
      lines: { label: string; value: string }[]
      due?: string
    }
  /** A range about to change. Sheets, and any tabular write. */
  | {
      kind: 'table'
      range?: string
      columns: string[]
      rows: string[][]
      /** Rows beyond those shown, so a 4-row preview cannot imply a 4-row write. */
      more?: number
    }
  /** A slot about to be taken in somebody's day. Lark and Google Calendar. */
  | {
      kind: 'event'
      title: string
      starts: string
      ends?: string
      location?: string
      attendees?: string[]
    }
  /** A file about to be created, shared or overwritten. Drive, Docs, Canva. */
  | {
      kind: 'file'
      name: string
      detail: string
      /** Who gains access, when that is the point of the ask. */
      sharedWith?: string[]
    }
  /**
   * Access about to be granted. The connect ask.
   *
   * Listed as scopes in the member's words rather than Google's, because the
   * consent screen will show them Google's and the whole point of asking here
   * first is that the member understands before they get there.
   */
  | {
      kind: 'access'
      scopes: string[]
      account?: string
    }

export type DecisionSubject = {
  /** Which product this acts on. Drives the mark, the name and the accent. */
  brand: BrandKey
  /** The verb in the product's own language: "Send email", "Create invoice". */
  action: string
  /** What it acts on, named the way the product names it. */
  target?: string
  preview?: DecisionPreview
  /**
   * A change that cannot be taken back once made.
   *
   * Drawn as a warning on the card. Sending an email and issuing a refund are
   * both irreversible; adding a draft row is not, and marking everything
   * irreversible would teach people to ignore the mark.
   */
  irreversible?: boolean
}

export type SubjectChrome = {
  brand: BrandKey
  label: string
  accent: string
  /** The accent at card-tint strength. */
  tint: string
  /** The accent at hairline strength. */
  edge: string
}

/**
 * The one place a brand becomes colour.
 *
 * `color-mix` rather than fixed tints so a brand needs one value in the catalog
 * and both themes work: the mix happens against the live surface token, so the
 * same Zoho red lands as a pale wash in light and a dark stain in dark.
 */
export function chromeFor(subject: DecisionSubject): SubjectChrome {
  const definition = BRAND_CATALOG[subject.brand]
  return {
    brand: subject.brand,
    label: definition.label,
    accent: definition.accent,
    tint: `color-mix(in oklab, ${definition.accent} 10%, var(--bui-surface))`,
    edge: `color-mix(in oklab, ${definition.accent} 26%, var(--bui-line))`,
  }
}

/**
 * The line under the title: what is about to happen, in one phrase.
 *
 * Built here rather than written by each caller so that a subject with no
 * target still reads as a sentence, and so the same phrasing appears in the
 * card, the list and any future notification.
 */
export function subjectLine(subject: DecisionSubject): string {
  const product = BRAND_CATALOG[subject.brand].label
  return subject.target ? `${subject.action} · ${subject.target}` : `${subject.action} in ${product}`
}

/** How many rows a table preview claims to cover, shown and unshown. */
export function tableTotal(preview: Extract<DecisionPreview, { kind: 'table' }>): number {
  return preview.rows.length + (preview.more ?? 0)
}
