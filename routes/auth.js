const express  = require('express');
const passport = require('passport');
const router   = express.Router();

// ── Google ────────────────────────────────────────────────────────────────────
router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
router.get('/google/callback',
  passport.authenticate('google', { failureRedirect: '/?error=google_failed' }),
  (_req, res) => res.redirect('/game')
);

// ── GitHub ────────────────────────────────────────────────────────────────────
router.get('/github', passport.authenticate('github', { scope: ['user:email'] }));
router.get('/github/callback',
  passport.authenticate('github', { failureRedirect: '/?error=github_failed' }),
  (_req, res) => res.redirect('/game')
);

// ── Discord ───────────────────────────────────────────────────────────────────
router.get('/discord', passport.authenticate('discord'));
router.get('/discord/callback',
  passport.authenticate('discord', { failureRedirect: '/?error=discord_failed' }),
  (_req, res) => res.redirect('/game')
);

// ── Logout ────────────────────────────────────────────────────────────────────
router.get('/logout', (req, res, next) => {
  req.logout(err => {
    if (err) return next(err);
    req.session.destroy(() => res.redirect('/'));
  });
});

// ── /auth/me ──────────────────────────────────────────────────────────────────
router.get('/me', (req, res) => {
  if (!req.isAuthenticated()) return res.json({ loggedIn: false });

  const { uid, name, email, avatar, selectedBird, highScore,
          clashBalance, rank, level, authProvider } = req.user;

  res.json({
    loggedIn:     true,
    uid,
    name,
    email,
    avatar,
    selectedBird: selectedBird || 'bird-1',
    highScore:    highScore    || 0,
    clashBalance: clashBalance || 0,
    rank:         rank         || 'Bronze',
    level:        level        || 0,
    authProvider: authProvider || 'unknown',
  });
});

module.exports = router;
