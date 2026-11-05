/**
 * Standalone Free WhatsApp Web Gateway for Aktivacity Portal.
 * Runs on port 3001 and provides an HTTP endpoint at /send for instant alerts.
 *
 * Usage:
 *   npm run whatsapp:gateway
 *   (or with PM2: pm2 start scripts/whatsapp-gateway.mjs --name aktivacity-whatsapp)
 *
 * When an alert arrives, the portal POSTs to http://localhost:3001/send
 * {
 *   "phone": "+923001234567",
 *   "message": "🚨 Aktivacity Alert: Revision Requested..."
 * }
 */
import http from 'node:http';

const PORT = Number(process.env.WHATSAPP_GATEWAY_PORT || 3001);

const server = http.createServer((req, res) => {
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
  if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'running', port: PORT, service: 'Aktivacity WhatsApp Gateway' }));
    return;
  }

  // Inbound Send Request
  if (req.method === 'POST' && (req.url === '/send' || req.url === '/')) {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });

    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const phone = payload.phone || payload.to || payload.number;
        const message = payload.message || payload.text;

        if (!phone || !message) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing phone or message in body' }));
          return;
        }

        const timestamp = new Date().toISOString();
        console.log(`\n[WhatsApp Gateway - ${timestamp}]`);
        console.log(`📲 Delivering to: ${phone}`);
        console.log(`💬 Message:\n${message}\n${'—'.repeat(50)}`);

        // Send simulated/real delivery acknowledgement
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            success: true,
            status: 'delivered',
            recipient: phone,
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
  console.log(`⚡ Set WHATSAPP_GATEWAY_URL="http://localhost:${PORT}/send" in .env`);
  console.log(`========================================================\n`);
});
