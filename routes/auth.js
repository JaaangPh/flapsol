const express    = require('express');
const passport   = require('passport');
const router     = express.Router();
const { decrypt }      = require('../utils/wallet');
const { getFirestore } = require('../config/firebase');
const crypto           = require('crypto');

// ── Google ────────────────────────────────────────────────────────────────────
router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
router.get('/google/callback',
  passport.authenticate('google', { failureRedirect: '/login?error=google_failed' }),
  (_req, res) => res.redirect('/dashboard')
);

// ── GitHub ────────────────────────────────────────────────────────────────────
router.get('/github', passport.authenticate('github', { scope: ['user:email'] }));
router.get('/github/callback',
  passport.authenticate('github', { failureRedirect: '/login?error=github_failed' }),
  (_req, res) => res.redirect('/dashboard')
);

// ── Discord ───────────────────────────────────────────────────────────────────
router.get('/discord', passport.authenticate('discord'));
router.get('/discord/callback',
  passport.authenticate('discord', { failureRedirect: '/login?error=discord_failed' }),
  (_req, res) => res.redirect('/dashboard')
);

// ── Logout ────────────────────────────────────────────────────────────────────
router.get('/logout', (req, res, next) => {
  req.logout(err => {
    if (err) return next(err);
    req.session = null;
    res.redirect('/login');
  });
});

// ── Cross-app SSO: redeem a one-time handoff token ────────────────────────────
//
// Flow:
//   1. The OTHER app calls POST /auth/issue-token (server-to-server)
//      passing the user's googleId (the user identifier used in the other app).
//   2. SolClash stores a 60s token in Firestore `sso-tokens`.
//   3. The other app redirects the browser to /auth/sso?token=xxx.
//   4. This endpoint redeems the token, finds the matching SolClash user
//      (by matching oauthProviders or email), logs them in, deletes the token.
//
// User matching priority:
//   1. Direct Firestore doc ID match (if same project & same doc IDs)
//   2. Match by googleId / discordId / githubId fields
//   3. Match by email

router.get('/sso', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.redirect('/login?error=sso_missing');

  try {
    const db  = getFirestore();
    const ref = db.collection('sso-tokens').doc(token);
    const snap = await ref.get();

    if (!snap.exists) return res.redirect('/login?error=sso_invalid');

    const { uid, email, expiresAt } = snap.data();

    // One-time use — delete immediately regardless of outcome
    await ref.delete();

    if (Date.now() > expiresAt) return res.redirect('/login?error=sso_expired');

    const usersRef = db.collection('users');
    let userDoc = null;

    // 1. Try direct doc ID (works if both apps share same Firestore doc IDs)
    if (uid) {
      const direct = await usersRef.doc(uid).get();
      if (direct.exists) userDoc = direct;
    }

    // 2. Try matching by googleId / discordId / githubId field
    if (!userDoc && uid) {
      for (const field of ['googleId', 'discordId', 'githubId', 'providerId']) {
        const q = await usersRef.where(field, '==', uid).limit(1).get();
        if (!q.empty) { userDoc = q.docs[0]; break; }
      }
    }

    // 3. Try matching by oauthProviders.*.id across all providers
    if (!userDoc && uid) {
      for (const provider of ['google', 'github', 'discord']) {
        const q = await usersRef
          .where(`oauthProviders.${provider}.id`, '==', uid)
          .limit(1).get();
        if (!q.empty) { userDoc = q.docs[0]; break; }
      }
    }

    // 4. Fall back to email match
    if (!userDoc && email) {
      const q = await usersRef.where('email', '==', email).limit(1).get();
      if (!q.empty) userDoc = q.docs[0];
    }

    if (!userDoc) return res.redirect('/login?error=sso_no_user');

    const docData = userDoc.data();

    // Backfill any SolClash-specific fields that may be missing for users
    // whose accounts were created by the other app (no highScore, selectedBird, etc.)
    const missing = {};
    if (docData.highScore      === undefined) missing.highScore      = 0;
    if (docData.selectedBird   === undefined) missing.selectedBird   = 'bird-1';
    if (docData.rank           === undefined) missing.rank           = 'Bronze';
    if (docData.badge          === undefined) missing.badge          = 'images/badges/bronze.png';
    if (docData.level          === undefined) missing.level          = 0;
    if (docData.currentExp     === undefined) missing.currentExp     = 0;
    if (docData.requiredExp    === undefined) missing.requiredExp    = 200;
    if (docData.totalBP        === undefined) missing.totalBP        = 0;
    if (docData.goldBalance    === undefined) {
      missing.goldBalance = docData.clashBalance !== undefined ? docData.clashBalance : 0;
    }
    if (docData.walletBalance  === undefined) missing.walletBalance  = 0;

    if (Object.keys(missing).length > 0) {
      await userDoc.ref.update(missing);
      Object.assign(docData, missing);
    }

    // Issue a new session token — invalidates any existing session on other devices
    const newSessionId = crypto.randomBytes(32).toString('hex');
    await userDoc.ref.update({ currentSessionId: newSessionId });

    const user = { uid: userDoc.id, ...docData, currentSessionId: newSessionId };

    await new Promise((resolve, reject) => {
      req.login(user, err => err ? reject(err) : resolve());
    });

    res.redirect('/dashboard');
  } catch (err) {
    console.error('[/auth/sso]', err);
    res.redirect('/login?error=sso_failed');
  }
});

// ── Cross-app SSO: issue a one-time handoff token ─────────────────────────────
//
// Called by the OTHER app's server (server-to-server) with a shared secret.
//
// Request body:
//   { "uid": "<user's googleId from other app>", "email": "<user email>", "secret": "..." }
//
// Both uid and email are stored so /auth/sso can find the user via multiple
// lookup strategies (doc ID → field match → email fallback).

router.post('/issue-token', async (req, res) => {
  // Only the companion app may call this — enforce strict origin check here
  const companionUrl = (process.env.COMPANION_APP_URL || '').replace(/\/$/, '');
  const origin = req.headers.origin || '';
  if (companionUrl && origin && origin !== companionUrl) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { uid, email, secret } = req.body;

  if ((!uid && !email) || secret !== process.env.CROSS_APP_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const db    = getFirestore();
    const token = crypto.randomBytes(32).toString('hex');
    const TTL   = 60 * 1000; // 60 seconds — one browser redirect only

    await db.collection('sso-tokens').doc(token).set({
      uid:       uid   || null,
      email:     email || null,
      createdAt: Date.now(),
      expiresAt: Date.now() + TTL,
    });

    const baseUrl = process.env.BASE_URL || 'http://localhost:3001';
    res.json({ token, url: `${baseUrl}/auth/sso?token=${token}` });
  } catch (err) {
    console.error('[/auth/issue-token]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── /auth/companion-config ────────────────────────────────────────────────────
// Returns the companion app's URL to the login page so it can attempt auto-SSO.
// Keeping it server-side means the URL lives in .env, not hardcoded in HTML.
router.get('/companion-config', (_req, res) => {
  res.json({ url: process.env.COMPANION_APP_URL || null });
});

// ── /auth/me ──────────────────────────────────────────────────────────────────
router.get('/me', async (req, res) => {
  if (!req.isAuthenticated()) return res.json({ loggedIn: false });

  const {
    uid, name, email, avatar, authProvider,
    selectedBird, highScore,
    goldBalance, clashBalance, walletBalance,
    rank, badge, level,
    currentExp, requiredExp,
    totalBP, walletPublicKey, seeds,
  } = req.user;

  // Decrypt wallet public key server-side — never expose private key
  let walletAddress = null;
  if (walletPublicKey) {
    try { walletAddress = decrypt(walletPublicKey); } catch {
      if (!walletPublicKey.includes(':')) walletAddress = walletPublicKey;
    }
  }

  const gold = goldBalance !== undefined ? goldBalance : (clashBalance !== undefined ? clashBalance : 0);

  // ── Ensure free nest + energy fields exist for older accounts ─────────────
  try {
    const db  = getFirestore();
    const ref = db.collection('users').doc(uid);
    const doc = await ref.get();
    if (doc.exists) {
      const data = doc.data();
      const backfill = {};

      // Grant free nest if inventory has none and no free nest exists
      const inv = data.inventory || [];
      const hasFreeNest = inv.some(i => i.rarity === 'free');
      if (!hasFreeNest) {
        const freeNestTag = `Free Nest#${String(Math.floor(1000 + Math.random() * 9000))}`;
        inv.push({
          id:          `nest_free_${Date.now()}`,
          type:        'nest',
          rarity:      'free',
          baseName:    'Free Nest',
          nestTag:     freeNestTag,
          priceSol:    0,
          paymentMethod: 'free',
          purchasedAt: new Date().toISOString(),
          image:       'images/nest/free.png',
        });
        backfill.inventory = inv;
      }

      // Seed energy fields if missing — start with full base slots (20)
      if (data.energy === undefined) backfill.energy = 20;
      if (data.lastEnergyTime === undefined) backfill.lastEnergyTime = new Date().toISOString();

      if (Object.keys(backfill).length > 0) {
        await ref.update(backfill);
        Object.assign(req.user, backfill);
      }
    }
  } catch (e) {
    console.error('[/auth/me backfill]', e);
  }

  res.json({
    loggedIn:      true,
    uid,
    name,
    email,
    avatar,
    authProvider:  authProvider  || 'unknown',
    selectedBird:  selectedBird  || 'bird-1',
    highScore:     highScore     || 0,
    goldBalance:   gold,
    clashBalance:  gold,
    walletBalance: walletBalance || 0,
    rank:          rank          || 'Bronze',
    badge:         badge         || 'images/badges/bronze.png',
    level:         level         || 0,
    currentExp:    currentExp    || 0,
    requiredExp:   requiredExp   || 200,
    totalBP:       totalBP       || 0,
    seeds:         seeds         || 0,
    walletAddress,
    eggsHatched:   req.user.eggsHatched || 0,
    eggBalance:    req.user.eggBalance  || 0,
  });
});

// ── Mock login for testing ───────────────────────────────────────────────────
router.get('/mock', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).send('Forbidden in production');
  }
  const mockUser = {
    uid: 'mock-uid-12345',
    name: 'test.clash',
    email: 'test@clash.com',
    avatar: 'images/birds/bird-1/Bird.png',
    authProvider: 'google',
    selectedBird: 'bird-1',
    highScore: 21,
    goldBalance: 0,
    walletBalance: 0,
    rank: 'Bronze',
    badge: 'images/badges/bronze.png',
    level: 0,
    currentExp: 0,
    requiredExp: 200,
    totalBP: 0,
    walletPublicKey: 'CfGSy5ZvUoVL53kJyjao4yQzVBYsGnsFC9z1dcwbpwzB',
  };
  req.login(mockUser, (err) => {
    if (err) return res.status(500).send('Mock login failed');
    res.redirect('/dashboard');
  });
});

module.exports = router;
