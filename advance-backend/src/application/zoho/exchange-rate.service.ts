/**
 * Live exchange rate service.
 *
 * Fetches rates from open.er-api.com (free, no key needed), caches for 1 hour.
 * Rates are stored as "1 unit of foreign currency = X INR" so conversion is
 * a single multiply: toINR(100, 'USD') = 100 * rates.USD = ₹8,450.
 */

const CACHE_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;

const FALLBACK_RATES: Record<string, number> = {
  INR: 1, USD: 84.5, EUR: 93.2, GBP: 107.1, AED: 23.0,
  AUD: 55.0, CAD: 62.0, SGD: 63.5, JPY: 0.56, CHF: 97.0,
};

let cached: { rates: Record<string, number>; fetchedAt: number } | null = null;

export async function getExchangeRates(): Promise<Record<string, number>> {
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.rates;
  }

  try {
    const res = await fetch('https://open.er-api.com/v6/latest/INR', {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const data = await res.json() as { result?: string; rates?: Record<string, number> };
    if (data.result !== 'success' || !data.rates) throw new Error('bad response');

    const rates: Record<string, number> = { INR: 1 };
    for (const [cur, rate] of Object.entries(data.rates)) {
      if (typeof rate === 'number' && rate > 0) {
        rates[cur] = 1 / rate;
      }
    }
    cached = { rates, fetchedAt: Date.now() };
    return rates;
  } catch {
    return cached?.rates ?? FALLBACK_RATES;
  }
}

export function buildCurrencyUtilities(rates: Record<string, number>) {
  const toINR = (amount: number, currency: string): number => {
    const cur = (currency ?? 'INR').trim().toUpperCase();
    if (cur === 'INR') return amount;
    const rate = rates[cur];
    if (!rate) return amount;
    return Math.round(amount * rate * 100) / 100;
  };

  const fromINR = (amount: number, targetCurrency: string): number => {
    const cur = (targetCurrency ?? 'INR').trim().toUpperCase();
    if (cur === 'INR') return amount;
    const rate = rates[cur];
    if (!rate) return amount;
    return Math.round((amount / rate) * 100) / 100;
  };

  const convert = (amount: number, from: string, to: string): number => {
    const inr = toINR(amount, from);
    return fromINR(inr, to);
  };

  return { toINR, fromINR, convert, exchangeRates: rates };
}
