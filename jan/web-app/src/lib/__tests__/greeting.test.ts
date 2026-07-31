import { describe, expect, it } from 'vitest'

import { firstNameFrom, greetingForHour } from '../greeting'

describe('greetingForHour', () => {
  it('covers the whole clock with no gaps', () => {
    for (let hour = 0; hour < 24; hour += 1) {
      expect(greetingForHour(hour)).toMatch(/^Good (morning|afternoon|evening)$/)
    }
  })

  it('splits at the civil boundaries', () => {
    expect(greetingForHour(0)).toBe('Good evening') // after midnight
    expect(greetingForHour(4)).toBe('Good evening')
    expect(greetingForHour(5)).toBe('Good morning')
    expect(greetingForHour(11)).toBe('Good morning')
    expect(greetingForHour(12)).toBe('Good afternoon')
    expect(greetingForHour(16)).toBe('Good afternoon')
    expect(greetingForHour(17)).toBe('Good evening')
    expect(greetingForHour(23)).toBe('Good evening')
  })
})

describe('firstNameFrom', () => {
  it('takes the first word of a display name', () => {
    expect(firstNameFrom({ name: 'Abhishek Verma' })).toBe('Abhishek')
    expect(firstNameFrom({ name: '  Abhishek  ' })).toBe('Abhishek')
  })

  it('falls back to the email local part and tidies separators', () => {
    expect(firstNameFrom({ email: 'abhishek.verma@example.com' })).toBe('Abhishek')
    expect(firstNameFrom({ email: 'rahul_bhateja@example.com' })).toBe('Rahul')
  })

  it('capitalises a lowercase source', () => {
    expect(firstNameFrom({ name: 'abhishek' })).toBe('Abhishek')
  })

  it('returns an empty string when there is nothing usable', () => {
    expect(firstNameFrom({})).toBe('')
    expect(firstNameFrom({ name: '   ' })).toBe('')
    expect(firstNameFrom({ name: null, email: null })).toBe('')
  })
})
