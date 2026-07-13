import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'

type FinanceDatePickerProps = {
  id: string
  value?: string
  placeholder?: string
  required?: boolean
  onChange: (value: string) => void
}

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

function atNoon(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12)
}

function parseIsoDate(value?: string): Date | null {
  if (!value) return null
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12)
  return Number.isNaN(date.getTime()) ? null : date
}

function toIsoDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function sameDay(left: Date | null, right: Date): boolean {
  return Boolean(
    left &&
      left.getFullYear() === right.getFullYear() &&
      left.getMonth() === right.getMonth() &&
      left.getDate() === right.getDate()
  )
}

function monthGrid(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1, 12)
  const start = new Date(first)
  start.setDate(first.getDate() - first.getDay())
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start)
    date.setDate(start.getDate() + index)
    return date
  })
}

const fullDateFormatter = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
})

const monthFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'long',
  year: 'numeric',
})

const accessibleDateFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
})

export function FinanceDatePicker({
  id,
  value,
  placeholder = 'Select date',
  required,
  onChange,
}: FinanceDatePickerProps) {
  const selected = useMemo(() => parseIsoDate(value), [value])
  const today = useMemo(() => atNoon(new Date()), [])
  const [open, setOpen] = useState(false)
  const [visibleMonth, setVisibleMonth] = useState(() =>
    selected ?? today
  )
  const [focusedDate, setFocusedDate] = useState(() => selected ?? today)
  const dayRefs = useRef(new Map<string, HTMLButtonElement>())
  const days = useMemo(() => monthGrid(visibleMonth), [visibleMonth])

  useEffect(() => {
    if (!open) return
    const next = selected ?? today
    setVisibleMonth(next)
    setFocusedDate(next)
  }, [open, selected, today])

  useEffect(() => {
    if (!open) return
    dayRefs.current.get(toIsoDate(focusedDate))?.focus()
  }, [focusedDate, open, visibleMonth])

  const choose = (date: Date) => {
    onChange(toIsoDate(date))
    setOpen(false)
  }

  const moveFocus = (daysToAdd: number) => {
    const next = new Date(focusedDate)
    next.setDate(next.getDate() + daysToAdd)
    setFocusedDate(next)
    if (
      next.getMonth() !== visibleMonth.getMonth() ||
      next.getFullYear() !== visibleMonth.getFullYear()
    ) {
      setVisibleMonth(next)
    }
  }

  const changeMonth = (monthsToAdd: number) => {
    const targetMonth = new Date(
      visibleMonth.getFullYear(),
      visibleMonth.getMonth() + monthsToAdd,
      1,
      12
    )
    const lastDay = new Date(
      targetMonth.getFullYear(),
      targetMonth.getMonth() + 1,
      0,
      12
    ).getDate()
    const nextFocus = new Date(
      targetMonth.getFullYear(),
      targetMonth.getMonth(),
      Math.min(focusedDate.getDate(), lastDay),
      12
    )
    setVisibleMonth(targetMonth)
    setFocusedDate(nextFocus)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          aria-required={required}
          aria-label={selected ? `Change date, ${fullDateFormatter.format(selected)}` : placeholder}
          className="w-full justify-start rounded-md font-normal"
        >
          <CalendarDays data-icon="inline-start" />
          <span className={cn(!selected && 'text-muted-foreground')}>
            {selected ? fullDateFormatter.format(selected) : placeholder}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-3">
        <div className="flex items-center justify-between">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Previous month"
            onClick={() => changeMonth(-1)}
          >
            <ChevronLeft />
          </Button>
          <p aria-live="polite" className="text-sm font-medium">
            {monthFormatter.format(visibleMonth)}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Next month"
            onClick={() => changeMonth(1)}
          >
            <ChevronRight />
          </Button>
        </div>

        <div className="mt-2 grid grid-cols-7" aria-hidden="true">
          {WEEKDAYS.map((weekday) => (
            <span
              key={weekday}
              className="flex h-7 items-center justify-center text-xs font-medium text-muted-foreground"
            >
              {weekday}
            </span>
          ))}
        </div>

        <div
          role="grid"
          aria-label={monthFormatter.format(visibleMonth)}
          className="grid grid-cols-7 gap-y-0.5"
        >
          {days.map((date) => {
            const iso = toIsoDate(date)
            const isSelected = sameDay(selected, date)
            const isToday = sameDay(today, date)
            const isOutside = date.getMonth() !== visibleMonth.getMonth()
            const isFocused = sameDay(focusedDate, date)
            return (
              <Button
                key={iso}
                ref={(node) => {
                  if (node) dayRefs.current.set(iso, node)
                  else dayRefs.current.delete(iso)
                }}
                type="button"
                role="gridcell"
                variant={isSelected ? 'default' : isToday ? 'outline' : 'ghost'}
                size="icon-sm"
                tabIndex={isFocused ? 0 : -1}
                aria-label={accessibleDateFormatter.format(date)}
                aria-selected={isSelected}
                className={cn(
                  'rounded-md font-normal',
                  isOutside && !isSelected && 'text-muted-foreground opacity-45',
                  isToday && !isSelected && 'font-medium'
                )}
                onClick={() => choose(date)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowLeft') moveFocus(-1)
                  else if (event.key === 'ArrowRight') moveFocus(1)
                  else if (event.key === 'ArrowUp') moveFocus(-7)
                  else if (event.key === 'ArrowDown') moveFocus(7)
                  else if (event.key === 'Home') moveFocus(-focusedDate.getDay())
                  else if (event.key === 'End') moveFocus(6 - focusedDate.getDay())
                  else if (event.key === 'PageUp') changeMonth(-1)
                  else if (event.key === 'PageDown') changeMonth(1)
                  else return
                  event.preventDefault()
                }}
              >
                {date.getDate()}
              </Button>
            )
          })}
        </div>

        <Separator className="my-3" />
        <div className="flex items-center justify-between">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!selected}
            onClick={() => {
              onChange('')
              setOpen(false)
            }}
          >
            Clear
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => choose(today)}>
            Today
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
