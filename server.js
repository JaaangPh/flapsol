require('dotenv').config();

const express  = require('express');
const session  = require('express-session');
const passport = require('passport');
const path     = require('path');
const helmet   = require('helmet');
const cors     = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

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

// ── Session ───────────────────────────────────────────────────────────────────
// secure: true when deployed (HTTPS), false for local dev
const isProd = process.env.NODE_ENV === 'production';

app.use(session({
  secret:            process.env.SESSION_SECRET,
  resave:            false,
  saveUninitialized: false,
  cookie: {
    secure:   isProd,   // HTTPS only in production
    httpOnly: true,
    maxAge:   7 * 24 * 60 * 60 * 1000,
    sameSite: isProd ? 'none' : 'lax', // 'none' needed for cross-site OAuth on Vercel
  },
}));

// Trust Vercel's proxy so secure cookies work
if (isProd) app.set('trust proxy', 1);

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

// ── Start (local dev only – Vercel ignores this) ──────────────────────────────
if (!isProd) {
  app.listen(PORT, () => {
    console.log(`\n✅  SolClash running → http://localhost:${PORT}\n`);
  });
}

module.exports = app;
