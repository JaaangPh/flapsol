require('dotenv').config();

// Log any uncaught startup errors with full detail (helps diagnose Vercel crashes)
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err.message);
  console.error(err.stack);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
});

const express       = require('express');
const cookieSession = require('cookie-session');
const passport      = require('passport');
const path          = require('path');
const helmet        = require('helmet');
const cors          = require('cors');

const app    = express();
const PORT   = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

// ── Security ──────────────────────────────────────────────────────────────────
const COMPANION_URL = process.env.COMPANION_APP_URL || '';

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
      styleSrc:   ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc:    ["'self'", 'https://fonts.gstatic.com'],
      imgSrc:     ["'self'", 'data:', 'https:', 'http:'],
      mediaSrc:   ["'self'"],
      // Allow fetch() to the companion app for cross-app SSO
      connectSrc: ["'self'", ...(COMPANION_URL ? [COMPANION_URL] : [])],
    },
  },
}));

// ── CORS ──────────────────────────────────────────────────────────────────────
// SolClash's own pages make same-origin requests — no CORS needed for those.
// The only cross-origin caller is the companion app hitting /auth/issue-token.
// Apply a permissive policy globally (no credentials needed for most routes)
// and a strict credential-aware policy only on the SSO endpoint.
app.use(cors({ origin: true, credentials: false }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ limit: '2mb', extended: true }));

// Trust Vercel proxy for secure cookies
if (isProd) app.set('trust proxy', 1);

// ── Cookie-based session (works on Vercel – no MemoryStore) ───────────────────
app.use(cookieSession({
  name:    'solclash.sess',
  keys:    [process.env.SESSION_SECRET || 'fallback-dev-secret'],
  maxAge:  7 * 24 * 60 * 60 * 1000, // 7 days
  secure:  isProd,   // HTTPS only in production
  sameSite: isProd ? 'none' : 'lax',
  httpOnly: true,
}));

// Passport needs req.session.regenerate & req.session.save (not in cookie-session)
// Shim them so passport@0.6+ works
app.use((req, _res, next) => {
  if (req.session && !req.session.regenerate) {
    req.session.regenerate = (cb) => { cb(); };
  }
  if (req.session && !req.session.save) {
    req.session.save = (cb) => { cb(); };
  }
  next();
});

// ── Passport ──────────────────────────────────────────────────────────────────
app.use(passport.initialize());
app.use(passport.session());
require('./config/passport')(passport);

// ── Static files ──────────────────────────────────────────────────────────────
// index: false so that GET / falls through to the route handler below,
// which can redirect authenticated users to /dashboard instead of serving
// index.html directly (express.static bypasses session checks otherwise).
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
// Serve static assets from admin folder (CSS, images) — HTML is served via route
app.use('/admin', express.static(path.join(__dirname, 'admin'), { index: false }));

// ── Maintenance infrastructure ────────────────────────────────────────────────
const { getFirestore } = require('./config/firebase');

let _maintenanceCache  = null;   // { enabled, whitelist, fetchedAt }
const MAINTENANCE_TTL  = 15000;  // re-fetch at most every 15 s

async function getMaintenanceConfig() {
  const now = Date.now();
  if (_maintenanceCache && (now - _maintenanceCache.fetchedAt) < MAINTENANCE_TTL) {
    return _maintenanceCache;
  }
  try {
    const db  = getFirestore();
    const doc = await db.collection('config').doc('maintenance').get();
    const data = doc.exists ? doc.data() : {};
    _maintenanceCache = {
      enabled:   data.enabled   ?? false,
      whitelist: (data.whitelist ?? []).map(e => String(e).toLowerCase()),
      fetchedAt: now,
    };
  } catch {
    if (!_maintenanceCache) _maintenanceCache = { enabled: false, whitelist: [], fetchedAt: now };
    else _maintenanceCache.fetchedAt = now;
  }
  return _maintenanceCache;
}

// ── Maintenance page ──────────────────────────────────────────────────────────
// Only accessible when maintenance mode is ON. Otherwise redirect away.
app.get('/maintenance', async (req, res) => {
  const cfg = await getMaintenanceConfig();
  if (!cfg.enabled) {
    return req.isAuthenticated() ? res.redirect('/dashboard') : res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'public', 'maintenance.html'));
});

// ── Maintenance mode middleware ───────────────────────────────────────────────
// If enabled, blocks protected routes unless the user's email is whitelisted.

// Routes that are always accessible even during maintenance
const MAINTENANCE_BYPASS = ['/maintenance', '/auth/', '/admin', '/health', '/terms', '/privacy'];

async function maintenanceGuard(req, res, next) {
  if (MAINTENANCE_BYPASS.some(p => req.path === p || req.path.startsWith(p))) return next();

  const protectedPaths = ['/dashboard', '/inventory', '/farm', '/marketplace', '/playtoearn', '/freetoplay', '/game'];
  if (!protectedPaths.some(p => req.path === p || req.path.startsWith(p))) return next();

  const cfg = await getMaintenanceConfig();
  if (!cfg.enabled) return next();

  const userEmail = req.user && req.user.email ? req.user.email.toLowerCase() : null;
  if (userEmail && cfg.whitelist.includes(userEmail)) return next();

  return res.redirect('/maintenance');
}

app.use(maintenanceGuard);

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/auth',  require('./routes/auth'));
app.use('/api',   require('./routes/api'));
app.use('/admin', require('./routes/admin'));

// ── Pages ─────────────────────────────────────────────────────────────────────
app.get('/dashboard', (req, res) => {
  if (!req.isAuthenticated()) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/inventory', (req, res) => {
  if (!req.isAuthenticated()) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'inventory.html'));
});

app.get('/farm', (req, res) => {
  if (!req.isAuthenticated()) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'farm.html'));
});

app.get('/marketplace', (req, res) => {
  if (!req.isAuthenticated()) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'marketplace.html'));
});

app.get('/game', (req, res) => {
  if (!req.isAuthenticated()) return res.redirect('/');
  res.redirect('/playtoearn');
});

app.get('/playtoearn', (req, res) => {
  if (!req.isAuthenticated()) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'playtoearn.html'));
});

app.get('/freetoplay', (req, res) => {
  if (!req.isAuthenticated()) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'freetoplay.html'));
});

app.get('/', (req, res) => {
  if (req.isAuthenticated()) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/login', (req, res) => {
  if (req.isAuthenticated()) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/terms', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'terms.html'));
});

app.get('/privacy', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.use((_req, res) => res.redirect('/'));

// ── Start ─────────────────────────────────────────────────────────────────────
// Always listen — Vercel overrides this with its own handler via module.exports
app.listen(PORT, () => {
  console.log(`\n✅  SolClash running → http://localhost:${PORT}\n`);
});

module.exports = app;
