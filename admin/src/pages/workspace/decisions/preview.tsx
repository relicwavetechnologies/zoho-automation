/**
 * Every decision variant on one page, with no session and no backend.
 *
 * A decision card is the hardest surface in the product to look at while
 * building it: it appears only when an agent run happens to need a person, on
 * whichever product that run happened to touch. Waiting for one is not a design
 * loop. This is the loop.
 *
 * Fixture-driven and development-only, the same arrangement `/preview/mail`
 * uses and for the same two reasons: it is outside `<Protected>`, so anyone who
 * could reach this origin would get it signed out, and the fixtures read like
 * real work because that is the only way the layout tells the truth about
 * length.
 *
 * These fixtures are the specification for what the backend must eventually
 * send. When a subject shape here has no producer yet, that is a gap in the
 * backend rather than a liberty taken here.
 */
import { useEffect, useState } from 'react'
import { DecisionCard } from './decision.view'
import type { Decision } from './decision'

const hoursFromNow = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString()

const APPROVE_REJECT = [
  {
    id: 'verdict',
    ask: 'Go ahead?',
    pick: 'one' as const,
    options: [
      { value: 'approve', label: 'Approve', tone: 'primary' as const, settles: 'approved' as const },
      { value: 'reject', label: 'Reject', tone: 'danger' as const, settles: 'rejected' as const },
    ],
    allowText: true,
  },
]

export const DECISION_FIXTURES: Decision[] = [
  {
    id: 'gmail-send',
    title: 'Send this reply to Priya',
    source: 'Divo · Customer Service',
    subject: {
      brand: 'gmail',
      action: 'Send email',
      target: 'Re: Invoice 2214 overdue',
      irreversible: true,
      preview: {
        kind: 'message',
        to: ['priya.nair@westbridge.co.in'],
        cc: ['accounts@emiactech.com'],
        subject: 'Re: Invoice 2214 overdue',
        body: 'Hi Priya,\n\nThanks for flagging this. Invoice 2214 was raised on 12 July and is now 26 days past due. I have attached a fresh copy with the corrected GST number.\n\nCould you confirm the payment date this week?',
      },
    },
    questions: APPROVE_REJECT,
    requestedAt: hoursFromNow(-0.2),
    expiresAt: hoursFromNow(6),
    threadId: null,
  },
  {
    id: 'zoho-books-invoice',
    title: 'Raise this invoice in Zoho Books',
    detail: 'Nothing is sent to the customer until you approve.',
    source: 'Divo · Finance',
    subject: {
      brand: 'zohoBooks',
      action: 'Create invoice',
      target: 'INV-002218',
      irreversible: true,
      preview: {
        kind: 'money',
        amount: '₹1,84,500',
        party: 'Westbridge Retail Pvt Ltd',
        due: '2 September',
        lines: [
          { label: 'Retainer — August', value: '₹1,50,000' },
          { label: 'Ad spend management (3%)', value: '₹6,750' },
          { label: 'GST 18%', value: '₹27,750' },
        ],
      },
    },
    questions: APPROVE_REJECT,
    requestedAt: hoursFromNow(-1),
    expiresAt: hoursFromNow(20),
    threadId: null,
  },
  {
    id: 'sheets-write',
    title: 'Write 148 rows into the tracker',
    source: 'Divo · Growth',
    subject: {
      brand: 'googleSheets',
      action: 'Write range',
      target: 'Q3 Pipeline · Leads!A2:D149',
      preview: {
        kind: 'table',
        range: 'Leads!A2:D149',
        columns: ['Company', 'Owner', 'Stage', 'Value'],
        rows: [
          ['Westbridge Retail', 'Aleem', 'Proposal', '₹1,84,500'],
          ['Nandi Logistics', 'Priya', 'Discovery', '₹62,000'],
          ['Halcyon Foods', 'Aleem', 'Negotiation', '₹2,40,000'],
        ],
        more: 145,
      },
    },
    questions: APPROVE_REJECT,
    requestedAt: hoursFromNow(-0.5),
    expiresAt: hoursFromNow(12),
    threadId: null,
  },
  {
    id: 'airtable-update',
    title: 'Update this record',
    source: 'Divo · Operations',
    subject: {
      brand: 'airtable',
      action: 'Update record',
      target: 'Vendors · rec8Kd21Xp',
      preview: {
        kind: 'record',
        collection: 'Vendors',
        fields: [
          { name: 'Name', value: 'Halcyon Foods' },
          { name: 'Status', value: 'Approved', changed: true },
          { name: 'Payment terms', value: 'Net 45', changed: true },
          { name: 'Owner', value: 'Aleem Khan' },
        ],
      },
    },
    questions: APPROVE_REJECT,
    requestedAt: hoursFromNow(-2),
    expiresAt: hoursFromNow(30),
    threadId: null,
  },
  {
    id: 'zoho-crm-deal',
    title: 'Create this deal',
    source: 'Divo · Sales',
    subject: {
      brand: 'zohoCrm',
      action: 'Create deal',
      target: 'Halcyon Foods — Annual retainer',
      preview: {
        kind: 'record',
        collection: 'Deals',
        fields: [
          { name: 'Deal name', value: 'Halcyon Foods — Annual retainer' },
          { name: 'Amount', value: '₹24,00,000' },
          { name: 'Stage', value: 'Negotiation' },
          { name: 'Closing date', value: '30 September 2026' },
        ],
      },
    },
    questions: APPROVE_REJECT,
    requestedAt: hoursFromNow(-3),
    expiresAt: null,
    threadId: null,
  },
  {
    id: 'lark-calendar-create',
    title: 'Put this meeting in the calendar',
    source: 'Divo · Growth',
    subject: {
      brand: 'lark',
      action: 'Add event',
      target: 'Westbridge — Q3 review',
      preview: {
        kind: 'event',
        title: 'Westbridge — Q3 review',
        starts: 'Thu 21 Aug, 3:00 pm',
        ends: '4:00 pm',
        location: 'Meeting room 2',
        attendees: ['Aleem Khan', 'Priya Nair', 'rahul@emiactech.com'],
      },
    },
    questions: APPROVE_REJECT,
    requestedAt: hoursFromNow(-0.3),
    expiresAt: hoursFromNow(10),
    threadId: null,
  },
  {
    id: 'drive-share',
    title: 'Share this file outside the company',
    detail: 'The recipients are not on your Workspace domain.',
    source: 'Divo · Finance',
    subject: {
      brand: 'googleDrive',
      action: 'Share file',
      target: 'FY26 board pack.pdf',
      irreversible: true,
      preview: {
        kind: 'file',
        name: 'FY26 board pack.pdf',
        detail: 'PDF · 4.2 MB · edited 20 minutes ago',
        sharedWith: ['rahul@emiactech.com', 'board@westbridge.co.in', 'Anyone with the link'],
      },
    },
    questions: APPROVE_REJECT,
    requestedAt: hoursFromNow(-0.1),
    expiresAt: hoursFromNow(4),
    threadId: null,
  },
  {
    id: 'google-connect',
    title: 'Divo needs access to your Google Drive',
    detail: 'Your account is connected for Gmail only, so this run cannot open the sheet you pasted.',
    source: 'Divo',
    subject: {
      brand: 'google',
      action: 'Connect account',
      target: 'Drive and Sheets',
      preview: {
        kind: 'access',
        account: 'rahul@emiactech.com',
        scopes: [
          'See and open the Google Sheets you point Divo at',
          'Create and edit sheets Divo makes for you',
          'Read files in your Drive that you name',
        ],
      },
    },
    questions: [
      {
        id: 'connect',
        ask: 'Connect Google Drive?',
        pick: 'one' as const,
        options: [
          { value: 'connect', label: 'Connect Google', tone: 'primary' as const },
          { value: 'not-now', label: 'Not now', settles: 'rejected' as const },
        ],
      },
    ],
    requestedAt: hoursFromNow(-0.05),
    expiresAt: hoursFromNow(0.16),
    threadId: null,
  },
  {
    id: 'shopify-refund',
    title: 'Refund this order',
    source: 'Divo · Customer Service',
    subject: {
      brand: 'shopify',
      action: 'Issue refund',
      target: 'Order #10482',
      irreversible: true,
      preview: {
        kind: 'money',
        amount: '₹3,299',
        party: 'Meera Joshi · order #10482',
        lines: [
          { label: 'Ceramic planter, large', value: '₹2,799' },
          { label: 'Shipping', value: '₹500' },
        ],
      },
    },
    questions: APPROVE_REJECT,
    requestedAt: hoursFromNow(-4),
    expiresAt: hoursFromNow(8),
    threadId: null,
  },
  {
    id: 'plain-choice',
    title: 'Which department should own this?',
    detail: 'No product is being changed. This is what an ask with no vendor looks like.',
    source: 'Divo',
    questions: [
      {
        id: 'department',
        ask: 'Pick a department',
        pick: 'one' as const,
        options: [
          { value: 'finance', label: 'Finance' },
          { value: 'sales', label: 'Sales' },
          { value: 'cs', label: 'Customer Service' },
        ],
        allowText: true,
      },
    ],
    requestedAt: hoursFromNow(-6),
    expiresAt: null,
    threadId: null,
  },
]

export function DecisionsPreview() {
  /* The theme lives on the document element, so the toggle has to reach it.
     Wrapping the page in a `dark` div looks like it works and does not: the
     palette is declared against `html.dark`, and the cards would read tokens
     from the real theme while the page around them read the fake one. */
  const [dark, setDark] = useState(
    () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark'),
  )
  const [sent, setSent] = useState<Record<string, string>>({})

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
  }, [dark])

  return (
    <div>
      <div className="min-h-screen bg-page px-6 py-8">
        <header className="mx-auto mb-6 flex max-w-[1180px] items-baseline justify-between gap-4">
          <div>
            <h1 className="text-[15px] font-medium text-ink">Decision card variants</h1>
            <p className="mt-1 text-[12px] text-ink-3">
              {DECISION_FIXTURES.length} fixtures. One card, one brand catalog, seven preview shapes.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setDark((on) => !on)}
            className="rounded-control bg-field px-2.5 py-1.5 text-[12px] text-ink-2 shadow-btn"
          >
            {dark ? 'Light mode' : 'Dark mode'}
          </button>
        </header>

        <div
          className="mx-auto grid max-w-[1180px] gap-5"
          style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))' }}
        >
          {DECISION_FIXTURES.map((decision) => (
            <div key={decision.id}>
              <p className="mb-1.5 text-[11px] text-ink-3">{decision.id}</p>
              <DecisionCard
                decision={decision}
                onSend={(answer) =>
                  setSent((prior) => ({
                    ...prior,
                    [decision.id]: answer.responses
                      .map((response) => [...response.chose, response.said].filter(Boolean).join(' '))
                      .join(' · '),
                  }))
                }
                onDismiss={() => undefined}
              />
              {sent[decision.id] ? (
                <p className="mt-1.5 text-[11px] text-ink-3">answered: {sent[decision.id]}</p>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
