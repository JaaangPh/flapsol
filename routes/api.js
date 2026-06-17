const express          = require('express');
const router           = express.Router();
const { getFirestore } = require('../config/firebase');

function requireAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

// ── POST /api/score ───────────────────────────────────────────────────────────
router.post('/score', requireAuth, async (req, res) => {
  try {
    const { score } = req.body;
    if (typeof score !== 'number' || score < 0 || !isFinite(score))
      return res.status(400).json({ error: 'Invalid score' });

    const db      = getFirestore();
    const ref     = db.collection('users').doc(req.user.uid);
    const doc     = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'User not found' });

    const data     = doc.data();
    const prevBest = data.highScore || 0;
    const newBest  = Math.max(score, prevBest);
    const updates  = {
      totalAttemptsToday: (data.totalAttemptsToday || 0) + 1,
      lastPlayedAt:       new Date().toISOString(),
    };
    if (score > prevBest) updates.highScore = score;

    await ref.update(updates);
    req.user.highScore          = newBest;
    req.user.totalAttemptsToday = updates.totalAttemptsToday;

    res.json({ ok: true, highScore: newBest });
  } catch (err) {
    console.error('[/api/score]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/bird ────────────────────────────────────────────────────────────
router.post('/bird', requireAuth, async (req, res) => {
  try {
    const { bird } = req.body;
    if (!['bird-1', 'bird-2', 'bird-3'].includes(bird))
      return res.status(400).json({ error: 'Invalid bird' });

    const db = getFirestore();
    await db.collection('users').doc(req.user.uid).update({ selectedBird: bird });
    req.user.selectedBird = bird;

    res.json({ ok: true, selectedBird: bird });
  } catch (err) {
    console.error('[/api/bird]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/leaderboard ──────────────────────────────────────────────────────
router.get('/leaderboard', async (_req, res) => {
  try {
    const db   = getFirestore();
    const snap = await db.collection('users')
      .orderBy('highScore', 'desc')
      .limit(10)
      .get();

    const board = snap.docs.map((d, i) => {
      const { name, avatar, highScore, rank, selectedBird } = d.data();
      return {
        rank:         i + 1,
        name:         name         || 'Player',
        avatar:       avatar       || null,
        highScore:    highScore    || 0,
        tier:         rank         || 'Bronze',
        selectedBird: selectedBird || 'bird-1',
      };
    });

    res.json(board);
  } catch (err) {
    console.error('[/api/leaderboard]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
