import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { FinanceDatePicker } from '../FinanceDatePicker'

describe('FinanceDatePicker', () => {
  it('renders a formatted value without a native date input', () => {
    render(
      <FinanceDatePicker
        id="as-of"
        value="2026-07-13"
        onChange={vi.fn()}
      />
    )

    expect(
      screen.getByRole('button', { name: /Change date, Jul 13, 2026/i })
    ).toBeInTheDocument()
    expect(document.querySelector('input[type="date"]')).toBeNull()
  })

  it('navigates months and emits an ISO date', () => {
    const onChange = vi.fn()
    render(
      <FinanceDatePicker
        id="as-of"
        value="2026-07-13"
        onChange={onChange}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Change date/i }))
    expect(screen.getByText('July 2026')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }))
    expect(screen.getByText('August 2026')).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('gridcell', { name: /August 5, 2026/i })
    )

    expect(onChange).toHaveBeenCalledWith('2026-08-05')
  })

  it('supports arrow-key navigation from the selected day', () => {
    const onChange = vi.fn()
    render(
      <FinanceDatePicker
        id="as-of"
        value="2026-07-13"
        onChange={onChange}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Change date/i }))
    const selected = screen.getByRole('gridcell', {
      name: /July 13, 2026/i,
    })
    fireEvent.keyDown(selected, { key: 'ArrowRight' })
    fireEvent.click(
      screen.getByRole('gridcell', { name: /July 14, 2026/i })
    )

    expect(onChange).toHaveBeenCalledWith('2026-07-14')
  })
})
