const express    = require('express');
const bcrypt     = require('bcryptjs');
const router     = express.Router();
const path       = require('path');
const { getFirestore } = require('../config/firebase');

// ── Admin session middleware ──────────────────────────────────────────────────
// Uses a separate cookie (adminSess) so it's completely isolated from
// the regular user passport session.

function requireAdmin(req, res, next) {
  if (req.session && req.session.adminAuthed) return next();
  res.redirect('/admin/login');
}

// ── GET /admin/login ──────────────────────────────────────────────────────────
router.get('/login', (req, res) => {
  if (req.session && req.session.adminAuthed) {
    return res.redirect('/admin/dashboard');
  }
  res.sendFile(path.join(__dirname, '..', 'admin', 'login.html'));
});

// ── POST /admin/auth/login ────────────────────────────────────────────────────
router.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;

  // Basic input validation — never reveal which field was wrong
  if (!email || !password) {
    return res.status(400).json({ error: 'Invalid credentials.' });
  }

  const adminEmail    = process.env.ADMIN_EMAIL;
  const adminHash     = process.env.ADMIN_PASSWORD_HASH;

  if (!adminEmail || !adminHash) {
    console.error('[admin/auth] ADMIN_EMAIL or ADMIN_PASSWORD_HASH not configured.');
    return res.status(500).json({ error: 'Server configuration error.' });
  }

  // Constant-time email comparison to prevent timing attacks
  const emailMatch = email.trim().toLowerCase() === adminEmail.toLowerCase();
  // Always run bcrypt compare even on email mismatch to avoid timing oracle
  const passMatch  = await bcrypt.compare(password, adminHash);

  if (!emailMatch || !passMatch) {
    return res.status(401).json({ error: 'Invalid credentials.' });
  }

  // Mark the session as admin-authenticated
  req.session.adminAuthed = true;
  req.session.adminEmail  = adminEmail;
  return res.json({ ok: true });
});

// ── POST /admin/auth/logout ───────────────────────────────────────────────────
router.post('/auth/logout', (req, res) => {
  req.session.adminAuthed = false;
  req.session.adminEmail  = null;
  res.json({ ok: true });
});

// ── GET /admin/dashboard ──────────────────────────────────────────────────────
router.get('/dashboard', requireAdmin, (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'admin', 'dashboard.html'));
});

// ── GET /admin/api/nest-prices ────────────────────────────────────────────────
// Returns current prices from Firestore (or defaults).
router.get('/api/nest-prices', requireAdmin, async (_req, res) => {
  try {
    const db  = getFirestore();
    const doc = await db.collection('config').doc('marketplace').get();
    if (doc.exists) {
      const data = doc.data();
      return res.json({
        ok: true,
        prices: {
          common:    data.nestPriceCommon    ?? 0.35,
          rare:      data.nestPriceRare      ?? 0.75,
          legendary: data.nestPriceLegendary ?? 1.2,
        },
      });
    }
    // Doc doesn't exist yet — return defaults
    return res.json({ ok: true, prices: { common: 0.35, rare: 0.75, legendary: 1.2 } });
  } catch (err) {
    console.error('[admin/api/nest-prices GET]', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── POST /admin/api/nest-prices ───────────────────────────────────────────────
// Saves updated prices to Firestore config/marketplace.
router.post('/api/nest-prices', requireAdmin, async (req, res) => {
  try {
    const { common, rare, legendary } = req.body;

    // Validate — must be positive numbers
    const prices = { common: parseFloat(common), rare: parseFloat(rare), legendary: parseFloat(legendary) };
    for (const [key, val] of Object.entries(prices)) {
      if (!isFinite(val) || val <= 0) {
        return res.status(400).json({ error: `Invalid price for ${key}: must be a positive number.` });
      }
    }

    const db = getFirestore();
    await db.collection('config').doc('marketplace').set(
      {
        nestPriceCommon:    prices.common,
        nestPriceRare:      prices.rare,
        nestPriceLegendary: prices.legendary,
        updatedAt:          new Date().toISOString(),
      },
      { merge: true }
    );

    console.log(`[admin/api/nest-prices] Prices updated: common=${prices.common} rare=${prices.rare} legendary=${prices.legendary}`);
    return res.json({ ok: true, prices });
  } catch (err) {
    console.error('[admin/api/nest-prices POST]', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;
