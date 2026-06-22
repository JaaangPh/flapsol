const GoogleStrategy   = require('passport-google-oauth20').Strategy;
const GitHubStrategy   = require('passport-github2').Strategy;
const DiscordStrategy  = require('passport-discord').Strategy;
const { getFirestore } = require('./firebase');
const { generateWallet } = require('../utils/wallet');

// ── Helpers ───────────────────────────────────────────────────────────────────
function randomReferralCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// ── Upsert user ───────────────────────────────────────────────────────────────
async function upsertUser(provider, profile) {
  const db         = getFirestore();
  const providerId = String(profile.id);
  const email      = profile.emails?.[0]?.value || null;
  const name       = profile.displayName || profile.username || profile.global_name || 'Player';
  const avatar     = profile.photos?.[0]?.value || null;
  const now        = new Date().toISOString();

  const usersRef = db.collection('users');

  // ── Returning user ─────────────────────────────────────────────────────────
  const snap = await usersRef
    .where(`oauthProviders.${provider}.id`, '==', providerId)
    .limit(1)
    .get();

  if (!snap.empty) {
    const doc = snap.docs[0];
    await doc.ref.update({
      lastLoginTime: now,
      [`oauthProviders.${provider}.lastSeen`]: now,
      [`oauthProviders.${provider}.avatar`]:   avatar,
      [`oauthProviders.${provider}.name`]:     name,
    });
    return { uid: doc.id, ...doc.data() };
  }

  // ── Brand-new user — create Solana wallet ──────────────────────────────────
  const wallet = generateWallet();

  // ── Free nest item for every new user ────────────────────────────────────────
  const freeNestTag  = `Free Nest#${String(Math.floor(1000 + Math.random() * 9000))}`;
  const freeNestItem = {
    id:          `nest_free_${Date.now()}`,
    type:        'nest',
    rarity:      'free',
    baseName:    'Free Nest',
    nestTag:     freeNestTag,
    priceSol:    0,
    paymentMethod: 'free',
    purchasedAt: now,
    image:       'images/nest/free.png',
  };

  const newUser = {
    // ── Identity ──────────────────────────────────────────────────────────────
    authProvider:   provider,
    name,
    email,
    avatar,
    provider,
    providerId,
    createdAt:      now,
    lastLoginTime:  now,
    updatedAt:      now,

    // ── Provider-specific IDs (mirrors existing db structure) ─────────────────
    ...(provider === 'google'  && { googleId:  providerId }),
    ...(provider === 'discord' && { discordId: providerId }),
    ...(provider === 'github'  && { githubId:  providerId }),

    // ── Economy ───────────────────────────────────────────────────────────────
    goldBalance:    0,
    seeds:          0,
    walletBalance:  0,
    totalBP:        0,
    totalDeposited: 0,
    totalSpent:     0,
    seasonBattlePoints: 0,
    seasonId:       null,

    // ── Progression ───────────────────────────────────────────────────────────
    level:          0,
    currentExp:     0,
    requiredExp:    200,
    rank:           'Bronze',
    badge:          'images/badges/bronze.png',
    highScore:      0,

    // ── Game stats ────────────────────────────────────────────────────────────
    selectedBird:           'bird-1',
    totalAttemptsToday:     0,
    generalAttemptsToday:   0,
    lastPlayedAt:           null,
    lastResetDate:          new Date().toISOString().slice(0, 10),

    // ── Referral ──────────────────────────────────────────────────────────────
    referralCode:        randomReferralCode(),
    referralCount:       0,
    referralRewardClaimed: false,
    referredBy:          null,
    referredByCode:      null,

    // ── Security ──────────────────────────────────────────────────────────────
    securityPin:    null,
    currentSessionId: null,

    // ── Wallet (encrypted) ────────────────────────────────────────────────────
    walletPublicKey:  wallet.walletPublicKey,
    walletPrivateKey: wallet.walletPrivateKey,
    walletTransactions: [],
    processedDepositSignatures: [],
    seedPhrase:     wallet.seedPhrase || null,

    // ── Inventory (start with free nest) ─────────────────────────────────────
    inventory: [freeNestItem],

    // ── Energy ────────────────────────────────────────────────────────────────
    // Starts with full energy (base 20 slots, free nest adds 0 bonus slots).
    energy:         20,
    lastEnergyTime: now,   // timestamp of last energy tick / last time energy was calculated

    // ── Daily rewards structure ───────────────────────────────────────────────
    dailyRewards: {
      tracks: {
        normal:     { currentDay: 0, lastClaimedAt: null, claimedDates: [] },
        battlepass: { currentDay: 0, lastClaimedAt: null, claimedDates: [] },
        picks:      { currentDay: 0, lastClaimedAt: null, claimedDates: [] },
      },
    },

    // ── OAuth providers map ───────────────────────────────────────────────────
    oauthProviders: {
      [provider]: {
        id:         providerId,
        email,
        name,
        avatar,
        provider,
        providerId,
        profileUrl: null,
        lastSeen:   now,
      },
    },
  };

  const docRef = await usersRef.add(newUser);
  return { uid: docRef.id, ...newUser };
}

// ── Passport config ───────────────────────────────────────────────────────────
module.exports = (passport) => {

  passport.serializeUser((user, done) => done(null, user.uid));

  passport.deserializeUser(async (uid, done) => {
    try {
      const db  = getFirestore();
      const doc = await db.collection('users').doc(uid).get();
      done(null, doc.exists ? { uid, ...doc.data() } : false);
    } catch (err) {
      done(err, null);
    }
  });

  // Google
  passport.use(new GoogleStrategy(
    {
      clientID:     process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL:  process.env.GOOGLE_CALLBACK_URL,
    },
    async (_at, _rt, profile, done) => {
      try   { done(null, await upsertUser('google', profile)); }
      catch (err) { done(err, null); }
    }
  ));

  // GitHub
  passport.use(new GitHubStrategy(
    {
      clientID:     process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
      callbackURL:  process.env.GITHUB_CALLBACK_URL,
      scope:        ['user:email'],
    },
    async (_at, _rt, profile, done) => {
      try   { done(null, await upsertUser('github', profile)); }
      catch (err) { done(err, null); }
    }
  ));

  // Discord
  passport.use(new DiscordStrategy(
    {
      clientID:     process.env.DISCORD_CLIENT_ID,
      clientSecret: process.env.DISCORD_CLIENT_SECRET,
      callbackURL:  process.env.DISCORD_CALLBACK_URL,
      scope:        ['identify', 'email'],
    },
    async (_at, _rt, profile, done) => {
      try {
        if (profile.avatar) {
          profile.photos = [{
            value: `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png`,
          }];
        }
        done(null, await upsertUser('discord', profile));
      } catch (err) { done(err, null); }
    }
  ));
};
