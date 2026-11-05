import Link from 'next/link';
import { requireActor } from '@/lib/auth/dal';
import { AccessDenied } from '@/components/access-denied';
import { AppShell } from '@/components/app-shell';
import { can } from '@/lib/authz';
import { getExecutiveRecipients } from '@/lib/whatsapp/executive-alerts';
import { WhatsAppTestButton } from './test-button';

export default async function AdminWhatsAppPage() {
  const actor = await requireActor();
  if (!can(actor, 'users.manage')) {
    return (
      <AppShell actor={actor}>
        <AccessDenied what="WhatsApp alerts management" />
      </AppShell>
    );
  }

  const recipients = await getExecutiveRecipients();
  const gatewayUrl = process.env.WHATSAPP_GATEWAY_URL?.trim();
  const metaToken = process.env.WHATSAPP_TOKEN?.trim();

  let gatewayLiveStatus: 'connected' | 'awaiting_qr' | 'offline' = 'offline';
  if (gatewayUrl) {
    try {
      const statusEndpoint = gatewayUrl.replace(/\/?(send)?$/, '/status');
      const res = await fetch(statusEndpoint, { signal: AbortSignal.timeout(1000) });
      if (res.ok) {
        const json = (await res.json()) as { connected?: boolean };
        gatewayLiveStatus = json.connected ? 'connected' : 'awaiting_qr';
      }
    } catch {
      gatewayLiveStatus = 'offline';
    }
  }

  const MONITORED_TRIGGERS = [
    {
      title: 'Client Revisions',
      desc: 'Sent immediately when a client files a revision round or requests changes on deliverables.',
      badge: 'Active Trigger',
      icon: '🔄',
    },
    {
      title: 'QA Review Decisions',
      desc: 'Sent when a Team Lead or PM Approves, Requests Changes, or Rejects a deliverable file.',
      badge: 'Active Trigger',
      icon: '🛡️',
    },
    {
      title: 'Work Allocations & Assignments',
      desc: 'Sent when a Team Lead assigns project deliverables to production executives.',
      badge: 'Active Trigger',
      icon: '📋',
    },
    {
      title: 'Urgent Deadlines & Overdue',
      desc: 'Sent when any project or assignment comes within 24 hours of deadline or becomes overdue.',
      badge: 'Active Trigger',
      icon: '⏰',
    },
    {
      title: 'New Project Triage (Intake)',
      desc: 'Sent when Sales files a new project awaiting Project Manager triage in the PCR.',
      badge: 'Active Trigger',
      icon: '✨',
    },
  ];

  return (
    <AppShell actor={actor}>
      {/* Header */}
      <div className="flex flex-col gap-2 border-b border-border/70 pb-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">
              Executive WhatsApp Alerts
            </h1>
            <span className="rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-emerald-400">
              Live Triggers
            </span>
            {gatewayLiveStatus === 'connected' ? (
              <span className="rounded-full border border-emerald-500/30 bg-emerald-500/15 px-2.5 py-0.5 text-[11px] font-medium text-emerald-300">
                🟢 Sender Online (Connected)
              </span>
            ) : gatewayLiveStatus === 'awaiting_qr' ? (
              <span className="rounded-full border border-amber-500/30 bg-amber-500/15 px-2.5 py-0.5 text-[11px] font-medium text-amber-300">
                🟡 Gateway Waiting for QR Scan
              </span>
            ) : (
              <span className="rounded-full border border-border/80 bg-surface px-2.5 py-0.5 text-[11px] font-medium text-muted">
                ⚪ Gateway Offline (Run npm run whatsapp:gateway)
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-muted sm:text-sm">
            Automated real-time WhatsApp dispatch for CEO and COO on critical operational events.
          </p>
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        {/* Left Column: Configuration & Status (2 cols) */}
        <div className="space-y-6 lg:col-span-2">
          {/* Active Recipients Card */}
          <div className="overflow-hidden rounded-xl border border-border/80 bg-surface/90 shadow-xs backdrop-blur-xs">
            <div className="border-b border-border/70 bg-background/35 px-5 py-4">
              <h2 className="text-sm font-semibold text-foreground">Registered Executive Recipients</h2>
              <p className="text-xs text-muted">
                These phone numbers receive WhatsApp alerts on the 5 monitored events.
              </p>
            </div>

            <div className="p-5">
              {recipients.length === 0 ? (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-xs text-amber-400">
                  <span className="font-semibold">No CEO/COO phone numbers configured yet!</span>
                  <p className="mt-1">
                    Add <code className="rounded bg-background/80 px-1 py-0.2">WHATSAPP_CEO_PHONE</code> and{' '}
                    <code className="rounded bg-background/80 px-1 py-0.2">WHATSAPP_COO_PHONE</code> to your{' '}
                    <code className="rounded bg-background/80 px-1 py-0.2">.env</code> file (e.g. +923001234567), or set them under their User settings.
                  </p>
                </div>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  {recipients.map((r, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-3 rounded-lg border border-border/70 bg-background/40 p-3.5"
                    >
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/15 text-sm font-bold text-emerald-400">
                        {r.role.toUpperCase()}
                      </span>
                      <div>
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-semibold text-foreground">{r.name}</span>
                          <span className="rounded bg-accent/10 px-1.5 py-0.2 text-[10px] font-bold uppercase tracking-wider text-accent">
                            {r.role}
                          </span>
                        </div>
                        <div className="mt-0.5 font-mono text-xs text-muted">{r.phone}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <WhatsAppTestButton />
            </div>
          </div>

          {/* 5 Monitored Triggers List */}
          <div className="overflow-hidden rounded-xl border border-border/80 bg-surface/90 shadow-xs backdrop-blur-xs">
            <div className="border-b border-border/70 bg-background/35 px-5 py-4">
              <h2 className="text-sm font-semibold text-foreground">5 Automated Executive Triggers</h2>
              <p className="text-xs text-muted">Each action immediately prepares and dispatches an alert message.</p>
            </div>

            <div className="divide-y divide-border/60">
              {MONITORED_TRIGGERS.map((t, idx) => (
                <div key={idx} className="flex items-start gap-3.5 p-4 transition-colors hover:bg-background/30">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface border border-border/80 text-sm shadow-2xs">
                    {t.icon}
                  </span>
                  <div className="flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-foreground">{t.title}</span>
                      <span className="rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.2 text-[10px] font-semibold text-emerald-400">
                        {t.badge}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-muted">{t.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Right Column: Setup & Connection Guide */}
        <div className="space-y-6">
          <div className="rounded-xl border border-border/80 bg-surface/90 p-5 shadow-xs backdrop-blur-xs">
            <h2 className="text-sm font-semibold text-foreground">How WhatsApp Alerts Work</h2>
            <div className="mt-3 space-y-3 text-xs text-muted leading-relaxed">
              <p>
                <strong className="text-foreground">1. No Scan Needed for CEO/COO:</strong> The CEO and COO receive standard incoming messages directly on their personal WhatsApp numbers.
              </p>
              <p>
                <strong className="text-foreground">2. Free 100% WhatsApp Gateway:</strong> Run an open-source WhatsApp Web Gateway (Baileys / Evolution API) on the company server and scan once with the company office SIM.
              </p>
              <p>
                <strong className="text-foreground">3. Environment Variables in .env:</strong>
              </p>
              <pre className="overflow-x-auto rounded-lg border border-border/70 bg-background/90 p-2.5 font-mono text-[11px] text-foreground">
{`WHATSAPP_CEO_PHONE="+923001234567"
WHATSAPP_COO_PHONE="+923007654321"

# Free Webhook / Baileys Gateway (e.g. port 3001)
WHATSAPP_GATEWAY_URL="http://localhost:3001/send"
PORTAL_BASE_URL="http://localhost:3000"`}
              </pre>
            </div>
          </div>

          <div className="rounded-xl border border-border/80 bg-background/50 p-5 text-xs text-muted">
            <div className="flex items-center gap-2">
              <span
                className={`h-2.5 w-2.5 rounded-full ${
                  gatewayLiveStatus === 'connected'
                    ? 'bg-emerald-500'
                    : gatewayLiveStatus === 'awaiting_qr'
                      ? 'bg-amber-400 animate-pulse'
                      : 'bg-muted/50'
                }`}
              />
              <span className="font-semibold text-foreground">
                {gatewayLiveStatus === 'connected'
                  ? 'Gateway Connected & Ready'
                  : gatewayLiveStatus === 'awaiting_qr'
                    ? 'Scan QR in Terminal'
                    : 'Gateway Service Offline'}
              </span>
            </div>
            <p className="mt-2 leading-relaxed">
              {gatewayLiveStatus === 'connected'
                ? 'Your WhatsApp sender bot is active. Real WhatsApp messages will be delivered to CEO & COO phones.'
                : gatewayLiveStatus === 'awaiting_qr'
                  ? 'The gateway is running! Check the terminal where you ran "npm run whatsapp:gateway" and scan the QR code with WhatsApp.'
                  : 'Start the sender bot in your terminal by running: npm run whatsapp:gateway'}
            </p>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
