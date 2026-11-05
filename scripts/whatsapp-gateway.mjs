/**
 * Standalone Free WhatsApp Web Gateway for Aktivacity Portal.
 * Uses Baileys (@whiskeysockets/baileys) to connect directly to WhatsApp Web.
 *
 * Runs an HTTP server on port 3001 responding to:
 * - GET  /status -> Connection status (connected / awaiting_qr)
 * - POST /send   -> Dispatches real WhatsApp message to target phone number
 *
 * Setup:
 * 1. Start gateway: `npm run whatsapp:gateway`
 * 2. Scan QR code printed in terminal using WhatsApp > Linked Devices > Link a Device
 * 3. All portal alerts flow directly to CEO & COO on their WhatsApp!
 */

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.WHATSAPP_GATEWAY_PORT || 3001);
const SESSION_DIR = path.resolve(__dirname, '../.data/whatsapp_session');

let sock = null;
let isConnected = false;
let currentQr = null;

async function startWhatsApp() {
  try {
    const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = await import(
      '@whiskeysockets/baileys'
    );
    const { default: pino } = await import('pino');
    const { default: qrcode } = await import('qrcode-terminal');

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQr = qr;
        console.log('\n' + '='.repeat(66));
        console.log('📲 SCAN THIS QR CODE WITH WHATSAPP TO LINK SENDER DEVICE');
        console.log('1. Open WhatsApp on your phone (Company SIM / Sender phone)');
        console.log('2. Tap Settings (or 3 dots) > Linked Devices > Link a Device');
        console.log('3. Point your camera at this QR code:');
        console.log('='.repeat(66) + '\n');
        qrcode.generate(qr, { small: true });
        console.log('\n' + '='.repeat(66));
      }

      if (connection === 'close') {
        isConnected = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log(
          `\n⚠️ WhatsApp connection closed (${statusCode || 'unknown'}). Reconnecting: ${shouldReconnect}`,
        );
        if (shouldReconnect) {
          setTimeout(startWhatsApp, 3000);
        } else {
          console.log('❌ Logged out. Delete .data/whatsapp_session and restart to scan again.');
        }
      } else if (connection === 'open') {
        isConnected = true;
        currentQr = null;
        console.log('\n' + '='.repeat(66));
        console.log('🟢 WhatsApp Sender Connected Successfully!');
        console.log('⚡ Ready to send real WhatsApp alerts to CEO & COO numbers.');
        console.log('='.repeat(66) + '\n');
      }
    });
  } catch (err) {
    console.warn('\nℹ️ Running in Terminal Log Mode (Baileys initialization note:', err.message, ')');
  }
}

// Start WhatsApp connection
startWhatsApp();

// HTTP Server for Portal Alerts
const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Health / Status check
  if (req.method === 'GET' && (req.url === '/status' || req.url === '/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: isConnected ? 'connected' : 'waiting_for_qr_scan',
        connected: isConnected,
        hasQr: Boolean(currentQr),
        port: PORT,
        service: 'Aktivacity WhatsApp Gateway',
      }),
    );
    return;
  }

  // Inbound Send Request
  if (req.method === 'POST' && (req.url === '/send' || req.url === '/')) {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });

    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const phone = payload.phone || payload.to || payload.number;
        const message = payload.message || payload.text;

        if (!phone || !message) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing phone or message in body' }));
          return;
        }

        const cleanDigits = phone.replace(/[^\d]/g, '');
        const jid = `${cleanDigits}@s.whatsapp.net`;
        const timestamp = new Date().toISOString();

        console.log(`\n[WhatsApp Gateway - ${timestamp}]`);
        console.log(`📲 Delivering to: ${phone} (${jid})`);
        console.log(`💬 Message:\n${message}\n${'—'.repeat(50)}`);

        let sentViaWhatsApp = false;
        let deliverError = null;

        if (isConnected && sock) {
          try {
            await sock.sendMessage(jid, { text: message });
            sentViaWhatsApp = true;
            console.log(`✅ Successfully delivered to ${phone} via WhatsApp Web!`);
          } catch (sendErr) {
            deliverError = sendErr.message;
            console.error(`⚠️ Failed to deliver to ${phone}:`, sendErr.message);
          }
        } else {
          console.log(`ℹ️ [Session Standby] QR not scanned yet. Logged to server terminal.`);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            success: true,
            status: sentViaWhatsApp ? 'delivered' : 'logged_standby',
            recipient: phone,
            connected: isConnected,
            error: deliverError,
            timestamp,
          }),
        );
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Endpoint not found. Use POST /send' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n========================================================`);
  console.log(`🟢 Aktivacity Free WhatsApp Gateway Running on port ${PORT}`);
  console.log(`📡 Webhook URL: http://localhost:${PORT}/send`);
  console.log(`========================================================\n`);
});
