'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { LeaderboardEntry, SalesLeaderboard as Board } from '@/lib/leaderboard/sales';

/**
 * Real-time Sales Leaderboard.
 *
 * - Polls /api/leaderboard/sales; the server already strips every figure the
 *   viewer may not see, so the blurred "AED ••••••" is decoration, not the
 *   protection.
 * - When the order changes, cards glide to their new place (FLIP with the
 *   Web Animations API — no animation library, the portal builds offline).
 * - A rep who climbs gets a snackbar; when it is the viewer, confetti too.
 */

const POLL_MS = 5000;
const TOAST_MS = 4500;

interface Toast {
  id: number;
  kind: 'climb' | 'you';
  text: string;
  sub: string;
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('');
}

function money(amount: string | null, currency: string) {
  if (amount === null) return null;
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  return `${currency} ${n.toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

const MEDAL = ['🥇', '🥈', '🥉'];

function cardTone(rank: number, total: number) {
  if (rank === 1) {
    return 'border-amber-400/60 bg-linear-to-r from-amber-400/15 via-amber-300/5 to-transparent shadow-[0_0_28px_-8px_rgba(251,191,36,0.55)]';
  }
  if (rank === 2) return 'border-slate-300/50 bg-linear-to-r from-slate-300/12 via-slate-200/5 to-transparent';
  if (rank === 3) return 'border-orange-400/45 bg-linear-to-r from-orange-500/12 via-orange-400/5 to-transparent';
  if (isDanger(rank, total)) return 'border-rose-500/40 bg-rose-500/[0.06]';
  return 'border-border bg-surface';
}

/** The last two places, never the podium. */
function isDanger(rank: number, total: number) {
  return total >= 4 && rank > 3 && rank > total - 2;
}

function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/** A small DOM confetti burst from an element; removes itself. */
function confettiFrom(el: HTMLElement | null) {
  if (!el || prefersReducedMotion()) return;
  const rect = el.getBoundingClientRect();
  const layer = document.createElement('div');
  layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:60;overflow:hidden';
  document.body.appendChild(layer);
  const colors = ['#fbbf24', '#34d399', '#60a5fa', '#f472b6', '#a78bfa', '#f87171'];
  const originX = rect.left + rect.width * 0.25;
  const originY = rect.top + rect.height / 2;
  const pieces = 70;
  let done = 0;
  for (let i = 0; i < pieces; i++) {
    const p = document.createElement('span');
    const size = 5 + Math.random() * 6;
    p.style.cssText = `position:absolute;left:${originX}px;top:${originY}px;width:${size}px;height:${size * 0.45}px;background:${colors[i % colors.length]};border-radius:1px`;
    layer.appendChild(p);
    const angle = Math.random() * Math.PI * 2;
    const dist = 90 + Math.random() * 220;
    const dx = Math.cos(angle) * dist;
    const dy = Math.sin(angle) * dist - 120;
    const anim = p.animate([
      { transform: 'translate(0,0) rotate(0deg)', opacity: 1 },
      { transform: `translate(${dx}px, ${dy}px) rotate(${Math.random() * 720}deg)`, opacity: 1, offset: 0.6 },
      { transform: `translate(${dx * 1.1}px, ${dy + 260}px) rotate(${Math.random() * 1080}deg)`, opacity: 0 },
    ], { duration: 1400 + Math.random() * 700, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' });
    anim.onfinish = () => {
      done += 1;
      if (done === pieces) layer.remove();
    };
  }
}

/* ------------------------------------------------------------ demo mode -- */

const DEMO_NAMES = ['Hamza Tariq', 'Bilal Ahmed', 'Sana Mirza', 'Omar Haddad', 'Ayesha Khan'];

function demoBoard(
  you: { id: number; name: string },
  revenue: Map<number, number>,
  deals: Map<number, number>,
  names: Map<number, string>,
  seesAll: boolean,
  currency: string,
  periodLabel: string,
): Board {
  const ids = [...revenue.keys()].sort((a, b) =>
    (revenue.get(b)! - revenue.get(a)!) || (deals.get(b)! - deals.get(a)!) || names.get(a)!.localeCompare(names.get(b)!));
  return {
    periodLabel,
    currency,
    seesAllRevenue: seesAll,
    entries: ids.map((id, i) => ({
      userId: id,
      fullName: names.get(id)!,
      rank: i + 1,
      deals: deals.get(id)!,
      revenue: seesAll || id === you.id ? String(revenue.get(id)) : null,
      isYou: id === you.id,
    })),
  };
}

/* ------------------------------------------------------------ component -- */

export function SalesLeaderboard({
  initial,
  viewerId,
  viewerName,
  allowDemo,
}: {
  initial: Board;
  viewerId: number;
  viewerName: string;
  allowDemo: boolean;
}) {
  const [board, setBoard] = useState<Board>(initial);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [demo, setDemo] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  const prevRanks = useRef<Map<number, number> | null>(null);
  const itemEls = useRef(new Map<number, HTMLElement>());
  const lastTops = useRef(new Map<number, number>());
  const toastSeq = useRef(0);
  const demoRef = useRef(false);
  const demoState = useRef<{
    revenue: Map<number, number>; deals: Map<number, number>; names: Map<number, string>;
  } | null>(null);

  const pushToast = useCallback((t: Omit<Toast, 'id'>) => {
    toastSeq.current += 1;
    const id = toastSeq.current;
    setToasts((prev) => [{ ...t, id }, ...prev].slice(0, 4));
    setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), TOAST_MS);
  }, []);

  /** Takes a fresh board, announces whoever climbed, and shows it. */
  const applyBoard = useCallback((next: Board) => {
    const prev = prevRanks.current ?? new Map(initial.entries.map((e) => [e.userId, e.rank]));
    for (const e of next.entries) {
      const before = prev.get(e.userId);
      if (before === undefined || e.rank >= before) continue;
      const jump = before - e.rank;
      const spots = `${jump} spot${jump === 1 ? '' : 's'}`;
      if (e.isYou) {
        pushToast({
          kind: 'you',
          text: `🚀 You climbed ${spots} to Rank #${e.rank}!`,
          sub: 'Level up — great selling, keep the momentum going.',
        });
        // After the cards have moved, burst from the viewer's own card.
        setTimeout(() => confettiFrom(itemEls.current.get(e.userId) ?? null), 450);
      } else {
        pushToast({
          kind: 'climb',
          text: `🚀 ${e.fullName} climbed ${spots} to Rank #${e.rank}!`,
          sub: 'Level up — doing great sales.',
        });
      }
    }
    prevRanks.current = new Map(next.entries.map((e) => [e.userId, e.rank]));
    setBoard(next);
    setLastUpdated(new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  }, [initial.entries, pushToast]);

  // Live polling (paused while the demo runs or the tab is hidden).
  useEffect(() => {
    let active = true;
    const tick = async () => {
      if (demoRef.current || document.visibilityState !== 'visible') return;
      try {
        const res = await fetch('/api/leaderboard/sales', { cache: 'no-store' });
        if (!res.ok || !active || demoRef.current) return;
        applyBoard((await res.json()) as Board);
      } catch {
        // a missed poll is retried on the next tick
      }
    };
    const id = setInterval(tick, POLL_MS);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [applyBoard]);

  // FLIP: after each render, slide every card from where it was to where it is.
  const order = board.entries.map((e) => e.userId).join(',');
  useLayoutEffect(() => {
    const reduce = prefersReducedMotion();
    for (const [id, el] of itemEls.current) {
      const top = el.offsetTop;
      const before = lastTops.current.get(id);
      if (!reduce && before !== undefined && before !== top && typeof el.animate === 'function') {
        const delta = before - top;
        const climbing = delta > 0;
        el.animate([
          { transform: `translateY(${delta}px) scale(${climbing ? 1.03 : 0.98})`, zIndex: climbing ? 2 : 1 },
          { transform: 'translateY(0) scale(1)', zIndex: climbing ? 2 : 1 },
        ], { duration: 750, easing: 'cubic-bezier(0.34, 1.4, 0.64, 1)' });
        if (climbing) {
          el.animate([
            { boxShadow: '0 0 0 2px rgba(52, 211, 153, 0.7), 0 0 28px rgba(52, 211, 153, 0.45)' },
            { boxShadow: '0 0 0 0 rgba(52, 211, 153, 0)' },
          ], { duration: 1600, easing: 'ease-out' });
        }
      }
      lastTops.current.set(id, top);
    }
  }, [order]);

  /* -------------------------------------------------------------- demo -- */

  const startDemo = () => {
    const revenue = new Map<number, number>();
    const deals = new Map<number, number>();
    const names = new Map<number, string>();
    // The viewer (a Sales rep) takes part; management watches six demo reps.
    const meInBoard = board.entries.some((e) => e.userId === viewerId);
    if (meInBoard) {
      revenue.set(viewerId, 18000);
      deals.set(viewerId, 3);
      names.set(viewerId, viewerName);
    }
    DEMO_NAMES.forEach((n, i) => {
      const id = -1 - i;
      revenue.set(id, 42000 - i * 7000);
      deals.set(id, 7 - i);
      names.set(id, n);
    });
    demoState.current = { revenue, deals, names };
    demoRef.current = true;
    prevRanks.current = null;
    setDemo(true);
    const next = demoBoard({ id: viewerId, name: viewerName }, revenue, deals, names, board.seesAllRevenue, board.currency, board.periodLabel);
    prevRanks.current = new Map(next.entries.map((e) => [e.userId, e.rank]));
    setBoard(next);
  };

  const demoDeal = useCallback((userId: number, amount: number) => {
    const s = demoState.current;
    if (!s) return;
    s.revenue.set(userId, (s.revenue.get(userId) ?? 0) + amount);
    s.deals.set(userId, (s.deals.get(userId) ?? 0) + 1);
    applyBoard(demoBoard({ id: viewerId, name: viewerName }, s.revenue, s.deals, s.names, board.seesAllRevenue, board.currency, board.periodLabel));
  }, [applyBoard, board.currency, board.periodLabel, board.seesAllRevenue, viewerId, viewerName]);

  // While the demo runs, a random rep closes a deal every few seconds.
  useEffect(() => {
    if (!demo) return;
    const id = setInterval(() => {
      const s = demoState.current;
      if (!s) return;
      const ids = [...s.revenue.keys()];
      // Lower ranks close more often, so places actually change.
      const sorted = ids.sort((a, b) => s.revenue.get(a)! - s.revenue.get(b)!);
      const pick = sorted[Math.floor(Math.pow(Math.random(), 1.8) * sorted.length)];
      demoDeal(pick, 4000 + Math.round(Math.random() * 12) * 1000);
    }, 2600);
    return () => clearInterval(id);
  }, [demo, demoDeal]);

  const stopDemo = async () => {
    demoRef.current = false;
    demoState.current = null;
    setDemo(false);
    prevRanks.current = null;
    lastTops.current.clear();
    try {
      const res = await fetch('/api/leaderboard/sales', { cache: 'no-store' });
      if (res.ok) {
        const next = (await res.json()) as Board;
        prevRanks.current = new Map(next.entries.map((e) => [e.userId, e.rank]));
        setBoard(next);
        return;
      }
    } catch {
      // fall back to the page's own snapshot
    }
    prevRanks.current = new Map(initial.entries.map((e) => [e.userId, e.rank]));
    setBoard(initial);
  };

  /* ------------------------------------------------------------ render -- */

  const total = board.entries.length;
  const leaderRevenue = board.seesAllRevenue && board.entries[0]?.revenue ? Number(board.entries[0].revenue) : 0;
  const you = board.entries.find((e) => e.isYou);

  return (
    <section className="mt-8">
      <div className="overflow-hidden rounded-2xl border border-border bg-surface">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-linear-to-r from-accent/10 via-transparent to-transparent px-5 py-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold tracking-tight">🏆 Sales Leaderboard</h2>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/35 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
                </span>
                {demo ? 'Demo' : 'Live'}
              </span>
              <span className="rounded-full border border-border bg-background px-2 py-0.5 text-[11px] font-medium text-muted">
                {board.periodLabel}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted">
              Ranked by value of projects filed this month.
              {board.seesAllRevenue ? ' You see every rep’s figure.' : ' Only your own figure is shown; others stay private.'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {you ? (
              <span className="rounded-lg border border-accent/35 bg-accent/10 px-2.5 py-1 text-xs font-semibold text-accent">
                You are #{you.rank} of {total}
              </span>
            ) : null}
            {allowDemo ? (
              demo ? (
                <button type="button" onClick={stopDemo}
                  className="rounded-lg border border-border bg-background px-2.5 py-1 text-xs font-medium text-muted hover:text-foreground">
                  Stop demo
                </button>
              ) : (
                <button type="button" onClick={startDemo}
                  className="rounded-lg border border-border bg-background px-2.5 py-1 text-xs font-medium text-muted hover:border-accent/40 hover:text-accent"
                  title="Development only: simulates deals with demo reps. Nothing is saved.">
                  ▶ Preview animation
                </button>
              )
            ) : null}
          </div>
        </div>

        {/* List */}
        {total === 0 ? (
          <p className="px-5 py-8 text-sm text-muted">No active Sales reps yet.</p>
        ) : (
          <ol className="relative space-y-2.5 p-4">
            {board.entries.map((e) => (
              <Row
                key={e.userId}
                entry={e}
                total={total}
                currency={board.currency}
                share={leaderRevenue > 0 && e.revenue !== null ? Number(e.revenue) / leaderRevenue : null}
                demo={demo}
                onTestDeal={() => demoDeal(e.userId, 5000)}
                refFn={(el) => {
                  if (el) itemEls.current.set(e.userId, el);
                  else itemEls.current.delete(e.userId);
                }}
              />
            ))}
          </ol>
        )}

        <div className="flex items-center justify-between border-t border-border px-5 py-2 text-[11px] text-muted">
          <span>Updates every {POLL_MS / 1000}s{lastUpdated ? ` · last ${lastUpdated}` : ''}</span>
          <span>🥇 🥈 🥉 Podium · <span className="text-rose-500">⚠ Catch up zone</span></span>
        </div>
      </div>

      {/* Level-up snackbars */}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 top-24 z-50 flex flex-col items-center gap-2 px-4">
        {toasts.map((t) => (
          <div key={t.id} role="status"
            className={`lb-toast pointer-events-auto w-full max-w-md rounded-xl border px-4 py-3 shadow-2xl backdrop-blur-md ${
              t.kind === 'you'
                ? 'border-amber-400/60 bg-linear-to-r from-amber-500/25 via-surface/95 to-surface/95'
                : 'border-emerald-500/45 bg-linear-to-r from-emerald-500/20 via-surface/95 to-surface/95'
            }`}>
            <p className="text-sm font-semibold text-foreground">{t.text}</p>
            <p className="mt-0.5 text-xs text-muted">{t.sub}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function Row({
  entry: e, total, currency, share, demo, onTestDeal, refFn,
}: {
  entry: LeaderboardEntry;
  total: number;
  currency: string;
  share: number | null;
  demo: boolean;
  onTestDeal: () => void;
  refFn: (el: HTMLLIElement | null) => void;
}) {
  const danger = isDanger(e.rank, total);
  const shown = money(e.revenue, currency);
  return (
    <li ref={refFn}
      className={`relative flex items-center gap-3 rounded-xl border px-4 py-3 will-change-transform ${cardTone(e.rank, total)} ${
        e.isYou ? 'ring-2 ring-accent/50' : ''}`}>
      {/* Rank */}
      <div className="flex w-10 shrink-0 flex-col items-center">
        {e.rank <= 3 ? (
          <span className={`text-2xl leading-none ${e.rank === 1 ? 'drop-shadow-[0_0_8px_rgba(251,191,36,0.7)]' : ''}`}>{MEDAL[e.rank - 1]}</span>
        ) : (
          <span className={`text-lg font-bold tabular-nums ${danger ? 'text-rose-500' : 'text-muted'}`}>#{e.rank}</span>
        )}
      </div>

      {/* Avatar */}
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-bold ${
        e.rank === 1 ? 'bg-amber-400/25 text-amber-600 dark:text-amber-300'
          : e.rank === 2 ? 'bg-slate-300/25 text-slate-600 dark:text-slate-200'
          : e.rank === 3 ? 'bg-orange-400/25 text-orange-600 dark:text-orange-300'
          : danger ? 'bg-rose-500/15 text-rose-600 dark:text-rose-400'
          : 'bg-accent/15 text-accent'}`}>
        {initials(e.fullName)}
      </span>

      {/* Name + badges */}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="truncate text-sm font-semibold text-foreground">{e.fullName}</span>
          {e.isYou ? (
            <span className="rounded-md bg-accent px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">You</span>
          ) : null}
          {e.rank === 1 ? (
            <span className="rounded-md border border-amber-400/50 bg-amber-400/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-300">Top seller</span>
          ) : null}
          {danger ? (
            <span className="rounded-md border border-rose-500/40 bg-rose-500/12 px-1.5 py-0.5 text-[10px] font-semibold text-rose-600 dark:text-rose-400">⚠ Catch up</span>
          ) : null}
        </div>
        <div className="mt-0.5 text-xs text-muted">
          {e.deals} deal{e.deals === 1 ? '' : 's'} this month
          {danger ? <span className="text-rose-500/90"> · Low sales volume — time to push</span> : null}
        </div>
        {share !== null ? (
          <div className="mt-1.5 h-1 w-full max-w-xs overflow-hidden rounded-full bg-border">
            <div className={`h-full rounded-full transition-[width] duration-700 ${danger ? 'bg-rose-500' : e.rank === 1 ? 'bg-amber-400' : 'bg-accent'}`}
              style={{ width: `${Math.max(3, Math.round(share * 100))}%` }} />
          </div>
        ) : null}
      </div>

      {/* Revenue */}
      <div className="flex shrink-0 flex-col items-end gap-1">
        {shown ? (
          <span className={`text-sm font-bold tabular-nums ${e.isYou ? 'text-accent' : 'text-foreground'}`}>{shown}</span>
        ) : (
          <span className="select-none text-sm font-bold tabular-nums text-muted blur-[3px]" aria-label="Private" title="Private">
            {currency} ••••••
          </span>
        )}
        {demo && e.isYou ? (
          <button type="button" onClick={onTestDeal}
            className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-600 hover:bg-emerald-500/20 dark:text-emerald-400">
            + Test deal ({currency} 5,000)
          </button>
        ) : null}
      </div>
    </li>
  );
}

