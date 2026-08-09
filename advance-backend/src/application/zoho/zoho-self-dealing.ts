/**
 * A company cannot owe itself money.
 *
 * Divo was asked to create an invoice from a PDF. The PDF was one the company
 * had issued — its own name on the letterhead, a customer under "Bill to" — and
 * the bill workflow read the letterhead as the supplier. It created the
 * organisation as a vendor of itself and booked ₹59,000 payable to that vendor.
 * Zoho accepted all of it, because none of it is invalid; it is only wrong.
 *
 * Routing is where that went astray, and routing is advice. This is the wall
 * behind the advice: whatever workflow is loaded and however convinced the
 * model is, a party that IS the selling organisation cannot be the other side
 * of a transaction with it.
 *
 * Recognition is deliberately narrow. A false positive here refuses a
 * legitimate write — a real supplier who happens to share a word with us — so
 * it matches only on an exact GST registration or an exact name, never on a
 * resemblance.
 */

export interface SellingOrganizationIdentity {
  readonly name?: string | undefined;
  /** Absent means unknown, never "different" — Zoho does not always report it. */
  readonly gstNo?: string | undefined;
}

export interface CounterpartyIdentity {
  readonly name?: string | undefined;
  readonly gstNo?: string | undefined;
}

/** GSTINs differ only in case and stray spacing when they are the same one. */
const normalizeGstin = (value: string | undefined): string =>
  (value ?? '').replace(/\s+/g, '').toUpperCase();

/**
 * Trailing legal form is noise for this comparison: "Relicwave" and "Relicwave
 * Pvt Ltd" are the same party wearing different paperwork, and the whole point
 * is to catch the organisation under whichever spelling it was entered.
 */
const normalizeName = (value: string | undefined): string =>
  (value ?? '')
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(/\b(private|pvt|limited|ltd|llp|inc|corp|co|company)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * Why this party is the selling organisation, or null when it is not.
 *
 * The reason is returned rather than a boolean so the refusal can name the
 * evidence — a member told only "that is not allowed" cannot tell a bug from a
 * typo in their own vendor list.
 */
export function selfDealingReason(
  organization: SellingOrganizationIdentity | undefined,
  party: CounterpartyIdentity,
): string | null {
  if (!organization) return null;

  const orgGstin = normalizeGstin(organization.gstNo);
  const partyGstin = normalizeGstin(party.gstNo);
  if (orgGstin && partyGstin && orgGstin === partyGstin) {
    return `its GST registration ${partyGstin} is the one this organisation files under`;
  }

  const orgName = normalizeName(organization.name);
  const partyName = normalizeName(party.name);
  if (orgName && partyName && orgName === partyName) {
    return `"${party.name}" is the name of the organisation these books belong to`;
  }

  return null;
}

/**
 * The refusal a member should read, or null to proceed.
 *
 * `role` is what the party was about to become — "vendor", "customer" — so the
 * sentence describes the act that was refused rather than a rule number.
 */
export function refuseSelfDealing(input: {
  readonly organization: SellingOrganizationIdentity | undefined;
  readonly party: CounterpartyIdentity;
  readonly role: 'vendor' | 'customer';
  readonly act: string;
}): string | null {
  const reason = selfDealingReason(input.organization, input.party);
  if (!reason) return null;

  return `${input.act} would make this organisation its own ${input.role}: ${reason}. `
    + (input.role === 'vendor'
      ? 'A document the company issued is money owed TO it — an invoice — not a bill it owes. '
        + 'If this came from a PDF, check who issued it: our name on the letterhead means we sent it, '
        + 'and the party under "Bill to" is the customer. Load zoho-books-invoice instead.'
      : 'Nothing is billed to the company that owns these books. Check which party the document is addressed to.');
}
