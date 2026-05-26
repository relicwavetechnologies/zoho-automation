const currencySymbols: Record<string, string> = {
  USD: '$', INR: '₹', EUR: '€', GBP: '£',
  AUD: 'A$', CAD: 'C$', SGD: 'S$',
  AED: 'AED ', JPY: '¥', CHF: 'CHF ',
};

export function formatAmount(value: number, currency = 'INR'): string {
  const normalizedCurrency = currency.trim().toUpperCase() || 'INR';
  const symbol = currencySymbols[normalizedCurrency] ?? `${normalizedCurrency} `;
  const sign = value < 0 ? '-' : '';
  const locale = normalizedCurrency === 'INR' ? 'en-IN' : 'en-US';
  const formatted = Math.abs(value).toLocaleString(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${sign}${symbol}${formatted}`;
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en-US', {
    month: 'long',
    day:   'numeric',
    year:  'numeric',
    timeZone: 'UTC',
  });
}
