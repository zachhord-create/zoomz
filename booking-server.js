#!/usr/bin/env node
'use strict';

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const PORT        = process.env.PORT || 8080;
const ROOT        = __dirname;
const BOOKINGS    = path.join(ROOT, 'bookings');
const INCOMING    = path.join(BOOKINGS, 'incoming');

// Ensure runtime directories exist
fs.mkdirSync(INCOMING, { recursive: true });
const LOG_FILE    = path.join(BOOKINGS, 'log.json');
const DISCORD     = process.env.DISCORD_WEBHOOK_URL || '';
const VIDEOS_FILE      = path.join(ROOT, 'agent', 'videos.json');
const YT_CHANNEL_ID    = 'UCKyp36k1yVghuUisFzcgacQ'; // The ZOOMZ
const VIDEO_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
};

/* ── helpers ── */

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res, status, body) {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch (e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function readLog() {
  try {
    const raw = fs.readFileSync(LOG_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return [];
  }
}

function writeLog(entries) {
  fs.writeFileSync(LOG_FILE, JSON.stringify(entries, null, 2));
}

/* ── Discord webhook ── */

function sendDiscord(booking) {
  if (!DISCORD) return;
  const url = new URL(DISCORD);
  const payload = JSON.stringify({
    embeds: [{
      title: '🎸 NEW BOOKING REQUEST',
      color: 0xFF1B8D,
      fields: [
        { name: 'Name',       value: booking.name,         inline: true },
        { name: 'Date',       value: booking.date,         inline: true },
        { name: 'Venue',      value: booking.venue,        inline: true },
        { name: 'Event Type', value: booking.event_type,   inline: true },
        { name: 'Attendance', value: booking.attendance || '—', inline: true },
        { name: 'Phone',      value: booking.phone || '—', inline: true },
        { name: 'Email',      value: booking.email,        inline: false },
        { name: 'Message',    value: booking.message || '(none)', inline: false },
      ],
      footer: { text: 'React ✅ to confirm · ❌ to decline' },
      timestamp: new Date().toISOString(),
    }]
  });

  const opts = {
    hostname: url.hostname,
    path: url.pathname + url.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
  };

  const mod = url.protocol === 'https:' ? require('https') : http;
  const req = mod.request(opts, res => {
    console.log(`[discord] webhook status ${res.statusCode}`);
  });
  req.on('error', e => console.error('[discord] webhook error:', e.message));
  req.write(payload);
  req.end();
}

/* ── YouTube video feed ── */

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

function parseRSS(xml) {
  const videos = [];
  const entries = xml.match(/<entry>([\s\S]*?)<\/entry>/g) || [];
  for (const entry of entries) {
    const idMatch    = entry.match(/<yt:videoId>(.*?)<\/yt:videoId>/);
    const titleMatch = entry.match(/<title>(.*?)<\/title>/);
    const pubMatch   = entry.match(/<published>(.*?)<\/published>/);
    const linkMatch  = entry.match(/<link rel="alternate" href="([^"]+)"/);
    if (idMatch) {
      const url = linkMatch ? linkMatch[1] : `https://www.youtube.com/watch?v=${idMatch[1]}`;
      videos.push({
        id:        idMatch[1],
        title:     titleMatch ? titleMatch[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : '',
        published: pubMatch ? pubMatch[1] : '',
        thumbnail: `https://img.youtube.com/vi/${idMatch[1]}/maxresdefault.jpg`,
        url,
      });
    }
  }
  return videos;
}

async function refreshVideos() {
  // Check cache age
  try {
    const cached = JSON.parse(fs.readFileSync(VIDEOS_FILE, 'utf8'));
    const age = Date.now() - (cached.fetchedAt || 0);
    if (age < VIDEO_CACHE_TTL_MS && cached.videos && cached.videos.length) {
      return cached.videos;
    }
  } catch (_) {}

  const channelId = YT_CHANNEL_ID;

  try {
    const res = await httpsGet(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);
    if (res.status !== 200) throw new Error(`RSS status ${res.status}`);
    // Filter out Shorts (their links contain /shorts/)
    const videos = parseRSS(res.body).filter(v => !v.url.includes('/shorts/'));
    fs.writeFileSync(VIDEOS_FILE, JSON.stringify({ channelId, fetchedAt: Date.now(), videos }, null, 2));
    console.log(`[youtube] refreshed ${videos.length} videos`);
    return videos;
  } catch (e) {
    console.error('[youtube] RSS fetch failed:', e.message);
    return readCachedVideos();
  }
}

function readCachedVideos() {
  try {
    const cached = JSON.parse(fs.readFileSync(VIDEOS_FILE, 'utf8'));
    return cached.videos || [];
  } catch (_) {
    return [];
  }
}

function handleVideos(req, res) {
  refreshVideos().then(videos => {
    json(res, 200, { ok: true, videos });
  }).catch(err => {
    json(res, 500, { ok: false, error: err.message });
  });
}

/* ── POST /api/book ── */

function handleBook(req, res) {
  readBody(req).then(body => {
    const required = ['name', 'email', 'date', 'venue', 'event_type'];
    const missing = required.filter(f => !body[f] || !String(body[f]).trim());
    if (missing.length) {
      return json(res, 400, { ok: false, error: `Missing required fields: ${missing.join(', ')}` });
    }

    const id = crypto.randomUUID();
    const booking = {
      id,
      status: 'pending',
      created_at: new Date().toISOString(),
      name:       String(body.name).trim(),
      email:      String(body.email).trim(),
      phone:      String(body.phone || '').trim(),
      date:       String(body.date).trim(),
      venue:      String(body.venue).trim(),
      event_type: String(body.event_type).trim(),
      attendance: String(body.attendance || '').trim(),
      message:    String(body.message || '').trim(),
    };

    // Write individual booking file
    const file = path.join(INCOMING, `booking-${id}.json`);
    fs.writeFileSync(file, JSON.stringify(booking, null, 2));

    // Append to log
    const log = readLog();
    log.push({ id, name: booking.name, date: booking.date, venue: booking.venue, created_at: booking.created_at, status: 'pending' });
    writeLog(log);

    // Fire Discord webhook (non-blocking)
    sendDiscord(booking);

    console.log(`[booking] new request from ${booking.name} for ${booking.date} @ ${booking.venue} (${id})`);
    json(res, 200, { ok: true, id });
  }).catch(err => {
    json(res, 400, { ok: false, error: err.message });
  });
}

/* ── Static file server ── */

function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.join(ROOT, urlPath);

  // Security: prevent path traversal
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
    cors(res);
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      cors(res);
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    const ext  = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    cors(res);
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
}

/* ── Server ── */

const server = http.createServer((req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/api/book') {
    handleBook(req, res);
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/videos')) {
    handleVideos(req, res);
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`\n⚡  ZOOMZ booking server running at http://localhost:${PORT}`);
  console.log(`📁  Bookings dir : ${BOOKINGS}`);
  console.log(`🔔  Discord webhook: ${DISCORD ? 'configured ✓' : 'not set (set DISCORD_WEBHOOK_URL to enable)'}\n`);
});

/* ── Graceful shutdown ── */

function shutdown(signal) {
  console.log(`\n[server] received ${signal}, shutting down gracefully…`);
  server.close(() => {
    console.log('[server] closed.');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
