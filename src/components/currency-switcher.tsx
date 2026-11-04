'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  DEFAULT_CURRENCY,
  USD_TO_PKR_RATE,
  convertCurrencyAmount,
  formatCurrencyAmount,
  normalizeCurrency,
  type SupportedCurrency,
} from '@/lib/currency';

const STORAGE_KEY = 'aktivacity_display_currency';
const COOKIE_KEY = 'aktivacity_currency';
const EVENT_NAME = 'aktivacity:currency-change';

function getStoredCurrency(): SupportedCurrency {
  if (typeof window === 'undefined') return DEFAULT_CURRENCY;
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === 'PKR' || saved === 'USD') return saved;
  } catch {
    // ignore storage errors
  }
  return DEFAULT_CURRENCY;
}

export function setDisplayCurrency(next: SupportedCurrency): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
    document.cookie = `${COOKIE_KEY}=${next}; path=/; max-age=31536000; SameSite=Lax`;
  } catch {
    // ignore storage errors
  }
  window.dispatchEvent(new CustomEvent<SupportedCurrency>(EVENT_NAME, { detail: next }));
}

function subscribeCurrency(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const onCustom = () => callback();
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) callback();
  };
  window.addEventListener(EVENT_NAME, onCustom);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(EVENT_NAME, onCustom);
    window.removeEventListener('storage', onStorage);
  };
}

/**
 * Reactive hook returning the user's currently selected display currency ('USD' | 'PKR', default 'USD')
 * and a setter / toggle function.
 */
export function useDisplayCurrency(): {
  currency: SupportedCurrency;
  setCurrency: (c: SupportedCurrency) => void;
  toggleCurrency: () => void;
} {
  const currency = useSyncExternalStore<SupportedCurrency>(
    subscribeCurrency,
    getStoredCurrency,
    () => DEFAULT_CURRENCY,
  );

  return {
    currency,
    setCurrency: setDisplayCurrency,
    toggleCurrency: () => setDisplayCurrency(currency === 'USD' ? 'PKR' : 'USD'),
  };
}

const MONEY_TOKEN_REGEX =
  /\b(USD|PKR|AED)\s+([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})|[0-9]+(?:\.[0-9]{2}))\b/g;
const MASKED_TOKEN_REGEX = /\b(USD|PKR|AED)\s+(••••••)/g;

const textNodeRecords = new WeakMap<
  Text,
  { sourceText: string; lastWrittenText: string }
>();

function transformMoneyString(text: string, targetCurrency: SupportedCurrency): string {
  let result = text.replace(MONEY_TOKEN_REGEX, (_match, rawCode: string, rawAmount: string) => {
    const numeric = Number(rawAmount.replace(/,/g, ''));
    if (!Number.isFinite(numeric)) return _match;
    const from = normalizeCurrency(rawCode);
    const converted = convertCurrencyAmount(numeric, from, targetCurrency);
    return `${targetCurrency} ${converted.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  });

  result = result.replace(MASKED_TOKEN_REGEX, (_match, _rawCode: string, mask: string) => {
    return `${targetCurrency} ${mask}`;
  });

  return result;
}

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'CODE', 'PRE']);

function syncSubtreeCurrency(root: Node, targetCurrency: SupportedCurrency): void {
  if (typeof document === 'undefined') return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      if (parent.closest('[data-no-currency-convert="true"]')) return NodeFilter.FILTER_REJECT;
      const val = node.nodeValue;
      if (!val || (!val.includes('USD') && !val.includes('PKR') && !val.includes('AED'))) {
        const existing = textNodeRecords.get(node as Text);
        if (!existing) return NodeFilter.FILTER_SKIP;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const nodes: Text[] = [];
  let current = walker.nextNode();
  while (current) {
    nodes.push(current as Text);
    current = walker.nextNode();
  }

  for (const textNode of nodes) {
    const currentVal = textNode.nodeValue ?? '';
    const existing = textNodeRecords.get(textNode);
    const sourceText =
      existing && currentVal === existing.lastWrittenText ? existing.sourceText : currentVal;

    const nextText = transformMoneyString(sourceText, targetCurrency);
    if (nextText !== sourceText || existing) {
      textNodeRecords.set(textNode, { sourceText, lastWrittenText: nextText });
      if (currentVal !== nextText) {
        textNode.nodeValue = nextText;
      }
    }
  }
}

/**
 * Synchronizes all displayed currency figures in the DOM whenever the user toggles USD <-> PKR
 * or navigates between pages.
 */
export function CurrencyDomSynchronizer() {
  const { currency } = useDisplayCurrency();

  useEffect(() => {
    if (typeof document === 'undefined' || !document.body) return;
    let isApplying = false;

    const apply = () => {
      if (isApplying) return;
      isApplying = true;
      try {
        syncSubtreeCurrency(document.body, currency);
      } finally {
        isApplying = false;
      }
    };

    apply();

    const observer = new MutationObserver(() => {
      if (isApplying) return;
      apply();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    return () => observer.disconnect();
  }, [currency]);

  return null;
}

/**
 * Interactive USD <-> PKR swipe/switch toggle pill for the top navigation bar and headers.
 */
export function CurrencySwipeToggle({ className = '' }: { className?: string }) {
  const { currency, setCurrency, toggleCurrency } = useDisplayCurrency();
  const isPkr = currency === 'PKR';

  return (
    <div
      data-no-currency-convert="true"
      className={`inline-flex items-center gap-1.5 ${className}`}
      title={`Switch display currency (1 USD = ${USD_TO_PKR_RATE} PKR)`}
    >
      <div
        role="group"
        aria-label="Payment currency toggle (USD or PKR)"
        onClick={toggleCurrency}
        className="relative inline-flex h-7 w-[108px] cursor-pointer select-none items-center rounded-lg border border-border bg-background p-0.5 shadow-2xs transition-colors hover:border-accent/50"
      >
        {/* Sliding active pill thumb */}
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute top-0.5 bottom-0.5 w-[50px] rounded-md bg-accent shadow-xs transition-transform duration-200 ease-out ${
            isPkr ? 'translate-x-[52px]' : 'translate-x-0'
          }`}
        />

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setCurrency('USD');
          }}
          aria-pressed={!isPkr}
          className={`relative z-10 flex flex-1 items-center justify-center gap-0.5 rounded-md py-0.5 text-[11px] font-bold tracking-wide transition-colors ${
            !isPkr ? 'text-white' : 'text-muted hover:text-foreground'
          }`}
        >
          <span>$</span>
          <span>USD</span>
        </button>

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setCurrency('PKR');
          }}
          aria-pressed={isPkr}
          className={`relative z-10 flex flex-1 items-center justify-center gap-0.5 rounded-md py-0.5 text-[11px] font-bold tracking-wide transition-colors ${
            isPkr ? 'text-white' : 'text-muted hover:text-foreground'
          }`}
        >
          <span>₨</span>
          <span>PKR</span>
        </button>
      </div>
    </div>
  );
}

/**
 * Reusable Price + Currency (USD / PKR) form field with an interactive swipe/convert toggle
 * that converts the typed numeric value between USD and PKR on the fly.
 */
export function PriceWithCurrencyField({
  amountName = 'priceAmount',
  currencyName = 'priceCurrency',
  amountId = 'priceAmount',
  label = 'Price',
  defaultAmount = '',
  defaultCurrency = 'USD',
  placeholder = '0.00',
  required = false,
  compact = false,
}: {
  amountName?: string;
  currencyName?: string;
  amountId?: string;
  label?: string;
  defaultAmount?: string | number | null;
  defaultCurrency?: string | null;
  placeholder?: string;
  required?: boolean;
  compact?: boolean;
}) {
  const initialCurr = normalizeCurrency(defaultCurrency);
  const [curr, setCurr] = useState<SupportedCurrency>(initialCurr);
  const [val, setVal] = useState<string>(
    defaultAmount !== null && defaultAmount !== undefined && defaultAmount !== ''
      ? String(defaultAmount)
      : '',
  );

  const numericVal = val.trim() === '' ? NaN : Number(val);
  const hasValidNumber = Number.isFinite(numericVal) && numericVal >= 0;
  const oppositeCurrency: SupportedCurrency = curr === 'USD' ? 'PKR' : 'USD';

  const handleSwipeConvert = (targetCurr: SupportedCurrency) => {
    if (targetCurr === curr) return;
    if (hasValidNumber && numericVal > 0) {
      const converted = convertCurrencyAmount(numericVal, curr, targetCurr);
      setVal(converted.toFixed(2));
    }
    setCurr(targetCurr);
  };

  return (
    <div data-no-currency-convert="true">
      <div className="flex items-center justify-between gap-2">
        <label
          className={`block font-medium ${compact ? 'text-xs text-muted' : 'text-sm'}`}
          htmlFor={amountId}
        >
          {label} ({curr})
        </label>
        <div
          role="group"
          aria-label="Payment currency type (USD or PKR)"
          className="inline-flex items-center rounded-md border border-border bg-background p-0.5 text-[11px]"
        >
          <button
            type="button"
            onClick={() => handleSwipeConvert('USD')}
            className={`rounded px-2 py-0.5 font-semibold transition-colors ${
              curr === 'USD' ? 'bg-accent text-white' : 'text-muted hover:text-foreground'
            }`}
          >
            $ USD
          </button>
          <button
            type="button"
            onClick={() => handleSwipeConvert('PKR')}
            className={`rounded px-2 py-0.5 font-semibold transition-colors ${
              curr === 'PKR' ? 'bg-accent text-white' : 'text-muted hover:text-foreground'
            }`}
          >
            ₨ PKR
          </button>
        </div>
      </div>

      <input type="hidden" name={currencyName} value={curr} />

      <div className="relative mt-1.5 flex items-center">
        <span className="pointer-events-none absolute left-3 select-none text-xs font-semibold text-muted">
          {curr}
        </span>
        <input
          id={amountId}
          name={amountName}
          type="number"
          step="0.01"
          min={0}
          required={required}
          value={val}
          onChange={(e) => setVal(e.target.value)}
          placeholder={placeholder}
          className={`w-full rounded-md border border-border bg-background pl-12 pr-3 ${
            compact ? 'py-1.5 text-sm' : 'py-2 text-sm'
          } tabular-nums outline-none focus:border-accent`}
        />
      </div>

      {hasValidNumber && numericVal > 0 ? (
        <p className="mt-1 flex items-center justify-between text-[11px] text-muted">
          <span>
            Equivalent:{' '}
            <strong className="font-medium text-foreground">
              {formatCurrencyAmount(numericVal, curr, oppositeCurrency)}
            </strong>
          </span>
          <button
            type="button"
            onClick={() => handleSwipeConvert(oppositeCurrency)}
            className="text-accent hover:underline"
          >
            ⇄ Convert to {oppositeCurrency}
          </button>
        </p>
      ) : null}
    </div>
  );
}

