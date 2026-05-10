const currencySymbols: Record<string, string> = {
  USD: '$',
  INR: '₹',
  EUR: '€',
  GBP: '£',
  AUD: 'A$',
  CAD: 'C$',
  SGD: 'S$',
};

export function formatAmount(cents: number, currency = 'USD'): string {
  const normalizedCurrency = currency.trim().toUpperCase() || 'USD';
  const symbol = currencySymbols[normalizedCurrency] ?? `${normalizedCurrency} `;
  const amount = cents / 100;
  const sign = amount < 0 ? '-' : '';
  const formatted = Math.abs(amount).toLocaleString('en-US', {
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
