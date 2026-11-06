'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';

export type SupportedTheme = 'dark' | 'light';
export const DEFAULT_THEME: SupportedTheme = 'dark';

const STORAGE_KEY = 'aktivacity_display_theme';
const COOKIE_KEY = 'aktivacity_theme';
const EVENT_NAME = 'aktivacity:theme-change';

function getStoredTheme(): SupportedTheme {
  if (typeof window === 'undefined') return DEFAULT_THEME;
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === 'dark' || saved === 'light') return saved;
    // Check cookie fallback
    const match = document.cookie.match(new RegExp(`(?:^|; )${COOKIE_KEY}=([^;]*)`));
    if (match && (match[1] === 'dark' || match[1] === 'light')) {
      return match[1] as SupportedTheme;
    }
  } catch {
    // ignore storage errors
  }
  return DEFAULT_THEME;
}

export function setDisplayTheme(next: SupportedTheme): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
    document.cookie = `${COOKIE_KEY}=${next}; path=/; max-age=31536000; SameSite=Lax`;

    const root = document.documentElement;
    if (next === 'light') {
      root.classList.remove('dark');
      root.classList.add('light');
      root.setAttribute('data-theme', 'light');
    } else {
      root.classList.remove('light');
      root.classList.add('dark');
      root.setAttribute('data-theme', 'dark');
    }
  } catch {
    // ignore storage errors
  }
  window.dispatchEvent(new CustomEvent<SupportedTheme>(EVENT_NAME, { detail: next }));
}

function subscribeTheme(callback: () => void): () => void {
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
 * Reactive hook returning current portal theme ('dark' | 'light', default 'dark')
 * and setter / toggle functions.
 */
export function useTheme(): {
  theme: SupportedTheme;
  isDark: boolean;
  isLight: boolean;
  setTheme: (t: SupportedTheme) => void;
  toggleTheme: () => void;
} {
  const current = useSyncExternalStore(
    subscribeTheme,
    getStoredTheme,
    () => DEFAULT_THEME,
  );

  const setTheme = (next: SupportedTheme) => setDisplayTheme(next);
  const toggleTheme = () => setDisplayTheme(current === 'dark' ? 'light' : 'dark');

  return {
    theme: current,
    isDark: current === 'dark',
    isLight: current === 'light',
    setTheme,
    toggleTheme,
  };
}

/**
 * Component ensuring document element class and data-theme match saved preference on mount.
 */
export function ThemeDomSynchronizer() {
  useEffect(() => {
    const saved = getStoredTheme();
    setDisplayTheme(saved);
  }, []);

  return null;
}

/**
 * Modern tactile sliding dual-pill toggle for Dark / Light theme.
 * Matches the layout, scale and feel of the Currency Swipe Toggle ($ USD / ₨ PKR).
 */
export function ThemeToggle({ className = '' }: { className?: string }) {
  const { theme, isDark, isLight, setTheme, toggleTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    // Static SSR placeholder matching exact dimensions
    return (
      <div className={`inline-flex items-center ${className}`}>
        <div className="relative inline-flex h-7 w-[104px] items-center rounded-lg border border-border bg-background p-0.5 shadow-2xs">
          <span className="w-full text-center text-[11px] font-bold text-muted">Theme</span>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`inline-flex items-center select-none ${className}`}
      title={`Current: ${theme === 'dark' ? 'Dark' : 'Light'} mode (Click to toggle)`}
    >
      <div
        role="group"
        aria-label="Theme toggle (Dark or Light)"
        onClick={toggleTheme}
        className="relative inline-flex h-7 w-[104px] cursor-pointer select-none items-center rounded-lg border border-border bg-background p-0.5 shadow-2xs transition-colors hover:border-accent/50"
      >
        {/* Sliding active thumb */}
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute top-0.5 bottom-0.5 w-[48px] rounded-md bg-accent shadow-xs transition-transform duration-200 ease-out ${
            isLight ? 'translate-x-[48px]' : 'translate-x-0'
          }`}
        />

        {/* Dark Button */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setTheme('dark');
          }}
          aria-pressed={isDark}
          className={`relative z-10 flex flex-1 items-center justify-center gap-1 rounded-md py-0.5 text-[11px] font-semibold tracking-wide transition-colors ${
            isDark ? 'text-white' : 'text-muted hover:text-foreground'
          }`}
        >
          <svg viewBox="0 0 20 20" fill="currentColor" className="h-3 w-3 shrink-0" aria-hidden="true">
            <path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z" />
          </svg>
          <span>Dark</span>
        </button>

        {/* Light Button */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setTheme('light');
          }}
          aria-pressed={isLight}
          className={`relative z-10 flex flex-1 items-center justify-center gap-1 rounded-md py-0.5 text-[11px] font-semibold tracking-wide transition-colors ${
            isLight ? 'text-white' : 'text-muted hover:text-foreground'
          }`}
        >
          <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5 shrink-0" aria-hidden="true">
            <path
              fillRule="evenodd"
              d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z"
              clipRule="evenodd"
            />
          </svg>
          <span>Light</span>
        </button>
      </div>
    </div>
  );
}
