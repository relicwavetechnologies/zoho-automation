import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { describe, expect, it } from 'vitest'

import {
  ScheduleRequest,
  formatCadence,
  formatClock,
} from './ScheduleRequest'

const daily = {
  details: {
    operation: 'create',
    name: 'Daily Email Summary to Lark DM',
    intent:
      'Search Gmail for the last 24 hours and DM a summary to the manager.',
    scheduleType: 'daily',
    timezone: 'Asia/Kolkata',
    hour: 3,
    timeMinute: 10,
  },
}

describe('formatClock', () => {
  it('renders midnight and noon as 12, not 0', () => {
    expect(formatClock(0, 5)).toBe('12:05 AM')
    expect(formatClock(12, 0)).toBe('12:00 PM')
  })

  it('pads the minute', () => {
    expect(formatClock(15, 7)).toBe('3:07 PM')
  })
})

describe('formatCadence', () => {
  it('describes a daily schedule', () => {
    expect(formatCadence(daily.details)).toBe('Every day at 3:10 AM')
  })

  it('describes hourly schedules, singular and plural', () => {
    expect(
      formatCadence({ scheduleType: 'hourly', intervalHours: 1, minute: 0 })
    ).toBe('Every hour at :00')
    expect(
      formatCadence({ scheduleType: 'hourly', intervalHours: 6, minute: 30 })
    ).toBe('Every 6 hours at :30')
  })

  it('lists weekly days in reading order', () => {
    expect(
      formatCadence({
        scheduleType: 'weekly',
        daysOfWeek: ['MO', 'WE', 'FR'],
        hour: 9,
        timeMinute: 0,
      })
    ).toBe('Every Mon, Wed & Fri at 9:00 AM')
  })

  it('uses correct ordinals for monthly days, including the teens', () => {
    const monthly = (dayOfMonth: number) =>
      formatCadence({ scheduleType: 'monthly', dayOfMonth, hour: 8, timeMinute: 0 })
    expect(monthly(1)).toBe('Monthly on the 1st at 8:00 AM')
    expect(monthly(2)).toBe('Monthly on the 2nd at 8:00 AM')
    expect(monthly(3)).toBe('Monthly on the 3rd at 8:00 AM')
    expect(monthly(11)).toBe('Monthly on the 11th at 8:00 AM')
    expect(monthly(13)).toBe('Monthly on the 13th at 8:00 AM')
    expect(monthly(21)).toBe('Monthly on the 21st at 8:00 AM')
  })

  it('renders a one-time run in the schedule own timezone', () => {
    // 21:30 UTC is 03:00 the next day in Kolkata (+05:30). Showing the browser
    // zone here would tell the reviewer the wrong day.
    const text = formatCadence({
      scheduleType: 'one_time',
      runAt: '2026-07-20T21:30:00Z',
      timezone: 'Asia/Kolkata',
    })
    expect(text).toContain('Jul 21, 2026')
    expect(text).toContain('3:00 AM')
  })

  it('returns empty rather than guessing an unknown schedule shape', () => {
    // A wrong cadence would be approved as if it were right, so no cadence
    // line is shown at all when the payload is not recognised.
    expect(formatCadence({ scheduleType: 'fortnightly' })).toBe('')
    expect(formatCadence({})).toBe('')
  })

  it('survives an invalid timezone instead of throwing', () => {
    expect(
      formatCadence({
        scheduleType: 'one_time',
        runAt: '2026-07-20T21:30:00Z',
        timezone: 'Not/AZone',
      })
    ).toContain('Once on')
  })
})

describe('ScheduleRequest', () => {
  it('leads with the cadence, timezone, name and full intent', () => {
    render(<ScheduleRequest presentation={daily} />)

    expect(screen.getByTestId('schedule-cadence')).toHaveTextContent(
      'Every day at 3:10 AM'
    )
    expect(screen.getByText('Asia/Kolkata')).toBeInTheDocument()
    expect(
      screen.getByText('Daily Email Summary to Lark DM')
    ).toBeInTheDocument()
    expect(screen.getByText(/Search Gmail for the last 24 hours/)).toBeInTheDocument()
    expect(screen.getByText('New scheduled work')).toBeInTheDocument()
  })

  it('warns that a recurring schedule runs unattended', () => {
    render(<ScheduleRequest presentation={daily} />)
    expect(
      screen.getByText(/runs on its own, without you watching/i)
    ).toBeInTheDocument()
  })

  it('does not show the unattended warning for a one-time run', () => {
    render(
      <ScheduleRequest
        presentation={{
          details: {
            operation: 'create',
            name: 'One off',
            scheduleType: 'one_time',
            runAt: '2026-07-20T21:30:00Z',
            timezone: 'UTC',
            intent: 'Do the thing once.',
          },
        }}
      />
    )
    expect(
      screen.queryByText(/runs on its own, without you watching/i)
    ).not.toBeInTheDocument()
    expect(screen.getByText('Divo runs this')).toBeInTheDocument()
  })

  it('states plainly what a cancel does, and shows the schedule id', () => {
    render(
      <ScheduleRequest
        presentation={{
          details: {
            operation: 'cancel',
            scheduleId: '8bba6aac-79aa-4729-9dd6-806f0238359e',
          },
        }}
      />
    )
    expect(screen.getByText('Cancel scheduled work')).toBeInTheDocument()
    expect(
      screen.getByText(/cancelled and will not run again/i)
    ).toBeInTheDocument()
    expect(
      screen.getByText('8bba6aac-79aa-4729-9dd6-806f0238359e')
    ).toBeInTheDocument()
  })

  it('distinguishes pause from resume, which share one descriptor action', () => {
    const { unmount } = render(
      <ScheduleRequest presentation={{ details: { operation: 'pause' } }} />
    )
    expect(screen.getByText(/stops running until it is resumed/i)).toBeInTheDocument()
    unmount()

    render(
      <ScheduleRequest presentation={{ details: { operation: 'resume' } }} />
    )
    expect(
      screen.getByText(/starts running on its normal cadence/i)
    ).toBeInTheDocument()
  })

  it('renders unrecognised fields rather than omitting them', () => {
    // An approval screen must never hide part of what is being approved.
    render(
      <ScheduleRequest
        presentation={{
          details: {
            operation: 'create',
            name: 'With extras',
            scheduleType: 'daily',
            hour: 9,
            timeMinute: 0,
            departmentId: 'finance',
          },
        }}
      />
    )
    expect(screen.getByText('departmentId')).toBeInTheDocument()
    expect(screen.getByText('finance')).toBeInTheDocument()
  })

  it('reads a flat presentation with no details wrapper', () => {
    render(
      <ScheduleRequest
        presentation={{
          operation: 'create',
          name: 'Flat shape',
          scheduleType: 'daily',
          hour: 17,
          timeMinute: 45,
        }}
      />
    )
    expect(screen.getByTestId('schedule-cadence')).toHaveTextContent(
      'Every day at 5:45 PM'
    )
  })
})
