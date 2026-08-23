/**
 * What a decision is about, as opposed to what it asks.
 *
 * The questions on a decision are general on purpose — pick one of these, type
 * something — and that generality is what lets one card settle every ask in the
 * product. It is also why every ask looked identical: a sentence and two
 * buttons, whether Divo was about to email a customer or write a line into a
 * ledger.
 *
 * A subject is the other half. It names the product being acted on and carries
 * the object that will change, in the shape that product uses for it. The
 * questions stay general; the evidence gets specific.
 *
 * Two axes, deliberately not one. `brand` is the skin and `preview` is the
 * shape, because a Gmail draft and a Lark message are the same object in
 * different colours, and a Zoho Books invoice and a Shopify refund are the same
 * object too. Seven shapes across twenty-odd brands is why this is a table rather
 * than twenty-odd cards.
 *
 * Mirrored in `admin/src/pages/workspace/decisions/subject.ts`. The two trees
 * do not share types — the same arrangement, and the same reason, as `Decision`
 * itself.
 */

/**
 * A product Divo can act on, as the surfaces know it.
 *
 * The values are the browser's `BrandKey`. Stated here as a union rather than
 * left open so a tool wired to a brand the card cannot draw is a type error at
 * the table, not a missing logo in front of an approver.
 */
export type DecisionBrand =
  | 'google' | 'gmail' | 'googleSheets' | 'googleDrive' | 'googleCalendar'
  | 'googleDocs' | 'googleSlides' | 'googleForms' | 'googleTasks'
  | 'googleContacts' | 'googleChat' | 'googleAppsScript'
  | 'lark' | 'canva' | 'airtable' | 'aitable' | 'zoho' | 'zohoBooks'
  | 'zohoCrm' | 'semrush' | 'shopify';

export type DecisionPreview =
  /** A message about to be sent. Gmail, Lark, Google Chat. */
  | {
      readonly kind: 'message';
      readonly to: readonly string[];
      readonly cc?: readonly string[];
      readonly subject?: string;
      readonly body: string;
    }
  /** A row about to be written. Airtable, Zoho CRM, AITable, Lark Base. */
  | {
      readonly kind: 'record';
      readonly collection: string;
      readonly fields: readonly {
        readonly name: string;
        readonly value: string;
        readonly changed?: boolean;
      }[];
    }
  /** Money about to move or be recorded. Zoho Books, Shopify. */
  | {
      readonly kind: 'money';
      readonly amount: string;
      readonly party: string;
      readonly lines: readonly { readonly label: string; readonly value: string }[];
      readonly due?: string;
    }
  /** A range about to change. Sheets, and any tabular write. */
  | {
      readonly kind: 'table';
      readonly range?: string;
      readonly columns: readonly string[];
      readonly rows: readonly (readonly string[])[];
      /** Rows beyond those listed, so a short preview cannot imply a short write. */
      readonly more?: number;
    }
  /** A slot about to be taken in somebody's day. Lark and Google Calendar. */
  | {
      readonly kind: 'event';
      readonly title: string;
      readonly starts: string;
      readonly ends?: string;
      readonly location?: string;
      readonly attendees?: readonly string[];
    }
  /** A file about to be created, shared or overwritten. Drive, Docs, Canva. */
  | {
      readonly kind: 'file';
      readonly name: string;
      readonly detail: string;
      readonly sharedWith?: readonly string[];
    }
  /** Access about to be granted. The connect ask. */
  | {
      readonly kind: 'access';
      readonly scopes: readonly string[];
      readonly account?: string;
    };

export interface DecisionSubject {
  readonly brand: DecisionBrand;
  /** The verb in the product's own language: "Send email", "Create invoice". */
  readonly action: string;
  /** What it acts on, named the way the product names it. */
  readonly target?: string;
  readonly preview?: DecisionPreview;
  /**
   * A change that cannot be taken back once made.
   *
   * Drawn as a warning. Sending an email and issuing a refund are both
   * irreversible; adding a draft row is not, and marking everything
   * irreversible would teach people to ignore the mark.
   */
  readonly irreversible?: boolean;
}

/** How many rows a table preview covers, listed and unlisted. */
export function previewRowTotal(preview: Extract<DecisionPreview, { kind: 'table' }>): number {
  return preview.rows.length + (preview.more ?? 0);
}
