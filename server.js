require('dotenv').config();

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
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'"],
      styleSrc:   ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc:    ["'self'", 'https://fonts.gstatic.com'],
      imgSrc:     ["'self'", 'data:', 'https:', 'http:'],
      mediaSrc:   ["'self'"],
      connectSrc: ["'self'"],
    },
  },
}));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
app.use(express.static(path.join(__dirname, 'public')));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/auth', require('./routes/auth'));
app.use('/api',  require('./routes/api'));

// ── Pages ─────────────────────────────────────────────────────────────────────
app.get('/game', (req, res) => {
  if (!req.isAuthenticated()) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'game.html'));
});

app.get('/', (req, res) => {
  if (req.isAuthenticated()) return res.redirect('/game');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.use((_req, res) => res.redirect('/'));

// ── Start (local only – Vercel ignores app.listen) ────────────────────────────
if (!isProd) {
  app.listen(PORT, () => {
    console.log(`\n✅  SolClash running → http://localhost:${PORT}\n`);
  });
}

module.exports = app;
