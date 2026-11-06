import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, '..', 'dist');

// cPanel's Node.js Selector (Passenger) assigns the listen port via PORT;
// API_PORT / 3001 stay as the local-dev fallback (see vite.config.js proxy).
const PORT = process.env.PORT || process.env.API_PORT || 3001;
const DAILY_LIMIT = 10;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const STALE_LOCK_MS = 3 * 60 * 1000;
const MAX_STREAMS_PER_IP = 5;
const SWEEP_INTERVAL_MS = 60 * 1000;
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

const app = express();
app.disable('x-powered-by');

const ipState = new Map();
const subscribers = new Map();

function normalizeIp(req) {
  let ip;
  if (TRUST_PROXY) {
    const forwarded = req.get('x-forwarded-for');
    ip = forwarded ? forwarded.split(',')[0].trim() : req.socket.remoteAddress;
  } else {
    ip = req.socket.remoteAddress;
  }
  ip = ip || 'unknown';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1') ip = '127.0.0.1';
  return ip;
}

function getEntry(ip) {
  const now = Date.now();
  let entry = ipState.get(ip);
  if (!entry || now - entry.windowStart >= WINDOW_MS) {
    entry = { count: 0, windowStart: now, inFlight: false, inFlightSince: null };
    ipState.set(ip, entry);
  }
  if (entry.inFlight && entry.inFlightSince && now - entry.inFlightSince > STALE_LOCK_MS) {
    entry.inFlight = false;
    entry.inFlightSince = null;
  }
  return entry;
}

function publicState(ip, entry) {
  return {
    ip,
    limit: DAILY_LIMIT,
    used: entry.count,
    remaining: Math.max(0, DAILY_LIMIT - entry.count),
    inFlight: entry.inFlight,
    resetAt: entry.windowStart + WINDOW_MS
  };
}

function notify(ip) {
  const entry = getEntry(ip);
  const payload = `data: ${JSON.stringify(publicState(ip, entry))}\n\n`;
  const subs = subscribers.get(ip);
  if (subs) for (const res of subs) res.write(payload);
}

// Periodically releases locks abandoned by crashed/closed clients and evicts
// entries nobody is watching, so both maps stay bounded under long uptime.
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of ipState) {
    let changed = false;
    if (entry.inFlight && entry.inFlightSince && now - entry.inFlightSince > STALE_LOCK_MS) {
      entry.inFlight = false;
      entry.inFlightSince = null;
      changed = true;
    }
    if (changed) notify(ip);

    const hasSubscribers = subscribers.has(ip) && subscribers.get(ip).size > 0;
    const windowExpired = now - entry.windowStart >= WINDOW_MS;
    if (windowExpired && !entry.inFlight && !hasSubscribers) {
      ipState.delete(ip);
    }
  }
}, SWEEP_INTERVAL_MS).unref();

function sameOriginOnly(req, res, next) {
  const host = req.get('host');
  const origin = req.get('origin');
  const referer = req.get('referer');

  if (origin) {
    try {
      if (new URL(origin).host === host) return next();
    } catch {
      /* fall through to rejection */
    }
    return res.status(403).json({ allowed: false, reason: 'Cross-origin requests are not permitted for this endpoint.' });
  }

  if (referer) {
    try {
      if (new URL(referer).host === host) return next();
    } catch {
      /* fall through to rejection */
    }
    return res.status(403).json({ allowed: false, reason: 'Cross-origin requests are not permitted for this endpoint.' });
  }

  // Neither header present (e.g. a same-origin request a browser chose not to
  // label) -- allow, since a forged cross-site request from a browser always
  // carries one of these for a state-changing fetch/POST.
  next();
}

app.get('/api/status', (req, res) => {
  const ip = normalizeIp(req);
  res.json(publicState(ip, getEntry(ip)));
});

app.get('/api/stream', (req, res) => {
  const ip = normalizeIp(req);

  const existing = subscribers.get(ip);
  if (existing && existing.size >= MAX_STREAMS_PER_IP) {
    return res.status(429).json({ allowed: false, reason: 'Too many open connections for your IP.' });
  }

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.flushHeaders();

  if (!subscribers.has(ip)) subscribers.set(ip, new Set());
  subscribers.get(ip).add(res);
  res.write(`data: ${JSON.stringify(publicState(ip, getEntry(ip)))}\n\n`);

  const keepAlive = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(keepAlive);
    subscribers.get(ip)?.delete(res);
  });
});

app.post('/api/start', sameOriginOnly, (req, res) => {
  const ip = normalizeIp(req);
  const entry = getEntry(ip);

  if (entry.inFlight) {
    return res.status(429).json({
      allowed: false,
      reason: 'A watermark-removal job for your IP is already in progress. Only one at a time is allowed.',
      ...publicState(ip, entry)
    });
  }
  if (entry.count >= DAILY_LIMIT) {
    return res.status(429).json({
      allowed: false,
      reason: `Daily limit of ${DAILY_LIMIT} reached for your IP. Resets ${new Date(entry.windowStart + WINDOW_MS).toLocaleString()}.`,
      ...publicState(ip, entry)
    });
  }

  entry.count += 1;
  entry.inFlight = true;
  entry.inFlightSince = Date.now();
  notify(ip);
  res.json({ allowed: true, ...publicState(ip, entry) });
});

app.post('/api/finish', sameOriginOnly, (req, res) => {
  const ip = normalizeIp(req);
  const entry = getEntry(ip);
  entry.inFlight = false;
  entry.inFlightSince = null;
  notify(ip);
  res.json({ ok: true, ...publicState(ip, entry) });
});

app.use(express.static(DIST_DIR));
app.get(/^(?!\/api\/).*/, (req, res) => {
  res.sendFile(path.join(DIST_DIR, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`[api] gemini-watermark-remover listening on :${PORT} (serving ${DIST_DIR})`);
});
