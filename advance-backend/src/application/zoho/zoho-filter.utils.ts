export interface DateRangeFilter {
  from: string;
  to: string;
}

const pad = (value: number): string => String(value).padStart(2, '0');

function toIsoDate(date: Date): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function startOfMonth(year: number, monthIndex: number): Date {
  return new Date(Date.UTC(year, monthIndex, 1));
}

function endOfMonth(year: number, monthIndex: number): Date {
  return new Date(Date.UTC(year, monthIndex + 1, 0));
}

function parseQuarter(raw: string): DateRangeFilter | null {
  const match = raw.match(/^q([1-4])\s+(\d{4})$/i) ?? raw.match(/^(\d{4})\s+q([1-4])$/i);
  if (!match) return null;

  const quarter = Number(raw.toLowerCase().startsWith('q') ? match[1] : match[2]);
  const year = Number(raw.toLowerCase().startsWith('q') ? match[2] : match[1]);
  if (!Number.isInteger(quarter) || !Number.isInteger(year)) return null;

  const startMonth = (quarter - 1) * 3;
  return {
    from: toIsoDate(startOfMonth(year, startMonth)),
    to:   toIsoDate(endOfMonth(year, startMonth + 2)),
  };
}

export function parseDateFilter(input: string, now = new Date()): DateRangeFilter {
  const value = input.trim().toLowerCase();
  if (!value) {
    const today = toIsoDate(now);
    return { from: today, to: today };
  }

  const quarter = parseQuarter(value);
  if (quarter) return quarter;

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { from: value, to: value };
  }

  if (/^\d{4}$/.test(value)) {
    const year = Number(value);
    return { from: `${year}-01-01`, to: `${year}-12-31` };
  }

  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();

  switch (value) {
    case 'today': {
      const today = toIsoDate(now);
      return { from: today, to: today };
    }
    case 'yesterday': {
      const date = new Date(Date.UTC(year, month, now.getUTCDate() - 1));
      const iso = toIsoDate(date);
      return { from: iso, to: iso };
    }
    case 'this month':
      return { from: toIsoDate(startOfMonth(year, month)), to: toIsoDate(endOfMonth(year, month)) };
    case 'last month': {
      const last = new Date(Date.UTC(year, month - 1, 1));
      return {
        from: toIsoDate(startOfMonth(last.getUTCFullYear(), last.getUTCMonth())),
        to:   toIsoDate(endOfMonth(last.getUTCFullYear(), last.getUTCMonth())),
      };
    }
    case 'this quarter': {
      const startMonth = Math.floor(month / 3) * 3;
      return { from: toIsoDate(startOfMonth(year, startMonth)), to: toIsoDate(endOfMonth(year, startMonth + 2)) };
    }
    case 'last quarter': {
      const currentStartMonth = Math.floor(month / 3) * 3;
      const lastQuarterStart = new Date(Date.UTC(year, currentStartMonth - 3, 1));
      const startMonth = lastQuarterStart.getUTCMonth();
      const quarterYear = lastQuarterStart.getUTCFullYear();
      return { from: toIsoDate(startOfMonth(quarterYear, startMonth)), to: toIsoDate(endOfMonth(quarterYear, startMonth + 2)) };
    }
    case 'this year':
      return { from: `${year}-01-01`, to: `${year}-12-31` };
    case 'last year':
      return { from: `${year - 1}-01-01`, to: `${year - 1}-12-31` };
    default:
      return { from: input, to: input };
  }
}

const statusMap: Record<string, string> = {
  unpaid: 'unpaid',
  overdue: 'overdue',
  paid: 'paid',
  draft: 'draft',
  sent: 'sent',
  void: 'void',
  voided: 'void',
  partially_paid: 'partially_paid',
  'partially paid': 'partially_paid',
  open: 'sent',
};

export function normalizeStatus(input: string): string {
  const normalized = input.trim().toLowerCase().replace(/[-_]+/g, ' ');
  return statusMap[normalized] ?? normalized.replace(/\s+/g, '_');
}
