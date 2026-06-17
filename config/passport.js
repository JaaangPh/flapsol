const GoogleStrategy  = require('passport-google-oauth20').Strategy;
const GitHubStrategy  = require('passport-github2').Strategy;
const DiscordStrategy = require('passport-discord').Strategy;
const { getFirestore } = require('./firebase');

// ── Upsert user in Firestore ─────────────────────────────────────────────────
async function upsertUser(provider, profile) {
  const db         = getFirestore();
  const providerId = String(profile.id);
  const email      = profile.emails?.[0]?.value || null;
  const name       = profile.displayName || profile.username || profile.global_name || 'Player';
  const avatar     = profile.photos?.[0]?.value || null;

  const usersRef = db.collection('users');
  const snap     = await usersRef
    .where(`oauthProviders.${provider}.id`, '==', providerId)
    .limit(1)
    .get();

  if (!snap.empty) {
    const doc = snap.docs[0];
    await doc.ref.update({
      lastLoginTime: new Date().toISOString(),
      [`oauthProviders.${provider}.lastSeen`]: new Date().toISOString(),
      [`oauthProviders.${provider}.avatar`]:   avatar,
    });
    return { uid: doc.id, ...doc.data() };
  }

  // Brand-new user
  const newUser = {
    authProvider:       provider,
    name,
    email,
    avatar,
    provider,
    providerId,
    createdAt:          new Date().toISOString(),
    lastLoginTime:      new Date().toISOString(),
    clashBalance:       5,
    walletBalance:      0,
    totalBP:            0,
    level:              0,
    currentExp:         0,
    requiredExp:        200,
    rank:               'Bronze',
    badge:              'images/badges/bronze.png',
    selectedBird:       'bird-1',
    highScore:          0,
    totalAttemptsToday: 0,
    oauthProviders: {
      [provider]: {
        id:       providerId,
        email,
        name,
        avatar,
        lastSeen: new Date().toISOString(),
      },
    },
  };

  const docRef = await usersRef.add(newUser);
  return { uid: docRef.id, ...newUser };
}

// ── Passport config ──────────────────────────────────────────────────────────
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
