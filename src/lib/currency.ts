export type SupportedCurrency = 'USD' | 'PKR';

export const SUPPORTED_CURRENCIES: readonly SupportedCurrency[] = ['USD', 'PKR'] as const;

export const DEFAULT_CURRENCY: SupportedCurrency = 'USD';

/**
 * Standard exchange rate used for live USD <-> PKR conversion across the portal.
 * Can be overridden via NEXT_PUBLIC_USD_TO_PKR_RATE environment variable.
 */
export const USD_TO_PKR_RATE: number =
  Number(process.env.NEXT_PUBLIC_USD_TO_PKR_RATE) > 0
    ? Number(process.env.NEXT_PUBLIC_USD_TO_PKR_RATE)
    : 280;

export const CURRENCY_META: Record<
  SupportedCurrency,
  { code: SupportedCurrency; symbol: string; label: string }
> = {
  USD: { code: 'USD', symbol: '$', label: 'USD ($)' },
  PKR: { code: 'PKR', symbol: '₨', label: 'PKR (₨)' },
};

/**
 * Normalizes any stored currency code into one of the two supported portal
 * currencies ('USD' | 'PKR'). Legacy 'AED' records or empty strings default to 'USD'.
 */
export function normalizeCurrency(currency: string | null | undefined): SupportedCurrency {
  const upper = (currency ?? '').trim().toUpperCase();
  if (upper === 'PKR') return 'PKR';
  return 'USD';
}

/**
 * Converts a numeric amount between USD and PKR (treating legacy AED as USD).
 */
export function convertCurrencyAmount(
  amount: number,
  fromCurrency: string | null | undefined,
  toCurrency: SupportedCurrency,
  rate: number = USD_TO_PKR_RATE,
): number {
  if (!Number.isFinite(amount)) return 0;
  const from = normalizeCurrency(fromCurrency);
  if (from === toCurrency) return amount;
  if (from === 'USD' && toCurrency === 'PKR') {
    return amount * rate;
  }
  if (from === 'PKR' && toCurrency === 'USD') {
    return amount / rate;
  }
  return amount;
}

/**
 * Formats an amount in the normalized currency (or converts to `targetCurrency` if provided).
 */
export function formatCurrencyAmount(
  amount: string | number | null | undefined,
  fromCurrency: string | null | undefined = DEFAULT_CURRENCY,
  targetCurrency?: SupportedCurrency,
): string {
  if (amount === null || amount === undefined || amount === '') return '—';
  const n = Number(amount);
  if (!Number.isFinite(n)) return '—';
  const from = normalizeCurrency(fromCurrency);
  const to = targetCurrency ?? from;
  const converted = convertCurrencyAmount(n, from, to);
  return `${to} ${converted.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

