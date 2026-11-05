import { requireActor } from '@/lib/auth/dal';
import { AccessDenied } from '@/components/access-denied';
import { AppShell } from '@/components/app-shell';
import { can } from '@/lib/authz';
import {
  getExecutiveContactsManagement,
  getEligibleManagementUsers,
  getExecutiveRecipients,
} from '@/lib/whatsapp/executive-alerts';
import { WhatsAppTestButton } from './test-button';
import { ContactCard, AddRecipientForm } from './contact-card';

export default async function AdminWhatsAppPage() {
  const actor = await requireActor();
  if (actor.role !== 'ceo' && actor.role !== 'coo') {
    return (
      <AppShell actor={actor}>
        <AccessDenied what="executive WhatsApp alerts" />
      </AppShell>
    );
  }

  const [recipients, contacts, availableUsers] = await Promise.all([
    getExecutiveRecipients(),
    getExecutiveContactsManagement(),
    getEligibleManagementUsers(),
  ]);

  const gatewayUrl = process.env.WHATSAPP_GATEWAY_URL?.trim() || 'http://localhost:3001/send';

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
      title: 'New Client Deal & Intake',
      desc: 'Dispatches when Sales files a new project awaiting Project Manager review in the Project Closure Report (PCR).',
      badge: 'Active Trigger',
      icon: '🌟',
    },
    {
      title: 'Client Revisions',
      desc: 'Dispatches immediately when a client files a revision round or requests changes on deliverables.',
      badge: 'Active Trigger',
      icon: '🔄',
    },
    {
      title: 'QA Review Decisions',
      desc: 'Dispatches when a Team Lead or PM Approves, Requests Changes, or Rejects a deliverable file.',
      badge: 'Active Trigger',
      icon: '🛡️',
    },
    {
      title: 'Work Allocations & Assignments',
      desc: 'Dispatches when a Team Lead assigns project deliverables to production executives.',
      badge: 'Active Trigger',
      icon: '📋',
    },
    {
      title: 'Critical Deadlines & Overdue',
      desc: 'Dispatches when any project or assignment comes within 24 hours of deadline or becomes overdue.',
      badge: 'Active Trigger',
      icon: '⏰',
    },
  ];

  // Filter available users to those not already in contacts
  const existingUserIds = new Set(contacts.map((c) => c.userId));
  const candidateUsers = availableUsers.filter((u) => !existingUserIds.has(u.id));

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
            Self-service WhatsApp notification manager for CEO, COO, and senior leadership.
          </p>
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        {/* Left Column: Configuration & Status (2 cols) */}
        <div className="space-y-6 lg:col-span-2">
          {/* Executive Contacts Management Card */}
          <div className="overflow-hidden rounded-xl border border-border/80 bg-surface/90 shadow-xs backdrop-blur-xs">
            <div className="border-b border-border/70 bg-background/35 px-5 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-foreground">Executive Alert Contacts</h2>
                <p className="text-xs text-muted">
                  CEO and COO can update their phone numbers or toggle notifications directly below.
                </p>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-muted">
                <span className="font-semibold text-foreground">{recipients.length}</span> active recipient(s)
              </div>
            </div>

            <div className="p-5 space-y-4">
              {contacts.map((contact) => (
                <ContactCard key={contact.userId} contact={contact} />
              ))}

              {candidateUsers.length > 0 && (
                <AddRecipientForm availableUsers={candidateUsers} />
              )}

              <div className="pt-2">
                <WhatsAppTestButton />
              </div>
            </div>
          </div>

          {/* 5 Monitored Triggers List */}
          <div className="overflow-hidden rounded-xl border border-border/80 bg-surface/90 shadow-xs backdrop-blur-xs">
            <div className="border-b border-border/70 bg-background/35 px-5 py-4">
              <h2 className="text-sm font-semibold text-foreground">5 Automated Executive Triggers</h2>
              <p className="text-xs text-muted">
                Each operational event dispatches a context-rich message specifying who acted, what changed, and direct portal links.
              </p>
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
            <h2 className="text-sm font-semibold text-foreground">How WhatsApp Dispatch Works</h2>
            <div className="mt-3 space-y-3 text-xs text-muted leading-relaxed">
              <p>
                <strong className="text-foreground">1. Self-Service Updates:</strong> CEO and COO do not need to edit server files. Enter your number above, click <em>Save Number</em>, and notifications immediately switch to your phone.
              </p>
              <p>
                <strong className="text-foreground">2. Zero Scan for Receivers:</strong> CEO and COO receive regular incoming WhatsApp chats directly from the company sender bot.
              </p>
              <p>
                <strong className="text-foreground">3. Free Company Sender Bot:</strong> Run the Baileys gateway service on your company server and link any office SIM:
              </p>
              <pre className="overflow-x-auto rounded-lg border border-border/70 bg-background/90 p-2.5 font-mono text-[11px] text-foreground">
{`npm run whatsapp:gateway`}
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
