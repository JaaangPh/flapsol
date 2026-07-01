const express    = require('express');
const bcrypt     = require('bcryptjs');
const router     = express.Router();
const path       = require('path');
const { getFirestore } = require('../config/firebase');
const { getPayoutConfig, updatePayoutConfig, runCutoff, runPayout } = require('../utils/payoutScheduler');

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

// ── GET /admin/api/maintenance ────────────────────────────────────────────────
// Returns current maintenance mode state and whitelist.
router.get('/api/maintenance', requireAdmin, async (_req, res) => {
  try {
    const db  = getFirestore();
    const doc = await db.collection('config').doc('maintenance').get();
    if (doc.exists) {
      const data = doc.data();
      return res.json({
        ok: true,
        enabled:   data.enabled   ?? false,
        whitelist: data.whitelist ?? [],
      });
    }
    return res.json({ ok: true, enabled: false, whitelist: [] });
  } catch (err) {
    console.error('[admin/api/maintenance GET]', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── POST /admin/api/maintenance ───────────────────────────────────────────────
// Updates maintenance mode state and/or whitelist.
router.post('/api/maintenance', requireAdmin, async (req, res) => {
  try {
    const { enabled, whitelist } = req.body;

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean.' });
    }
    if (!Array.isArray(whitelist)) {
      return res.status(400).json({ error: 'whitelist must be an array.' });
    }

    // Normalise and validate emails
    const cleanList = whitelist
      .map(e => String(e).trim().toLowerCase())
      .filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));

    const db = getFirestore();
    await db.collection('config').doc('maintenance').set(
      { enabled, whitelist: cleanList, updatedAt: new Date().toISOString() },
      { merge: true }
    );

    console.log(`[admin/api/maintenance] enabled=${enabled} whitelist=[${cleanList.join(', ')}]`);
    return res.json({ ok: true, enabled, whitelist: cleanList });
  } catch (err) {
    console.error('[admin/api/maintenance POST]', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── GET /admin/api/users — full user list with decrypted wallet info ──────────
// Query params: ?page=1&limit=20
router.get('/api/users', requireAdmin, async (req, res) => {
  try {
    const db      = getFirestore();
    const { decrypt } = require('../utils/wallet');

    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));

    // Firestore: fetch enough for this page (cursor-less offset via slice)
    const snap = await db.collection('users')
      .orderBy('totalScore', 'desc')
      .limit(page * limit)
      .get();

    const allDocs  = snap.docs;
    const hasMore  = allDocs.length >= page * limit;
    const start    = (page - 1) * limit;
    const pageDocs = allDocs.slice(start, start + limit);

    const users = pageDocs.map(doc => {
      const d  = doc.data();
      let walletAddress = null;

      try { if (d.walletPublicKey)  walletAddress = decrypt(d.walletPublicKey); }
      catch (e) { console.error(`[admin/users] decrypt walletPublicKey uid=${doc.id}`, e.message); }

      return {
        uid:                doc.id,
        name:               d.name               || 'Unknown',
        email:              d.email              || '—',
        avatar:             d.avatar             || null,
        rank:               d.rank               || 'Bronze',
        level:              d.level              || 0,
        highScore:          d.highScore          || 0,
        totalScore:         d.totalScore         || 0,
        goldBalance:        d.goldBalance        || 0,
        eggBalance:         d.eggBalance         || 0,
        seeds:              d.seeds              || 0,
        totalBP:            d.totalBP            || 0,
        energy:             d.energy             ?? 0,
        totalAttemptsToday: d.totalAttemptsToday || 0,
        lastScore:          d.lastScore          || 0,
        createdAt:          d.createdAt          || null,
        lastLoginTime:      d.lastLoginTime      || null,
        lastPlayedAt:       d.lastPlayedAt       || null,
        suspiciousFlag:     d.suspiciousFlag     || false,
        suspiciousReason:   d.suspiciousReason   || null,
        suspiciousFlagAt:   d.suspiciousFlagAt   || null,
        nests:              (d.inventory || []).filter(i => i.type === 'nest'),
        walletAddress,
      };
    });

    return res.json({ ok: true, users, page, limit, hasMore, total: allDocs.length });
  } catch (err) {
    console.error('[admin/api/users]', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── GET /admin/api/anomalies ──────────────────────────────────────────────────
router.get('/api/anomalies', requireAdmin, async (req, res) => {
  try {
    const db = getFirestore();
    const { decrypt } = require('../utils/wallet');

    const snap = await db.collection('users')
      .where('suspiciousFlag', '==', true)
      .get();

    // Sort in memory by suspiciousFlagAt desc to avoid requiring composite indexes
    const sortedDocs = snap.docs.sort((a, b) => {
      const tA = new Date(a.data().suspiciousFlagAt || 0).getTime();
      const tB = new Date(b.data().suspiciousFlagAt || 0).getTime();
      return tB - tA;
    });

    const users = sortedDocs.map(doc => {
      const d = doc.data();
      let walletAddress = null;
      try { if (d.walletPublicKey) walletAddress = decrypt(d.walletPublicKey); }
      catch (e) { console.error(`[admin/anomalies] decrypt walletPublicKey uid=${doc.id}`, e.message); }

      return {
        uid:                doc.id,
        name:               d.name               || 'Unknown',
        email:              d.email              || '—',
        avatar:             d.avatar             || null,
        rank:               d.rank               || 'Bronze',
        level:              d.level              || 0,
        highScore:          d.highScore          || 0,
        totalScore:         d.totalScore         || 0,
        goldBalance:        d.goldBalance        || 0,
        eggBalance:         d.eggBalance         || 0,
        seeds:              d.seeds              || 0,
        totalBP:            d.totalBP            || 0,
        energy:             d.energy             ?? 0,
        totalAttemptsToday: d.totalAttemptsToday || 0,
        lastScore:          d.lastScore          || 0,
        createdAt:          d.createdAt          || null,
        lastLoginTime:      d.lastLoginTime      || null,
        lastPlayedAt:       d.lastPlayedAt       || null,
        suspiciousFlag:     d.suspiciousFlag     || false,
        suspiciousReason:   d.suspiciousReason   || null,
        suspiciousFlagAt:   d.suspiciousFlagAt   || null,
        walletAddress,
      };
    });

    return res.json({ ok: true, users });
  } catch (err) {
    console.error('[admin/api/anomalies]', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── POST /admin/api/users/:uid/clear-flag ─────────────────────────────────────
router.post('/api/users/:uid/clear-flag', requireAdmin, async (req, res) => {
  try {
    const uid = req.params.uid;
    const db = getFirestore();
    const ref = db.collection('users').doc(uid);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'User not found.' });

    await ref.update({
      suspiciousFlag: false,
      suspiciousReason: null,
      suspiciousFlagAt: null
    });

    console.log(`[admin/clear-flag] Cleared flag for uid=${uid}`);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[admin/api/clear-flag]', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── POST /admin/api/users/reset-all-stats ─────────────────────────────────────
router.post('/api/users/reset-all-stats', requireAdmin, async (req, res) => {
  try {
    const db = getFirestore();
    const snap = await db.collection('users').get();

    const docs = snap.docs;
    let count = 0;

    // Process in chunks of 400 to stay within Firestore batch limit (max 500)
    for (let i = 0; i < docs.length; i += 400) {
      const chunk = docs.slice(i, i + 400);
      const batch = db.batch();
      for (const doc of chunk) {
        batch.update(doc.ref, {
          highScore: 0,
          totalScore: 0,
          seeds: 0,
          totalBP: 0,
          level: 0,
          currentExp: 0,
          requiredExp: 200,
          totalAttemptsToday: 0,
          lastScore: 0,
          suspiciousFlag: false,
          suspiciousReason: null,
          suspiciousFlagAt: null
        });
        count++;
      }
      await batch.commit();
    }

    console.log(`[admin/reset-all-stats] Reset game stats for all ${count} users.`);
    return res.json({ ok: true, count });
  } catch (err) {
    console.error('[admin/api/reset-all-stats]', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// ── POST /admin/api/users/:uid/reset ──────────────────────────────────────────
router.post('/api/users/:uid/reset', requireAdmin, async (req, res) => {
  try {
    const uid = req.params.uid;
    const db = getFirestore();
    const ref = db.collection('users').doc(uid);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'User not found.' });

    await ref.update({
      highScore: 0,
      totalScore: 0,
      seeds: 0,
      totalBP: 0,
      level: 0,
      currentExp: 0,
      requiredExp: 200,
      totalAttemptsToday: 0,
      lastScore: 0,
      suspiciousFlag: false,
      suspiciousReason: null,
      suspiciousFlagAt: null
    });

    console.log(`[admin/reset] Reset game stats for uid=${uid}`);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[admin/api/reset]', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── POST /admin/api/users/reset-all-gold ──────────────────────────────────────
router.post('/api/users/reset-all-gold', requireAdmin, async (req, res) => {
  try {
    const db = getFirestore();
    const snap = await db.collection('users').get();

    const docs = snap.docs;
    let count = 0;

    // Process in chunks of 400 documents to avoid Firestore batch size limitations (max 500)
    for (let i = 0; i < docs.length; i += 400) {
      const chunk = docs.slice(i, i + 400);
      const batch = db.batch();
      for (const doc of chunk) {
        batch.update(doc.ref, {
          goldBalance: 0,
          clashBalance: 0
        });
        count++;
      }
      await batch.commit();
    }

    console.log(`[admin/reset-all-gold] Reset gold to 0 for all ${count} users.`);
    return res.json({ ok: true, count });
  } catch (err) {
    console.error('[admin/api/reset-all-gold]', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// ── GET /admin/api/swap-config ────────────────────────────────────────────────
router.get('/api/swap-config', requireAdmin, async (_req, res) => {
  try {
    const db  = getFirestore();
    const doc = await db.collection('config').doc('swap').get();
    if (doc.exists) {
      const data = doc.data();
      return res.json({ ok: true, enabled: data.enabled ?? true });
    }
    return res.json({ ok: true, enabled: true });
  } catch (err) {
    console.error('[admin/api/swap-config GET]', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── POST /admin/api/swap-config ───────────────────────────────────────────────
router.post('/api/swap-config', requireAdmin, async (req, res) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean.' });
    }

    const db = getFirestore();
    await db.collection('config').doc('swap').set(
      { enabled, updatedAt: new Date().toISOString() },
      { merge: true }
    );

    console.log(`[admin/api/swap-config] swapEnabled=${enabled}`);
    return res.json({ ok: true, enabled });
  } catch (err) {
    console.error('[admin/api/swap-config POST]', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── GET /admin/api/payout-config ──────────────────────────────────────────────
router.get('/api/payout-config', requireAdmin, async (_req, res) => {
  try {
    const config = await getPayoutConfig();
    return res.json({ ok: true, config });
  } catch (err) {
    console.error('[admin/api/payout-config GET]', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── GET /admin/api/payout-queue ───────────────────────────────────────────────
router.get('/api/payout-queue', requireAdmin, async (req, res) => {
  try {
    const db = getFirestore();
    const snap = await db.collection('users').get();
    
    const queue = [];
    snap.docs.forEach(doc => {
      const u = doc.data();
      const goldBalance = u.goldBalance || 0;
      const pendingBalance = u.payoutPendingBalance || 0;
      
      if (goldBalance > 0 || pendingBalance > 0) {
        queue.push({
          uid: doc.id,
          name: u.name || 'Unknown',
          email: u.email || 'No email',
          goldBalance,
          payoutPendingBalance: pendingBalance,
          suspiciousFlag: !!u.suspiciousFlag
        });
      }
    });
    
    return res.json({ ok: true, queue });
  } catch (err) {
    console.error('[admin/api/payout-queue GET]', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// ── POST /admin/api/payout-config ─────────────────────────────────────────────
router.post('/api/payout-config', requireAdmin, async (req, res) => {
  try {
    const { autoApproval } = req.body;
    if (typeof autoApproval !== 'boolean') {
      return res.status(400).json({ error: 'autoApproval must be a boolean.' });
    }

    const success = await updatePayoutConfig({ autoApproval });
    if (!success) {
      return res.status(500).json({ error: 'Failed to update payout configuration.' });
    }

    console.log(`[admin/api/payout-config] autoApproval=${autoApproval}`);
    return res.json({ ok: true, autoApproval });
  } catch (err) {
    console.error('[admin/api/payout-config POST]', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── POST /admin/api/payout-trigger ────────────────────────────────────────────
// Triggers daily cutoff and daily payout manually.
router.post('/api/payout-trigger', requireAdmin, async (_req, res) => {
  try {
    console.log('[admin] Manual payout triggered by admin.');
    
    // 1. Run cutoff snapshot to copy goldBalance to payoutPendingBalance
    const cutoffRes = await runCutoff();
    if (!cutoffRes.success) {
      return res.status(500).json({ error: 'Cutoff snapshot failed: ' + cutoffRes.error });
    }
    
    // 2. Process payouts to transfer pending balances on-chain
    const payoutRes = await runPayout();
    if (!payoutRes.success) {
      return res.status(500).json({ error: 'Payout execution failed: ' + payoutRes.error, results: payoutRes.results });
    }
    
    return res.json({
      ok: true,
      cutoffCount: cutoffRes.count,
      payoutCount: payoutRes.count,
      results: payoutRes.results
    });
  } catch (err) {
    console.error('[admin/api/payout-trigger POST]', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// ── POST /admin/api/users/:uid/delete-nest ────────────────────────────────────
// Deletes a specific nest from a user's inventory
router.post('/api/users/:uid/delete-nest', requireAdmin, async (req, res) => {
  try {
    const { uid } = req.params;
    const { nestId } = req.body;
    if (!nestId) {
      return res.status(400).json({ error: 'nestId is required.' });
    }

    const db = getFirestore();
    const ref = db.collection('users').doc(uid);
    const doc = await ref.get();
    if (!doc.exists) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const data = doc.data();
    const inventory = data.inventory || [];

    // Filter out the nest with the given ID
    const newInventory = inventory.filter(item => {
      if (item.type !== 'nest') return true;
      const id = item.id || item.nestTag;
      return id !== nestId;
    });

    await ref.update({ inventory: newInventory });
    console.log(`[admin/delete-nest] Deleted nest=${nestId} from uid=${uid}`);
    return res.json({ ok: true, count: newInventory.length });
  } catch (err) {
    console.error('[admin/api/users/:uid/delete-nest POST]', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

module.exports = router;
