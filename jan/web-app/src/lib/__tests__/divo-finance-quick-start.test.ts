import { describe, expect, it } from 'vitest'

import {
  buildDivoQuickStartContext,
  compileFinanceQuickStart,
  DIVO_QUICK_START_METADATA_KEY,
  FINANCE_QUICK_STARTS,
  readDivoQuickStartPlan,
} from '@/lib/divo-finance-quick-start'

const definition = (id: string) => {
  const value = FINANCE_QUICK_STARTS.find((item) => item.id === id)
  if (!value) throw new Error(`Missing fixture ${id}`)
  return value
}

describe('Finance quick start compiler', () => {
  it('pins read requests to the selected connection with backend argument names', () => {
    const { plan } = compileFinanceQuickStart(
      definition('invoice-register'),
      { fromDate: '2026-07-01', toDate: '2026-07-13', status: 'overdue' },
      { connectionId: 'zoho-2', label: 'India Books' }
    )

    expect(plan.route.payload.args).toEqual({
      op: 'list_invoices',
      connectionId: 'zoho-2',
      dateFrom: '2026-07-01',
      dateTo: '2026-07-13',
      status: 'overdue',
    })
    expect(plan.safety).toBe('read_only')
  })

  it('compiles writes as approval-required and adds deterministic ID resolution', () => {
    const { plan } = compileFinanceQuickStart(
      definition('send-invoice'),
      { invoiceNumber: 'INV-1042' },
      { connectionId: 'zoho-1', label: 'HQ Books' }
    )

    expect(plan.safety).toBe('approval_required')
    expect(plan.resolution).toMatchObject({
      op: 'list_invoices',
      value: 'INV-1042',
      injectAs: 'invoiceId',
    })
    expect(plan.route.payload.args).toMatchObject({
      op: 'send_invoice',
      connectionId: 'zoho-1',
    })
  })

  it('rejects malformed metadata and builds a no-reroute Pi context', () => {
    expect(readDivoQuickStartPlan({ [DIVO_QUICK_START_METADATA_KEY]: {} })).toBeNull()

    const { plan } = compileFinanceQuickStart(
      definition('tax-summary'),
      { fromDate: '2026-04-01', toDate: '2026-06-30' },
      { connectionId: 'zoho-tax', label: 'Tax Books' }
    )
    const restored = readDivoQuickStartPlan({
      [DIVO_QUICK_START_METADATA_KEY]: plan,
    })
    const context = buildDivoQuickStartContext(restored)

    expect(context).toContain('Selected Zoho connection: Tax Books (zoho-tax)')
    expect(context).toContain('Do not call Divo Memory Recall')
    expect(context).toContain('"op":"get_tax_summary"')
  })
})
