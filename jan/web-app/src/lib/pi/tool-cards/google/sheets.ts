import { argArrayLength, argNumber, argString } from '../invoke-args'
import type { DescriptorTable } from './types'

/** A spreadsheet's human handle: its title if present, else a short id tail. */
function sheetSubject(a: Record<string, unknown>): string | undefined {
  const title = argString(a, 'title', 'spreadsheet_name', 'name')
  if (title) return title
  const id = argString(a, 'spreadsheet_id', 'spreadsheetId')
  return id ? `sheet …${id.slice(-6)}` : undefined
}

/** "Sheet1!A1:C" style location for range-scoped calls. */
function rangeSubject(a: Record<string, unknown>): string | undefined {
  const sheet = argString(a, 'sheet_name', 'sheetName')
  const range = argString(a, 'range', 'a1_range', 'a1Range')
  if (sheet && range) return `${sheet}!${range}`
  return range ?? sheet ?? sheetSubject(a)
}

export const SHEETS_DESCRIPTORS: DescriptorTable = {
  create_spreadsheet: {
    verb: { present: 'Creating spreadsheet', past: 'Created spreadsheet' },
    action: 'create',
    subject: (a) => argString(a, 'title', 'name'),
  },
  read_sheet_values: {
    verb: { present: 'Reading', past: 'Read' },
    subject: rangeSubject,
    countNoun: 'row',
  },
  modify_sheet_values: {
    verb: { present: 'Writing', past: 'Wrote' },
    action: 'update',
    subject: rangeSubject,
    summary: ({ input }) => {
      const rows = argArrayLength(input, 'values', 'rows')
      return rows === undefined ? undefined : `${rows} ${rows === 1 ? 'row' : 'rows'}`
    },
  },
  append_table_rows: {
    verb: { present: 'Appending rows', past: 'Appended rows' },
    action: 'create',
    subject: rangeSubject,
    summary: ({ input }) => {
      const rows = argArrayLength(input, 'rows', 'values')
      return rows === undefined ? undefined : `${rows} ${rows === 1 ? 'row' : 'rows'}`
    },
  },
  list_spreadsheets: {
    verb: { present: 'Listing spreadsheets', past: 'Listed spreadsheets' },
    countNoun: 'spreadsheet',
  },
  get_spreadsheet_info: {
    verb: { present: 'Reading', past: 'Read info for' },
    subject: sheetSubject,
  },
  create_sheet: {
    verb: { present: 'Adding tab', past: 'Added tab' },
    action: 'create',
    subject: (a) => argString(a, 'sheet_name', 'title', 'name'),
  },
  format_sheet_range: {
    verb: { present: 'Formatting', past: 'Formatted' },
    action: 'update',
    subject: rangeSubject,
  },
  resize_sheet_dimensions: {
    verb: { present: 'Resizing', past: 'Resized' },
    action: 'update',
    subject: (a) => {
      const n = argNumber(a, 'size', 'pixel_size')
      const dim = argString(a, 'dimension')
      return dim && n ? `${dim} → ${n}px` : rangeSubject(a)
    },
  },
}
