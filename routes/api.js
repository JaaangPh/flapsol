const express          = require('express');
const router           = express.Router();
const { getFirestore } = require('../config/firebase');
const {
  Connection, PublicKey, LAMPORTS_PER_SOL,
  SystemProgram, Transaction, Keypair, sendAndConfirmTransaction
} = require('@solana/web3.js');
const bs58        = require('bs58');
const { decrypt } = require('../utils/wallet');
const { getSPLTokenBalance } = require('../utils/solanaToken');

function getSolanaConnection() {
  const rpc = process.env.SOLANA_RPC_URL
    || (process.env.SOLANA_NETWORK === 'devnet'
      ? 'https://api.devnet.solana.com'
      : 'https://api.mainnet-beta.solana.com');
  return new Connection(rpc, 'confirmed');
}

function requireAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

// ── POST /api/score ───────────────────────────────────────────────────────────
router.post('/score', requireAuth, async (req, res) => {
  try {
    const { score, duration, goldCollected = 0, seedsCollected = 0, goldItemsCollected = 0 } = req.body;
    if (typeof score !== 'number' || score < 0 || !isFinite(score))
      return res.status(400).json({ error: 'Invalid score' });

    // Cap score to a realistic maximum (pipe counter — 9999 ≈ 5 hrs non-stop)
    const MAX_SCORE = 9999;
    if (score > MAX_SCORE)
      return res.status(400).json({ error: 'Score exceeds maximum allowed value.' });

    // uid is the Firestore auto-generated doc ID set by passport.serializeUser
    const uid = req.user.uid;
    if (!uid) {
      console.error('[/api/score] req.user.uid is missing:', req.user);
      return res.status(400).json({ error: 'User ID missing from session' });
    }

    const db  = getFirestore();
    const ref = db.collection('users').doc(uid);
    const doc = await ref.get();
    if (!doc.exists) {
      console.error('[/api/score] No Firestore doc for uid:', uid);
      return res.status(404).json({ error: 'User not found' });
    }

    const data = doc.data();

    // ── Active gameplay session check (anti-bypass) ─────────────────────────
    const gameStartedAt = data.gameStartedAt ? new Date(data.gameStartedAt).getTime() : 0;
    if (!gameStartedAt) {
      console.warn(`[/api/score] uid=${uid} attempted submission with no active game session.`);
      await ref.update({
        suspiciousFlag: true,
        suspiciousFlagAt: new Date().toISOString(),
        suspiciousReason: 'Direct score submission without active game session (bypass)'
      });
      return res.status(400).json({ error: 'No active game session. Please start a game first.' });
    }

    const now = Date.now();
    const elapsed = (now - gameStartedAt) / 1000; // elapsed time in seconds

    // ── Time & Score plausibility checks (anti-cheat) ─────────────────────────
    const playDuration = typeof duration === 'number' && isFinite(duration) ? Math.max(0, duration) : 0;

    // 1. Check if claimed play duration exceeds the server-recorded elapsed time since start
    if (playDuration > elapsed + 5) {
      console.warn(`[/api/score] uid=${uid} suspicious play duration: claimed=${playDuration}s, actual elapsed=${elapsed}s`);
      await ref.update({
        suspiciousFlag: true,
        suspiciousFlagAt: new Date().toISOString(),
        suspiciousReason: `Time spoofing: claimed play duration (${playDuration}s) exceeds elapsed time (${elapsed.toFixed(1)}s)`
      });
      return res.status(400).json({ error: 'Play duration is inconsistent with elapsed time.' });
    }

    // 2. Check if the score is plausible given elapsed time (max pace is ~1 pipe per 1.5 seconds)
    const maxPlausibleScore = Math.ceil(elapsed / 1.5);
    if (score > maxPlausibleScore + 5) {
      console.warn(`[/api/score] uid=${uid} implausible score=${score} in elapsed=${elapsed}s (maxPlausible=${maxPlausibleScore})`);
      await ref.update({
        suspiciousFlag: true,
        suspiciousFlagAt: new Date().toISOString(),
        suspiciousReason: `Score spoofing: score (${score}) exceeds max plausible score (${maxPlausibleScore}) for elapsed time (${elapsed.toFixed(1)}s)`
      });
      return res.status(400).json({ error: 'Score is inconsistent with play time.' });
    }

    // 3. Check if the score is plausible given play duration (redundant backup check)
    if (playDuration > 0 && score > 0) {
      const maxPlausibleScoreByDuration = Math.ceil(playDuration / 1.5);
      if (score > maxPlausibleScoreByDuration + 5) {
        console.warn(`[/api/score] uid=${uid} implausible score=${score} duration=${playDuration} maxPlausible=${maxPlausibleScoreByDuration}`);
        await ref.update({
          suspiciousFlag: true,
          suspiciousFlagAt: new Date().toISOString(),
          suspiciousReason: `Score spoofing: score (${score}) exceeds max plausible score (${maxPlausibleScoreByDuration}) for claimed duration (${playDuration}s)`
        });
        return res.status(400).json({ error: 'Score is inconsistent with play duration.' });
      }
    }

    // 4. Validate that collected items do not exceed the score (+2 tolerance)
    const safeGold = Math.max(0, Math.floor(Number(goldCollected) || 0));
    const safeGoldItems = Math.max(0, Math.floor(Number(goldItemsCollected) || 0));
    const safeSeeds = Math.max(0, Math.floor(Number(seedsCollected) || 0));
    if (safeGoldItems + safeSeeds > score + 2) {
      console.warn(`[/api/score] uid=${uid} collected items exceed score: goldItems=${safeGoldItems}, seeds=${safeSeeds}, score=${score}`);
      await ref.update({
        suspiciousFlag: true,
        suspiciousFlagAt: new Date().toISOString(),
        suspiciousReason: `Item count spoofing: collected ${safeGoldItems} gold items and ${safeSeeds} seeds, but score is ${score}`
      });
      return res.status(400).json({ error: 'Collected items are inconsistent with score.' });
    }

    // 4.1 Validate that the gold balance matches the gold items range [items * 500, items * 1000]
    if (safeGold > safeGoldItems * 1000 || (safeGoldItems > 0 && safeGold < safeGoldItems * 500)) {
      console.warn(`[/api/score] uid=${uid} suspicious gold balance: goldBalance=${safeGold}, goldItems=${safeGoldItems}`);
      await ref.update({
        suspiciousFlag: true,
        suspiciousFlagAt: new Date().toISOString(),
        suspiciousReason: `Gold balance spoofing: collected ${safeGold} gold balance from ${safeGoldItems} items (expected range [${safeGoldItems * 500}, ${safeGoldItems * 1000}])`
      });
      return res.status(400).json({ error: 'Collected gold balance is inconsistent with items collected.' });
    }

    // Rate limit: minimum 30 seconds between score submissions (read from Firestore)
    const MIN_GAME_MS = 30 * 1000;
    const lastPlayed  = data.lastPlayedAt ? new Date(data.lastPlayedAt).getTime() : 0;
    if (now - lastPlayed < MIN_GAME_MS)
      return res.status(429).json({ error: 'Please wait before submitting another score.' });

    const prevBest = data.highScore ?? 0;
    const newBest  = Math.max(score, prevBest);

    // EXP Calculation: base EXP on duration and score (always random 1-10 EXP)
    // playDuration already validated above at the top of this handler
    const performance = score * 1.5 + playDuration * 0.2;
    const factor = Math.min(1, performance / 15);
    const minExp = 1 + Math.floor(factor * 4); // ranges 1 to 5
    const maxExp = 5 + Math.floor(factor * 5); // ranges 5 to 10
    const expGained = Math.floor(Math.random() * (maxExp - minExp + 1)) + minExp;

    let currentExp = data.currentExp ?? 0;
    let requiredExp = data.requiredExp ?? 200;
    let level = data.level ?? 0;

    currentExp += expGained;
    let leveledUp = false;
    while (currentExp >= requiredExp) {
      currentExp -= requiredExp;
      level += 1;
      requiredExp = (level + 1) * 200;
      leveledUp = true;
    }

    const updates  = {
      totalAttemptsToday: (data.totalAttemptsToday || 0) + 1,
      lastPlayedAt:       new Date().toISOString(),
      lastScore:          score,    // stored so game/end can cross-verify the score
      lastGoldCollected:  safeGold,
      lastGoldItemsCollected: safeGoldItems,
      lastSeedsCollected: safeSeeds,
      highScore:          newBest,
      totalScore:         (data.totalScore || 0) + score,
      currentExp,
      requiredExp,
      level,
      gameStartedAt:      null, // Consume/end this gameplay session
    };

    await ref.update(updates);
    req.user.highScore          = newBest;
    req.user.totalAttemptsToday = updates.totalAttemptsToday;
    req.user.currentExp         = currentExp;
    req.user.requiredExp        = requiredExp;
    req.user.level              = level;

    console.log(`[/api/score] uid=${uid} score=${score} prevBest=${prevBest} newBest=${newBest} saved=${score > prevBest} playDuration=${playDuration} expGained=${expGained} level=${level}`);
    res.json({
      ok: true,
      highScore: newBest,
      expGained,
      currentExp,
      requiredExp,
      level,
      leveledUp
    });
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
// Paginated leaderboard ordered by totalScore (cumulative across all matches).
// Query params: ?page=1&limit=5
router.get('/leaderboard', async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(20, Math.max(1, parseInt(req.query.limit) || 5));

    const db   = getFirestore();

    // Fetch enough docs to support the requested page
    // Firestore doesn't support offset natively for large sets,
    // so we fetch page * limit and slice.
    const snap = await db.collection('users')
      .orderBy('totalScore', 'desc')
      .limit(page * limit)
      .get();

    const allDocs = snap.docs;
    const total   = allDocs.length; // docs fetched so far (not total users)
    const start   = (page - 1) * limit;
    const pageDocs = allDocs.slice(start, start + limit);

    const board = pageDocs.map((d, i) => {
      const { name, avatar, highScore, totalScore, rank, selectedBird, walletPublicKey } = d.data();

      let walletAddress = null;
      if (walletPublicKey) {
        try {
          walletAddress = decrypt(walletPublicKey);
        } catch {
          if (!walletPublicKey.includes(':')) walletAddress = walletPublicKey;
        }
      }

      let displayName = name || 'Player';
      if (walletAddress && walletAddress.length > 12) {
        displayName = walletAddress.slice(0, 8) + '....' + walletAddress.slice(-4);
      }

      return {
        rank:         start + i + 1,
        name:         displayName,
        avatar:       avatar      || null,
        highScore:    highScore   || 0,
        totalScore:   totalScore  || 0,
        tier:         rank        || 'Bronze',
        selectedBird: selectedBird || 'bird-1',
      };
    });

    res.json({
      ok:       true,
      page,
      limit,
      hasMore:  total >= page * limit, // if we got a full page, there may be more
      board,
    });
  } catch (err) {
    console.error('[/api/leaderboard]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/update-profile-name ────────────────────────────────────────────
router.post('/update-profile-name', requireAuth, async (req, res) => {
  const { prefix, suffix } = req.body;

  if (!prefix || typeof prefix !== 'string')
    return res.status(400).json({ error: 'Username prefix is required.' });

  const clean = prefix.trim();
  if (!/^[a-zA-Z0-9_-]{3,15}$/.test(clean))
    return res.status(400).json({ error: 'Prefix must be 3–15 chars: letters, numbers, _ or -' });

  if (!suffix || !['.clash', '.sol'].includes(suffix))
    return res.status(400).json({ error: 'Suffix must be .clash or .sol' });

  const newName = `${clean}${suffix}`;
  const uid     = req.user.uid;

  try {
    const db    = getFirestore();
    // Check uniqueness (case-insensitive) across all users
    const snap  = await db.collection('users')
      .where('name', '==', newName)
      .limit(1).get();

    if (!snap.empty && snap.docs[0].id !== uid)
      return res.status(400).json({ error: `${newName} is already taken.` });

    await db.collection('users').doc(uid).update({ name: newName });
    req.user.name = newName;
    res.json({ ok: true, name: newName });
  } catch (err) {
    console.error('[/api/update-profile-name]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/update-profile-avatar ──────────────────────────────────────────
router.post('/update-profile-avatar', requireAuth, async (req, res) => {
  const { avatar } = req.body;

  if (!avatar || typeof avatar !== 'string') {
    return res.status(400).json({ error: 'Avatar image is required.' });
  }

  // Validate that it's a data URL starting with data:image/ or a valid local image path
  const isDataUrl = avatar.startsWith('data:image/');
  const isLocalImage = [
    'images/birds/Bird.png',
    'images/birds/Bird-2.png',
    'images/birds/bird31.png',
    'images/birds/bird32.png',
    'images/birds/bird-2/Bird.png',
    'images/birds/bird-3/bird21.png'
  ].includes(avatar);

  if (!isDataUrl && !isLocalImage && !avatar.startsWith('http')) {
    return res.status(400).json({ error: 'Invalid avatar path or image format.' });
  }

  const uid = req.user.uid;

  try {
    const db = getFirestore();
    await db.collection('users').doc(uid).update({ avatar });
    req.user.avatar = avatar;

    console.log(`[/api/update-profile-avatar] uid=${uid} updated avatar successfully.`);
    res.json({ ok: true, avatar });
  } catch (err) {
    console.error('[/api/update-profile-avatar]', err);
    res.status(500).json({ error: 'Server error' });
  }
});


// ── GET /api/balance/:address — live on-chain SOL balance ────────────────────
router.get('/balance/:address', async (req, res) => {
  try {
    const connection = getSolanaConnection();
    const pubkey     = new PublicKey(req.params.address);
    const lamports   = await connection.getBalance(pubkey);
    res.json({ balance: lamports / LAMPORTS_PER_SOL });
  } catch (err) {
    console.error('[/api/balance]', err.message);
    res.status(400).json({ error: err.message });
  }
});

// ── GET /api/gold-balance/:address — live on-chain GOLD CA balance ────────────
router.get('/gold-balance/:address', async (req, res) => {
  try {
    const connection = getSolanaConnection();
    const mint = process.env.GOLD_CA || '3KSojyU77i1D6DRqDnUhPvM2kWjuF6VFYHcL6Lzjpump';
    const balance = await getSPLTokenBalance(connection, req.params.address, mint);
    res.json({ balance });
  } catch (err) {
    console.error('[/api/gold-balance]', err.message);
    res.status(400).json({ error: err.message });
  }
});

// ── POST /api/wallet/reveal — decrypt and reveal seed phrase / private key ────
router.post('/wallet/reveal', requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    if (!uid) {
      return res.status(400).json({ error: 'User ID missing from session' });
    }

    const db  = getFirestore();
    const doc = await db.collection('users').doc(uid).get();
    if (!doc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    const data = doc.data();
    
    let decryptedSeedPhrase = null;
    let decryptedPrivateKey = null;

    if (data.seedPhrase) {
      decryptedSeedPhrase = decrypt(data.seedPhrase);
    }
    if (data.walletPrivateKey) {
      decryptedPrivateKey = decrypt(data.walletPrivateKey);
    }

    res.json({
      ok: true,
      seedPhrase: decryptedSeedPhrase,
      privateKey: decryptedPrivateKey
    });
  } catch (err) {
    console.error('[/api/wallet/reveal]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/marketplace/nest-prices ─────────────────────────────────────────
// Public endpoint — returns current nest prices from Firestore config doc.
// Falls back to hardcoded defaults if the config doc doesn't exist yet.
router.get('/marketplace/nest-prices', async (_req, res) => {
  try {
    const db  = getFirestore();
    const doc = await db.collection('config').doc('marketplace').get();
    if (doc.exists) {
      const d = doc.data();
      return res.json({
        ok: true,
        prices: {
          common:    d.nestPriceCommon    ?? 0.35,
          rare:      d.nestPriceRare      ?? 0.75,
          legendary: d.nestPriceLegendary ?? 1.2,
        },
      });
    }
    return res.json({ ok: true, prices: { common: 0.35, rare: 0.75, legendary: 1.2 } });
  } catch (err) {
    console.error('[/api/marketplace/nest-prices]', err);
    // Return defaults on error so the marketplace still loads
    return res.json({ ok: true, prices: { common: 0.35, rare: 0.75, legendary: 1.2 } });
  }
});

// ── GET /api/marketplace/sol-php ─────────────────────────────────────────────
// Returns live SOL/PHP price + real $GOLD token price from Jupiter.
// Gold nest prices are computed as: ceil(nestSolPrice * solPhp / goldPricePhp)
router.get('/marketplace/sol-php', async (_req, res) => {
  try {
    const https = require('https');
    const fetch = (url) => new Promise((resolve, reject) => {
      https.get(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'SolClash/1.0' } }, (r) => {
        let data = '';
        r.on('data', c => data += c);
        r.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
      }).on('error', reject);
    });

    // Fetch SOL/PHP and SOL/USD in parallel
    const [phpData, usdData] = await Promise.all([
      fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=php'),
      fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd'),
    ]);

    const solPhp = phpData?.solana?.php;
    const solUsd = usdData?.solana?.usd;

    if (!solPhp || typeof solPhp !== 'number') {
      return res.status(502).json({ error: 'Could not fetch SOL price.' });
    }

    // Fetch $GOLD token price in USD from pump.fun API (works for bonding curve tokens)
    const goldCA = process.env.GOLD_CA;
    let goldPricePhp = null;
    let goldPriceUsd = null;

    if (goldCA && solUsd) {
      // Try Jupiter first — most accurate, works for bonding curve + graduated tokens
      try {
        const jupData = await fetch(`https://api.jup.ag/price/v2?ids=${goldCA}`);
        const priceUsd = Number(jupData?.data?.[goldCA]?.price);
        if (priceUsd > 0) {
          goldPriceUsd = priceUsd;
          const phpPerUsd = solPhp / solUsd;
          goldPricePhp = priceUsd * phpPerUsd;
        }
      } catch (e) {
        console.error('[sol-php] Jupiter price fetch error:', e.message);
      }

      // Fallback: pump.fun using price_sol (avoid total_supply — unreliable field)
      if (!goldPriceUsd) {
        try {
          const pumpData = await fetch(`https://frontend-api-v3.pump.fun/coins/${goldCA}`);
          if (pumpData?.price_sol && typeof pumpData.price_sol === 'number') {
            goldPriceUsd = pumpData.price_sol * solUsd;
            const phpPerUsd = solPhp / solUsd;
            goldPricePhp = goldPriceUsd * phpPerUsd;
          }
        } catch (e) {
          console.error('[sol-php] pump.fun price fetch error:', e.message);
        }
      }
    }

    const catalog = await getNestCatalog();

    // Compute gold required per nest using real token price
    // Fallback to 1 GOLD = 1 PHP if Jupiter price unavailable
    function nestGoldPrice(solPrice) {
      const php = solPrice * solPhp;
      if (goldPricePhp && goldPricePhp > 0) return Math.ceil(php / goldPricePhp);
      return Math.floor(php); // legacy fallback
    }

    return res.json({
      ok: true,
      solPhp,
      goldPriceUsd,
      goldPricePhp,
      gold: {
        common:    nestGoldPrice(catalog.common.price),
        rare:      nestGoldPrice(catalog.rare.price),
        legendary: nestGoldPrice(catalog.legendary.price),
      },
    });
  } catch (err) {
    console.error('[/api/marketplace/sol-php]', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/marketplace/buy-nest-gold ──────────────────────────────────────
// Purchase a nest using real $GOLD SPL tokens.
// Pricing: nestSOLPrice → convert to $GOLD using live $GOLD/SOL rate from Jupiter/CoinGecko.
// Transfer: user's wallet → TREASURY_WALLET_ADDRESS (on-chain SPL transfer).
router.post('/marketplace/buy-nest-gold', requireAuth, async (req, res) => {
  try {
    const { rarity } = req.body;
    if (!NEST_CATALOG[rarity])
      return res.status(400).json({ error: 'Invalid nest rarity.' });

    const uid = req.user.uid;
    const db  = getFirestore();
    const ref = db.collection('users').doc(uid);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'User not found.' });

    const userData = doc.data();

    // ── Fetch live SOL/PHP for gold price ─────────────────────────────────
    const https = require('https');
    const fetchJson = (url) => new Promise((resolve, reject) => {
      https.get(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'SolClash/1.0' } }, (r) => {
        let data = '';
        r.on('data', c => data += c);
        r.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
      }).on('error', reject);
    });

    let solPhp;
    try {
      const cgData = await fetchJson('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=php');
      solPhp = cgData?.solana?.php;
    } catch (e) {
      console.error('[buy-nest-gold] CoinGecko error:', e);
    }

    if (!solPhp || typeof solPhp !== 'number') {
      return res.status(502).json({ error: 'Could not fetch live SOL price. Try again shortly.' });
    }

    // ── Fetch live $GOLD token price via pump.fun API (bonding curve tokens) ─
    const goldCA = process.env.GOLD_CA;
    if (!goldCA) {
      return res.status(500).json({ error: 'GOLD_CA not configured.' });
    }

    let goldPricePhp = null;

    // Fetch SOL/USD for price conversions
    let solUsd = null;
    try {
      const cgUsd = await fetchJson('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
      solUsd = cgUsd?.solana?.usd;
    } catch (e) {
      console.error('[buy-nest-gold] CoinGecko USD error:', e.message);
    }

    // Try Jupiter first — most accurate USD price per token (works for bonding curve + graduated)
    if (solUsd) {
      try {
        const jupData = await fetchJson(`https://api.jup.ag/price/v2?ids=${goldCA}`);
        const goldUsd = Number(jupData?.data?.[goldCA]?.price);
        if (goldUsd > 0) {
          const phpPerUsd = solPhp / solUsd;
          goldPricePhp = goldUsd * phpPerUsd;
          console.log(`[buy-nest-gold] Jupiter gold price: $${goldUsd} USD / ${goldPricePhp.toFixed(8)} PHP`);
        }
      } catch (e) {
        console.error('[buy-nest-gold] Jupiter price fetch error:', e.message);
      }
    }

    // Fallback: pump.fun API using price_sol field (avoid total_supply — unreliable)
    if (!goldPricePhp && solUsd) {
      try {
        const pumpData = await fetchJson(`https://frontend-api-v3.pump.fun/coins/${goldCA}`);
        if (pumpData?.price_sol && typeof pumpData.price_sol === 'number') {
          const goldPriceUsd = pumpData.price_sol * solUsd;
          const phpPerUsd = solPhp / solUsd;
          goldPricePhp = goldPriceUsd * phpPerUsd;
          console.log(`[buy-nest-gold] pump.fun gold price: ${pumpData.price_sol} SOL / $${goldPriceUsd} USD`);
        }
      } catch (e) {
        console.error('[buy-nest-gold] pump.fun price fetch error:', e.message);
      }
    }

    const catalog   = await getNestCatalog();
    const nestInfo  = catalog[rarity];
    const nestPhp   = nestInfo.price * solPhp; // nest price in PHP

    // Gold required = nestPhp / goldPricePhp (how many GOLD tokens to cover the nest price)
    // Fallback: if Jupiter price unavailable, use 1 GOLD = 1 PHP legacy rate
    let goldRequired;
    if (goldPricePhp && goldPricePhp > 0) {
      goldRequired = Math.ceil(nestPhp / goldPricePhp);
    } else {
      goldRequired = Math.floor(nestPhp); // fallback: 1 GOLD = 1 PHP
    }

    // ── Decrypt user private key for on-chain transfer ────────────────────
    let buyerKeypair;
    try {
      if (userData.seedPhrase) {
        const bip39 = require('bip39');
        const { derivePath } = require('ed25519-hd-key');
        const mnemonic = decrypt(userData.seedPhrase);
        const seed = bip39.mnemonicToSeedSync(mnemonic);
        const derived = derivePath("m/44'/501'/0'/0'", seed.toString('hex'));
        buyerKeypair = Keypair.fromSeed(derived.key);
      } else if (userData.walletPrivateKey) {
        const privKeyB58 = decrypt(userData.walletPrivateKey);
        buyerKeypair = Keypair.fromSecretKey(bs58.decode(privKeyB58));
      } else {
        return res.status(400).json({ error: 'No wallet key found for this account.' });
      }
    } catch (e) {
      console.error('[buy-nest-gold] Key decrypt error:', e);
      return res.status(500).json({ error: 'Failed to access wallet. Please contact support.' });
    }

    // ── Resolve treasury address ──────────────────────────────────────────
    const treasuryAddress = process.env.TREASURY_WALLET_ADDRESS;
    if (!treasuryAddress) {
      return res.status(500).json({ error: 'Treasury wallet not configured.' });
    }

    // ── Check user on-chain $GOLD token balance ───────────────────────────
    const { getSPLTokenBalance, transferSPLToken } = require('../utils/solanaToken');
    const connection = getSolanaConnection();
    const userWalletAddress = buyerKeypair.publicKey.toBase58();
    const onChainBalance = await getSPLTokenBalance(connection, userWalletAddress, goldCA);

    if (onChainBalance < goldRequired) {
      return res.status(400).json({
        error: `Insufficient on-chain $GOLD. Need ${goldRequired.toLocaleString()}, wallet holds ${onChainBalance.toLocaleString()}.`
      });
    }

    // ── Transfer $GOLD tokens: user → treasury (on-chain) ─────────────────
    let txSignature;
    try {
      txSignature = await transferSPLToken(
        connection,
        buyerKeypair,
        treasuryAddress,
        goldCA,
        goldRequired
      );
    } catch (txErr) {
      console.error('[buy-nest-gold] SPL transfer failed:', txErr.message);
      return res.status(400).json({
        error: 'Token transfer failed: ' + (txErr.message || 'Unknown error')
      });
    }

    // ── Build nest item and update Firestore ──────────────────────────────
    const tag4    = String(Math.floor(1000 + Math.random() * 9000));
    const nestTag = `${nestInfo.baseName}#${tag4}`;

    const newNestItem = {
      id:            `nest_${Date.now()}_${tag4}`,
      type:          'nest',
      rarity,
      baseName:      nestInfo.baseName,
      nestTag,
      priceSol:      nestInfo.price,
      priceGold:     goldRequired,
      txSignature,
      paymentMethod: 'gold',
      purchasedAt:   new Date().toISOString(),
      image:         `images/nest/${rarity}.png`,
    };

    const currentInventory = userData.inventory || [];
    currentInventory.push(newNestItem);

    const newNestCfg     = ENERGY_CONFIG[rarity];
    const newNestRegenMs = newNestCfg ? newNestCfg.regenMs : 14400000;
    const currentEnergy  = typeof userData.energy === 'number' ? userData.energy : 0;
    const nestTimers = {
      ...(userData.nestTimers || {}),
      [newNestItem.id]: { nextTickAt: new Date(Date.now() + newNestRegenMs).toISOString() }
    };

    await ref.update({ inventory: currentInventory, energy: currentEnergy, nestTimers });

    console.log(`[buy-nest-gold] uid=${uid} bought ${nestTag} rarity=${rarity} goldSpent=${goldRequired} tx=${txSignature}`);

    return res.json({ ok: true, nestTag, txSignature });

  } catch (err) {
    console.error('[buy-nest-gold]', err);
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

async function getNestCatalog() {
  try {
    const db  = getFirestore();
    const doc = await db.collection('config').doc('marketplace').get();
    if (doc.exists) {
      const d = doc.data();
      return {
        common:    { baseName: 'Ice Nest',     price: d.nestPriceCommon    ?? 0.35 },
        rare:      { baseName: 'Volcano Nest', price: d.nestPriceRare      ?? 0.75 },
        legendary: { baseName: 'Cosmic Nest',  price: d.nestPriceLegendary ?? 1.2  },
      };
    }
  } catch { /* fall through to defaults */ }
  return {
    common:    { baseName: 'Ice Nest',     price: 0.35 },
    rare:      { baseName: 'Volcano Nest', price: 0.75 },
    legendary: { baseName: 'Cosmic Nest',  price: 1.2  },
  };
}

// Keep NEST_CATALOG as a static fallback reference (used for rarity validation)
const NEST_CATALOG = {
  common:    { baseName: 'Ice Nest',     price: 0.35 },
  rare:      { baseName: 'Volcano Nest', price: 0.75 },
  legendary: { baseName: 'Cosmic Nest',  price: 1.2  },
};

router.post('/marketplace/buy-nest', requireAuth, async (req, res) => {
  try {
    const { rarity } = req.body;
    if (!NEST_CATALOG[rarity])
      return res.status(400).json({ error: 'Invalid nest rarity.' });

    const uid = req.user.uid;
    if (!uid) return res.status(400).json({ error: 'User ID missing.' });

    const db  = getFirestore();
    const ref = db.collection('users').doc(uid);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'User not found.' });

    const userData = doc.data();

    // ── Decrypt user private key ──────────────────────────────────────────
    let buyerKeypair;
    try {
      if (userData.seedPhrase) {
        // Seed-phrase wallet: derive keypair
        const bip39 = require('bip39');
        const { derivePath } = require('ed25519-hd-key');
        const mnemonic = decrypt(userData.seedPhrase);
        const seed = bip39.mnemonicToSeedSync(mnemonic);
        const derived = derivePath("m/44'/501'/0'/0'", seed.toString('hex'));
        buyerKeypair = Keypair.fromSeed(derived.key);
      } else if (userData.walletPrivateKey) {
        const privKeyB58 = decrypt(userData.walletPrivateKey);
        buyerKeypair = Keypair.fromSecretKey(bs58.decode(privKeyB58));
      } else {
        return res.status(400).json({ error: 'No wallet key found for this account.' });
      }
    } catch (e) {
      console.error('[buy-nest] Key decrypt error:', e);
      return res.status(500).json({ error: 'Failed to access wallet. Please contact support.' });
    }

    const nestInfo = (await getNestCatalog())[rarity];
    const priceSOL = nestInfo.price;
    const priceLamports = Math.round(priceSOL * LAMPORTS_PER_SOL);

    // ── Check balance ─────────────────────────────────────────────────────
    const connection = getSolanaConnection();
    const buyerPubkey = buyerKeypair.publicKey;
    const balanceLamports = await connection.getBalance(buyerPubkey);

    // Require price + ~0.000005 SOL for tx fee
    const feeCushion = 5000;
    if (balanceLamports < priceLamports + feeCushion) {
      const needed = ((priceLamports + feeCushion) / LAMPORTS_PER_SOL).toFixed(4);
      const have   = (balanceLamports / LAMPORTS_PER_SOL).toFixed(4);
      return res.status(400).json({
        error: `Insufficient balance. Need ${needed} SOL, have ${have} SOL.`
      });
    }

    // ── Store wallet destination ──────────────────────────────────────────
    const storeAddress = process.env.STORE_WALLET_ADDRESS;
    if (!storeAddress) {
      console.error('[buy-nest] STORE_WALLET_ADDRESS not set in .env');
      return res.status(500).json({ error: 'Store wallet not configured.' });
    }
    const storePubkey = new PublicKey(storeAddress);

    // ── Build & send transaction ──────────────────────────────────────────
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: buyerPubkey,
        toPubkey:   storePubkey,
        lamports:   priceLamports,
      })
    );

    let txSignature;
    try {
      txSignature = await sendAndConfirmTransaction(
        connection,
        transaction,
        [buyerKeypair],
        { commitment: 'confirmed' }
      );
    } catch (txErr) {
      console.error('[buy-nest] Transaction error:', txErr);
      return res.status(400).json({
        error: 'Solana transaction failed: ' + (txErr.message || 'Unknown error')
      });
    }

    // ── Verify transaction on-chain ───────────────────────────────────────
    let verified = false;
    try {
      const txInfo = await connection.getTransaction(txSignature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      if (txInfo && !txInfo.meta?.err) {
        verified = true;
      }
    } catch (verifyErr) {
      console.error('[buy-nest] Verify error:', verifyErr);
    }

    if (!verified) {
      console.error('[buy-nest] TX not verified:', txSignature);
      return res.status(400).json({
        error: 'Transaction could not be verified on-chain. Please contact support with TX: ' + txSignature
      });
    }

    // ── Assign unique tag and record in Firestore ─────────────────────────
    const tag4    = String(Math.floor(1000 + Math.random() * 9000));
    const nestTag = `${nestInfo.baseName}#${tag4}`;

    const newNestItem = {
      id:          `nest_${Date.now()}_${tag4}`,
      type:        'nest',
      rarity,
      baseName:    nestInfo.baseName,
      nestTag,
      price:       priceSOL,
      txSignature,
      purchasedAt: new Date().toISOString(),
      image:       `images/nest/${rarity}.png`,
    };

    const currentInventory = userData.inventory || [];
    currentInventory.push(newNestItem);

    const newBalanceLamports = await connection.getBalance(buyerPubkey).catch(() => null);
    const newBalance = newBalanceLamports !== null ? newBalanceLamports / LAMPORTS_PER_SOL : null;

    // ── Register new nest's regen timer (energy stays at 20 fixed slots) ─
    const newNestCfg     = ENERGY_CONFIG[rarity];
    const newNestRegenMs = newNestCfg ? newNestCfg.regenMs : 14400000;
    const currentEnergy  = typeof userData.energy === 'number' ? userData.energy : 0;
    const nestTimers = { ...(userData.nestTimers || {}), [newNestItem.id]: { nextTickAt: new Date(Date.now() + newNestRegenMs).toISOString() } };

    await ref.update({
      inventory: currentInventory,
      energy: currentEnergy,
      nestTimers,
      ...(newBalance !== null ? { walletBalance: newBalance } : {}),
    });

    console.log(`[buy-nest] uid=${uid} bought ${nestTag} rarity=${rarity} tx=${txSignature} energy=${currentEnergy}/${BASE_ENERGY_SLOTS}`);

    return res.json({
      ok:           true,
      nestTag,
      txSignature,
      newBalance,
    });

  } catch (err) {
    console.error('[buy-nest]', err);
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// ── POST /api/nest/upgrade ────────────────────────────────────────────────────
// Upgrades a nest by 1 level (max level 5). Costs BP + Seeds + Gold.
// Only common, rare, legendary nests are upgradable (not free).
//
// Upgrade costs:
//   Lvl 1: 350 BP,  50 seeds,  50,000 gold
//   Lvl 2: 500 BP, 110 seeds, 120,000 gold
//   Lvl 3: 800 BP, 160 seeds, 250,000 gold
//   Lvl 4: 1000 BP, 220 seeds, 350,000 gold
//   Lvl 5: 1300 BP, 300 seeds, 500,000 gold

const NEST_UPGRADE_COSTS = [
  null,                                              // placeholder — index 0 unused
  { bp: 350,  seeds: 50,  gold: 50000  },           // → level 1
  { bp: 500,  seeds: 110, gold: 120000 },           // → level 2
  { bp: 800,  seeds: 160, gold: 250000 },           // → level 3
  { bp: 1000, seeds: 220, gold: 350000 },           // → level 4
  { bp: 1300, seeds: 300, gold: 500000 },           // → level 5
];
const NEST_MAX_LEVEL = 5;

router.post('/nest/upgrade', requireAuth, async (req, res) => {
  try {
    const { nestId } = req.body;
    if (!nestId || typeof nestId !== 'string')
      return res.status(400).json({ error: 'nestId is required.' });

    const uid = req.user.uid;
    const db  = getFirestore();
    const ref = db.collection('users').doc(uid);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'User not found.' });

    const data = doc.data();
    const inventory = [...(data.inventory || [])];

    // Find the nest
    const nestIdx = inventory.findIndex(i => i.id === nestId && i.type === 'nest');
    if (nestIdx === -1)
      return res.status(404).json({ error: 'Nest not found in inventory.' });

    const nest = inventory[nestIdx];

    // Free nests are not upgradable
    if (nest.rarity === 'free')
      return res.status(400).json({ error: 'Free nests cannot be upgraded.' });

    const currentLevel = nest.level || 0;
    if (currentLevel >= NEST_MAX_LEVEL)
      return res.status(400).json({ error: 'Nest is already at max level.' });

    const nextLevel = currentLevel + 1;
    const cost = NEST_UPGRADE_COSTS[nextLevel];

    // Check resources
    const userBP    = data.totalBP      || 0;
    const userSeeds = data.seeds        || 0;
    const userGold  = data.goldBalance  || 0;

    const errors = [];
    if (userBP    < cost.bp)    errors.push(`Need ${cost.bp.toLocaleString()} BP (have ${userBP.toLocaleString()})`);
    if (userSeeds < cost.seeds) errors.push(`Need ${cost.seeds} Seeds (have ${userSeeds})`);
    if (userGold  < cost.gold)  errors.push(`Need ${cost.gold.toLocaleString()} $GOLD (have ${userGold.toLocaleString()})`);

    if (errors.length > 0)
      return res.status(400).json({ error: errors.join(' · ') });

    // Deduct resources and apply upgrade
    inventory[nestIdx] = { ...nest, level: nextLevel, upgradedAt: new Date().toISOString() };

    await ref.update({
      inventory,
      totalBP:      userBP    - cost.bp,
      seeds:        userSeeds - cost.seeds,
      goldBalance:  userGold  - cost.gold,
    });

    console.log(`[nest/upgrade] uid=${uid} nestId=${nestId} rarity=${nest.rarity} level=${currentLevel}→${nextLevel}`);

    return res.json({
      ok:         true,
      nestId,
      newLevel:   nextLevel,
      newBP:      userBP    - cost.bp,
      newSeeds:   userSeeds - cost.seeds,
      newGold:    userGold  - cost.gold,
    });

  } catch (err) {
    console.error('[nest/upgrade]', err);
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// ── GET /api/inventory ────────────────────────────────────────────────────────
router.get('/inventory', requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const db  = getFirestore();
    const doc = await db.collection('users').doc(uid).get();
    if (!doc.exists) return res.status(404).json({ error: 'User not found.' });
    const { inventory = [] } = doc.data();
    return res.json({ ok: true, inventory });
  } catch (err) {
    console.error('[/api/inventory]', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── Energy System ──────────────────────────────────────────────────────────────
//
// Energy slots: always fixed at 20 for everyone — nests do NOT add slots.
// Nests affect ONLY regen speed (more timers = faster refill) and drop rates.
//
// Regen rates:
//   free:      1 energy per 4 hours
//   common:    1 energy per 1.5 hours
//   rare:      1 energy per 1 hour
//   legendary: 1 energy per 30 minutes
//
// Drop rates (capped at 3 nests per rarity for stacking):
//   free:      seed 2%,  gold 0%
//   common:    seed 8%,  gold 3%
//   rare:      seed 14%, gold 7%
//   legendary: seed 20%, gold 12%
//
// Triple bonus (flat, fires once at 3+ of same rarity):
//   common ×3:    +3% seed, +1% gold
//   rare ×3:      +4% seed, +2% gold
//   legendary ×3: +5% seed, +3% gold
//
// Each nest generates energy independently on its own schedule.
// Timers stored as absolute ISO timestamps in Firestore — survive logout/device switch.

const ENERGY_CONFIG = {
  free:      { regenMs:  4 * 60 * 60 * 1000 },   //  4 h
  common:    { regenMs: 1.5 * 60 * 60 * 1000 },  // 1.5 h
  rare:      { regenMs:       60 * 60 * 1000 },   //  1 h
  legendary: { regenMs:  0.5 * 60 * 60 * 1000 }, // 30 min
};

const BASE_ENERGY_SLOTS = 20; // fixed for everyone, always

/**
 * Total slots is always 20 — no nest bonuses.
 */
function calcTotalSlots(/* inventory */) {
  return BASE_ENERGY_SLOTS;
}

/**
 * Lazily apply regen for all nests.
 * Returns { newEnergy, updatedTimers, nestDetails }
 *   updatedTimers – map of nestId → { nextTickAt }  (write back to Firestore)
 *   nestDetails   – array of { nestId, rarity, slots, nextTickAt, regenMs } for clients
 */
function applyAllRegens(currentEnergy, nestTimers = {}, inventory = []) {
  const now = Date.now();
  const totalSlots = calcTotalSlots(inventory);
  let energy = Math.min(currentEnergy ?? 0, totalSlots);

  const updatedTimers = { ...nestTimers };
  const nestDetails = [];

  for (const item of inventory) {
    if (item.type !== 'nest') continue;
    const cfg = ENERGY_CONFIG[item.rarity];
    if (!cfg) continue;

    const nestId = item.id;
    const timer  = updatedTimers[nestId] || {};

    // If this nest has no timer yet, start it now
    if (!timer.nextTickAt) {
      timer.nextTickAt = new Date(now + cfg.regenMs).toISOString();
      updatedTimers[nestId] = timer;
    }

    let nextTick = new Date(timer.nextTickAt).getTime();

    // Catch up on all ticks that have passed since nextTickAt
    while (nextTick <= now && energy < totalSlots) {
      energy++;
      nextTick += cfg.regenMs;
    }

    // If energy was already full when this nest's tick fired, advance the timer
    // forward from now so msUntilNext isn't perpetually 0
    if (nextTick <= now && energy >= totalSlots) {
      while (nextTick <= now) nextTick += cfg.regenMs;
    }

    updatedTimers[nestId] = { nextTickAt: new Date(nextTick).toISOString() };

    nestDetails.push({
      nestId,
      nestTag:   item.nestTag,
      rarity:    item.rarity,
      slots:     cfg.slots,
      regenMs:   cfg.regenMs,
      nextTickAt: updatedTimers[nestId].nextTickAt,
      msUntilNext: Math.max(0, new Date(updatedTimers[nestId].nextTickAt).getTime() - now),
    });
  }

  energy = Math.min(energy, totalSlots);
  return { newEnergy: energy, updatedTimers, nestDetails, totalSlots };
}

// ── GET /api/energy ───────────────────────────────────────────────────────────
router.get('/energy', requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const db  = getFirestore();
    const doc = await db.collection('users').doc(uid).get();
    if (!doc.exists) return res.status(404).json({ error: 'User not found.' });

    const data = doc.data();
    const { newEnergy, updatedTimers, nestDetails, totalSlots } = applyAllRegens(
      data.energy, data.nestTimers || {}, data.inventory || []
    );

    // Persist regen ticks + updated timers
    const changed = newEnergy !== (data.energy ?? 0)
      || JSON.stringify(updatedTimers) !== JSON.stringify(data.nestTimers || {});
    if (changed) {
      await db.collection('users').doc(uid).update({
        energy:     newEnergy,
        nestTimers: updatedTimers,
      });
    }

    // Fastest next tick across all nests (for the dashboard "next regen" display)
    const fastestMs = nestDetails.reduce((min, n) => Math.min(min, n.msUntilNext), Infinity);

    return res.json({
      ok:          true,
      energy:      newEnergy,
      maxEnergy:   totalSlots,
      nextRegenMs: newEnergy < totalSlots ? (fastestMs === Infinity ? null : fastestMs) : null,
      nests:       nestDetails, // per-nest detail for inventory view
    });
  } catch (err) {
    console.error('[/api/energy]', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/energy/use ──────────────────────────────────────────────────────
router.post('/energy/use', requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const db  = getFirestore();
    const ref = db.collection('users').doc(uid);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'User not found.' });

    const data = doc.data();
    const { newEnergy, updatedTimers, nestDetails, totalSlots } = applyAllRegens(
      data.energy, data.nestTimers || {}, data.inventory || []
    );

    if (newEnergy <= 0) {
      await ref.update({ energy: 0, nestTimers: updatedTimers });
      const fastestMs = nestDetails.reduce((min, n) => Math.min(min, n.msUntilNext), Infinity);
      return res.status(400).json({
        error:      'No energy. Wait for it to regenerate.',
        energy:     0,
        maxEnergy:  totalSlots,
        nextRegenMs: fastestMs === Infinity ? null : fastestMs,
        nests:      nestDetails,
      });
    }

    const afterEnergy = newEnergy - 1;

    // If energy was full, restart timers for all nests from now
    let timersToSave = updatedTimers;
    if (newEnergy >= totalSlots) {
      const now = Date.now();
      timersToSave = {};
      for (const item of (data.inventory || [])) {
        if (item.type !== 'nest') continue;
        const cfg = ENERGY_CONFIG[item.rarity];
        if (!cfg) continue;
        timersToSave[item.id] = { nextTickAt: new Date(now + cfg.regenMs).toISOString() };
      }
    }

    await ref.update({
      energy: afterEnergy,
      nestTimers: timersToSave,
      gameStartedAt: new Date().toISOString()
    });

    // Recalculate nestDetails with updated timers
    const updatedDetails = nestDetails.map(n => {
      const t = timersToSave[n.nestId];
      if (!t) return n;
      const msUntilNext = Math.max(0, new Date(t.nextTickAt).getTime() - Date.now());
      return { ...n, nextTickAt: t.nextTickAt, msUntilNext };
    });

    const fastestMs = updatedDetails.reduce((min, n) => Math.min(min, n.msUntilNext), Infinity);

    console.log(`[/api/energy/use] uid=${uid} energy=${afterEnergy}/${totalSlots}`);
    return res.json({
      ok:         true,
      energy:     afterEnergy,
      maxEnergy:  totalSlots,
      nextRegenMs: afterEnergy < totalSlots ? (fastestMs === Infinity ? null : fastestMs) : null,
      nests:      updatedDetails,
    });
  } catch (err) {
    console.error('[/api/energy/use]', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/swap-config ──────────────────────────────────────────────────────
router.get('/swap-config', async (_req, res) => {
  try {
    const db  = getFirestore();
    const doc = await db.collection('config').doc('swap').get();
    if (doc.exists) {
      const data = doc.data();
      return res.json({
        ok:            true,
        enabled:       data.enabled        ?? true,
        eggToGoldRate: data.eggToGoldRate  ?? 100,
      });
    }
    return res.json({ ok: true, enabled: true, eggToGoldRate: 100 });
  } catch (err) {
    console.error('[/api/swap-config]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── POST /api/swap/egg-to-gold ────────────────────────────────────────────────
// User spends eggs; receives goldBalance in-game.
// Rate: admin-configured eggToGoldRate (e.g. 1 egg = 100 gold).
// 2% slippage fee deducted from gold received. Minimum: 1 egg.
router.post('/swap/egg-to-gold', requireAuth, async (req, res) => {
  try {
    const db = getFirestore();

    // Check if swap is enabled
    const swapConfigDoc = await db.collection('config').doc('swap').get();
    const swapData    = swapConfigDoc.exists ? swapConfigDoc.data() : {};
    const swapEnabled = swapData.enabled     ?? true;
    const eggToGoldRate = Number(swapData.eggToGoldRate ?? 100);

    if (!swapEnabled)
      return res.status(400).json({ error: 'Swap feature is temporarily disabled by administrator.' });

    const { eggAmount } = req.body;
    if (!Number.isInteger(eggAmount) || eggAmount <= 0)
      return res.status(400).json({ error: 'eggAmount must be a positive integer.' });

    const MIN_EGGS = 1;
    if (eggAmount < MIN_EGGS)
      return res.status(400).json({ error: `Minimum swap is ${MIN_EGGS} egg.` });

    const uid = req.user.uid;
    const ref = db.collection('users').doc(uid);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'User not found.' });

    const userData       = doc.data();
    const currentEggs    = userData.eggBalance    || 0;
    const currentGold    = userData.goldBalance   || 0;

    if (currentEggs < eggAmount)
      return res.status(400).json({
        error: `Insufficient eggs. Have ${currentEggs.toLocaleString()}, need ${eggAmount.toLocaleString()}.`
      });

    // Apply 2% slippage: fee deducted from gold received
    const SLIPPAGE   = 0.02;
    const grossGold  = Math.floor(eggAmount * eggToGoldRate);
    const feeGold    = Math.round(grossGold * SLIPPAGE);
    const netGold    = grossGold - feeGold;

    const newEggs = currentEggs - eggAmount;
    const newGold = currentGold + netGold;

    await ref.update({ eggBalance: newEggs, goldBalance: newGold });

    // Record swap history
    await db.collection('swaps').add({
      uid,
      type:       'egg-to-gold',
      eggSpent:   eggAmount,
      grossGold,
      feeGold,
      netGold,
      eggToGoldRate,
      createdAt:  new Date().toISOString(),
    });

    console.log(`[swap/egg-to-gold] uid=${uid} eggs=${eggAmount} grossGold=${grossGold} fee=${feeGold} netGold=${netGold}`);

    return res.json({
      ok:       true,
      eggSpent: eggAmount,
      feeGold,
      netGold,
      newEggs,
      newGold,
      rate:     `${eggAmount} egg${eggAmount > 1 ? 's' : ''} → ${netGold.toLocaleString()} GOLD`,
    });

  } catch (err) {
    console.error('[swap/egg-to-gold]', err);
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// ── POST /api/game/end ────────────────────────────────────────────────────────
// Gold, Seeds, and BP computed SERVER-SIDE from the registered score + nest inventory.
// Client sends { score, duration } — same values that went to /api/score.
//
// Nest-based drop rates (no gold for free-only):
//   free:      0 gold,  max 5  seeds, BP 1-20
//   common:    max 20 gold, max 15 seeds, BP 21-40
//   rare:      max 35 gold, max 25 seeds, BP 41-70
//   legendary: max 50 gold, max 40 seeds, BP 71-100
//
// Anti-cheat layers:
//   1. lastPlayedAt must be within 15 min  (real game was played)
//   2. lastGameEndAt != lastPlayedAt       (one claim per game session)
//   3. score capped to lastScore from /api/score (can't inflate via game/end)
//   4. Suspicious users flagged in Firestore for admin review
router.post('/game/end', requireAuth, async (req, res) => {
  try {
    const { score = 0, duration = 0, goldCollected = 0, seedsCollected = 0, goldItemsCollected = 0 } = req.body;

    const safeScore    = Math.max(0, Math.min(9999, Math.floor(Number(score)    || 0)));
    const safeDuration = Math.max(0, Math.min(3600, Math.floor(Number(duration) || 0)));
    const safeGold      = Math.max(0, Math.floor(Number(goldCollected) || 0));
    const safeGoldItems = Math.max(0, Math.floor(Number(goldItemsCollected) || 0));
    const safeSeeds     = Math.max(0, Math.floor(Number(seedsCollected) || 0));

    const uid = req.user.uid;
    const db  = getFirestore();
    const ref = db.collection('users').doc(uid);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'User not found.' });

    const data      = doc.data();
    const inventory = data.inventory || [];
    const nests     = inventory.filter(i => i.type === 'nest');

    const now = Date.now();

    // ── Guard 1: require a recent /api/score submission (≤ 15 min) ───────────
    const lastPlayed  = data.lastPlayedAt ? new Date(data.lastPlayedAt).getTime() : 0;
    const msSinceLast = now - lastPlayed;
    if (msSinceLast > 15 * 60 * 1000) {
      console.warn(`[game/end] BLOCKED uid=${uid} stale ${msSinceLast}ms`);
      return res.json({ ok: true, bpEarned: 0, seedsEarned: 0, goldEarned: 0, newBP: data.totalBP || 0, rewards: [], reason: 'no_recent_score' });
    }

    // ── Guard 2: one reward claim per game session ────────────────────────────
    if (data.lastGameEndAt && data.lastGameEndAt === data.lastPlayedAt) {
      console.warn(`[game/end] BLOCKED uid=${uid} duplicate claim lastPlayedAt=${data.lastPlayedAt}`);
      return res.json({ ok: true, bpEarned: 0, seedsEarned: 0, goldEarned: 0, newBP: data.totalBP || 0, rewards: [], reason: 'already_claimed' });
    }

    // ── Guard 3: block if score/gold/seeds mismatch from what /api/score registered ─────
    const registeredScore = typeof data.lastScore === 'number' ? data.lastScore : 0;
    const registeredGold  = typeof data.lastGoldCollected === 'number' ? data.lastGoldCollected : 0;
    const registeredGoldItems = typeof data.lastGoldItemsCollected === 'number' ? data.lastGoldItemsCollected : 0;
    const registeredSeeds = typeof data.lastSeedsCollected === 'number' ? data.lastSeedsCollected : 0;

    if (safeScore > registeredScore + 5 || safeGold > registeredGold + 5 || safeSeeds > registeredSeeds + 5 || safeGoldItems > registeredGoldItems + 2) {
      console.warn(`[game/end] BLOCKED uid=${uid} claimedScore=${safeScore} registeredScore=${registeredScore} claimedGold=${safeGold} registeredGold=${registeredGold} claimedSeeds=${safeSeeds} registeredSeeds=${registeredSeeds} claimedGoldItems=${safeGoldItems} registeredGoldItems=${registeredGoldItems}`);
      await ref.update({
        suspiciousFlag: true,
        suspiciousFlagAt: new Date().toISOString(),
        suspiciousReason: `Item/Score mismatch: claimed Score=${safeScore}, Gold=${safeGold}, Seeds=${safeSeeds}, GoldItems=${safeGoldItems} in /game/end, but /api/score registered Score=${registeredScore}, Gold=${registeredGold}, Seeds=${registeredSeeds}, GoldItems=${registeredGoldItems}`
      });
      return res.status(400).json({ error: 'Data mismatch: claimed rewards are inconsistent with registered gameplay data.' });
    }
    const scoreToUse = registeredScore;

    // ── Rarity drop table ─────────────────────────────────────────────────────
    const RARITY_ORDER = ['free', 'common', 'rare', 'legendary'];
    const RARITY_CFG = {
      //            seedPct goldPct  maxGold maxSeeds  BP range
      free:      { seedPct:0.02, goldPct:0,    maxGold:0,  maxSeeds:5,  bpMin:1,  bpMax:20  },
      common:    { seedPct:0.05, goldPct:0.02, maxGold:20, maxSeeds:15, bpMin:21, bpMax:40  },
      rare:      { seedPct:0.08, goldPct:0.04, maxGold:35, maxSeeds:25, bpMin:41, bpMax:70  },
      legendary: { seedPct:0.12, goldPct:0.07, maxGold:50, maxSeeds:40, bpMin:71, bpMax:100 },
    };
    const TRIPLE_BONUS = {
      common:    { seedBonus:0.01, goldBonus:0.005 },
      rare:      { seedBonus:0.02, goldBonus:0.01  },
      legendary: { seedBonus:0.03, goldBonus:0.02  },
    };
    const MAX_STACK = 3;

    // ── Nest inventory analysis ───────────────────────────────────────────────
    const counts = { free:0, common:0, rare:0, legendary:0 };
    for (const n of nests) {
      if (counts[n.rarity] !== undefined) counts[n.rarity]++;
    }

    // Rarest owned nest determines BP tier and per-game caps
    let rarestRarity = nests.length > 0 ? 'free' : null;
    for (const r of RARITY_ORDER) {
      if (counts[r] > 0) rarestRarity = r;
    }

    let bpEarned = 0, goldEarned = 0, seedsEarned = 0;

    if (rarestRarity) {
      const cfg = RARITY_CFG[rarestRarity];

      // bp is random within the rarest tier's range
      bpEarned    = Math.floor(Math.random() * (cfg.bpMax - cfg.bpMin + 1)) + cfg.bpMin;

      // Gold and seeds are based on actual items collected in the session
      goldEarned = registeredGold;
      if (registeredGoldItems > 0 && registeredGoldItems > cfg.maxGold) {
        goldEarned = Math.floor((registeredGold / registeredGoldItems) * cfg.maxGold);
      }
      seedsEarned = Math.min(registeredSeeds, cfg.maxSeeds);

      // Hard block: free-nest-only accounts get zero gold, always
      if (rarestRarity === 'free') goldEarned = 0;
    }

    // ── Persist results ───────────────────────────────────────────────────────
    const updates = {
      totalBP:        (data.totalBP || 0) + bpEarned,
      lastGameEndAt:  data.lastPlayedAt, // mark this session as claimed
    };
    if (seedsEarned > 0) updates.seeds       = (data.seeds       || 0) + seedsEarned;
    if (goldEarned  > 0) updates.goldBalance = (data.goldBalance  || 0) + goldEarned;

    await ref.update(updates);

    const rewards = [];
    if (bpEarned    > 0) rewards.push({ type:'bp',   amount:bpEarned,    label:`+${bpEarned} Battle Points` });
    if (seedsEarned > 0) rewards.push({ type:'seed', amount:seedsEarned, label:`+${seedsEarned} Seeds` });
    if (goldEarned  > 0) rewards.push({ type:'gold', amount:goldEarned,  label:`+${goldEarned} Gold` });

    console.log(`[game/end] uid=${uid} score=${scoreToUse} rarest=${rarestRarity||'none'} bp=${bpEarned} seeds=${seedsEarned} gold=${goldEarned}`);

    return res.json({ ok:true, bpEarned, seedsEarned, goldEarned, newBP:updates.totalBP, rewards });

  } catch (err) {
    console.error('[game/end]', err);
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// ── GET /api/game/rates ───────────────────────────────────────────────────────
// Returns the server-computed nest-based spawn rates for the current user.
// The game client uses these for visual collectible spawning — nothing more.
// Gold spawns are 0 for free-only accounts, matching the reward logic above.
router.get('/game/rates', requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const db  = getFirestore();
    const doc = await db.collection('users').doc(uid).get();
    if (!doc.exists) return res.status(404).json({ error: 'User not found.' });

    const inventory = (doc.data().inventory || []).filter(i => i.type === 'nest');

    const counts = { free:0, common:0, rare:0, legendary:0 };
    for (const n of inventory) {
      if (counts[n.rarity] !== undefined) counts[n.rarity]++;
    }

    const RARITY_ORDER = ['free', 'common', 'rare', 'legendary'];
    const BASE = {
      free:      { seedPct:0.02, goldPct:0    },
      common:    { seedPct:0.05, goldPct:0.02 },
      rare:      { seedPct:0.08, goldPct:0.04 },
      legendary: { seedPct:0.12, goldPct:0.07 },
    };
    const TRIPLE = {
      common:    { seedBonus:0.01, goldBonus:0.005 },
      rare:      { seedBonus:0.02, goldBonus:0.01  },
      legendary: { seedBonus:0.03, goldBonus:0.02  },
    };
    const MAX_STACK = 3;

    let rarestRarity = null;
    for (const r of RARITY_ORDER) {
      if (counts[r] > 0) rarestRarity = r;
    }

    let seedPct = 0, goldPct = 0;

    if (rarestRarity) {
      seedPct = BASE[rarestRarity].seedPct;
      goldPct = BASE[rarestRarity].goldPct;

      for (const r of ['common', 'rare', 'legendary']) {
        const stack = Math.min(counts[r], MAX_STACK);
        if (stack > 0) {
          goldPct += BASE[r].goldPct * (stack - 1);
          seedPct += BASE[r].seedPct * (stack - 1);
        }
        if (counts[r] >= MAX_STACK && TRIPLE[r]) {
          goldPct += TRIPLE[r].goldBonus;
          seedPct += TRIPLE[r].seedBonus;
        }
      }

      // Free-only: no gold spawns in-game at all
      if (rarestRarity === 'free') goldPct = 0;
    }

    return res.json({
      ok: true,
      seedPct: Math.min(parseFloat(seedPct.toFixed(4)), 1),
      goldPct: Math.min(parseFloat(goldPct.toFixed(4)), 1),
      rarestRarity,
      nestCounts: counts,
    });
  } catch (err) {
    console.error('[/api/game/rates]', err);
    return res.status(500).json({ error: 'Server error.' });
  }
});

// ── GET /api/session-check ────────────────────────────────────────────────────
// Lightweight endpoint the client polls to detect forced logout.
// Returns { valid: true } if the session token still matches Firestore.
// Returns { valid: false, reason: 'kicked' } if another device has logged in.
// Returns { valid: false, reason: 'unauthenticated' } if there is no session.
router.get('/session-check', async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.json({ valid: false, reason: 'unauthenticated' });
  }

  try {
    const uid = req.user.uid;
    const db  = getFirestore();
    const doc = await db.collection('users').doc(uid).get();

    if (!doc.exists) {
      return res.json({ valid: false, reason: 'unauthenticated' });
    }

    const { currentSessionId } = doc.data();
    // Reconstruct the sessionId stored in the cookie session
    const cookieSessionId = req.session && req.session.passport && req.session.passport.user
      ? req.session.passport.user.sessionId
      : null;

    // If both sides have a sessionId they must match
    if (currentSessionId && cookieSessionId && currentSessionId !== cookieSessionId) {
      return res.json({ valid: false, reason: 'kicked' });
    }

    return res.json({ valid: true });
  } catch (err) {
    console.error('[/api/session-check]', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── Farm / Hatchery system ────────────────────────────────────────────────────
//
// Multiple nests can be placed simultaneously. State is stored server-side
// under user.farmState[nestId] = { nextTickAt, pendingEggs }
// Timers continue ticking on the server — they accumulate between visits.
//
// Egg rates per rarity + level:
//   common    lvl3: 1 egg/1.5h  lvl4: 1 egg/1h  lvl5: 1 egg/30m
//   rare      lvl3: 2 eggs/1.5h lvl4: 2 eggs/1h lvl5: 2 eggs/30m
//   legendary lvl3: 3 eggs/1.5h lvl4: 3 eggs/1h lvl5: 3 eggs/30m

// Timer interval is the same across all rarities at the same level.
// Rarity only affects egg count per tick.
//
//   common    lvl3: 1 egg / 90 min | lvl4: 1 egg / 60 min | lvl5: 1 egg / 30 min
//   rare      lvl3: 2 eggs / 90 min | lvl4: 2 eggs / 60 min | lvl5: 2 eggs / 30 min
//   legendary lvl3: 3 eggs / 90 min | lvl4: 3 eggs / 60 min | lvl5: 3 eggs / 30 min
const FARM_EGG_RATES = {
  common:    { 3: { count:1, ms: 90*60*1000 }, 4: { count:1, ms: 60*60*1000 }, 5: { count:1, ms: 30*60*1000 } },
  rare:      { 3: { count:2, ms: 90*60*1000 }, 4: { count:2, ms: 60*60*1000 }, 5: { count:2, ms: 30*60*1000 } },
  legendary: { 3: { count:3, ms: 90*60*1000 }, 4: { count:3, ms: 60*60*1000 }, 5: { count:3, ms: 30*60*1000 } },
};

// Helper: accumulate elapsed ticks for one nest state entry
function tickNestState(nestState, rate, now) {
  let { pendingEggs = 0, nextTickAt = null } = nestState;
  if (!nextTickAt) {
    nextTickAt = new Date(now + rate.ms).toISOString();
    return { pendingEggs, nextTickAt, dirty: true };
  }
  let dirty = false;
  while (new Date(nextTickAt).getTime() <= now) {
    pendingEggs += rate.count;
    nextTickAt   = new Date(new Date(nextTickAt).getTime() + rate.ms).toISOString();
    dirty = true;
  }
  return { pendingEggs, nextTickAt, dirty };
}

// ── GET /api/farm/state — all active nests ────────────────────────────────────
// Returns state for every nest currently in the hatchery (farmState map).
router.get('/farm/state', requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const db  = getFirestore();
    const { FieldValue } = require('firebase-admin').firestore;
    const ref = db.collection('users').doc(uid);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'User not found.' });

    const data      = doc.data();
    const inventory = data.inventory || [];
    const farmState = data.farmState || {};
    const now       = Date.now();

    const updates = {};
    const result  = {};
    let accruedEggs = 0;
    const hatchedThisTick = {};

    for (const [nestId, nestState] of Object.entries(farmState)) {
      // Validate nest still exists and is eligible
      const nest = inventory.find(i => i.id === nestId && i.type === 'nest');
      if (!nest || nest.rarity === 'free' || (nest.level||0) < 3) {
        // Remove orphaned entries with FieldValue.delete()
        updates[`farmState.${nestId}`] = FieldValue.delete();
        continue;
      }
      const rate = FARM_EGG_RATES[nest.rarity]?.[nest.level||0];
      if (!rate) continue;

      let { pendingEggs: existingPending = 0 } = nestState;

      // Calculate how many new eggs have accrued since last tick
      const tickResult    = tickNestState(nestState, rate, now);
      const newlyHatched  = tickResult.pendingEggs; // includes any carry-over from nestState

      if (tickResult.dirty || existingPending > 0) {
        if (newlyHatched > 0) {
          accruedEggs += newlyHatched;
          hatchedThisTick[nestId] = newlyHatched;
        }
        updates[`farmState.${nestId}`] = { pendingEggs: 0, nextTickAt: tickResult.nextTickAt };
        result[nestId] = { pendingEggs: 0, nextTickAt: tickResult.nextTickAt };
      } else {
        result[nestId] = { pendingEggs: 0, nextTickAt: tickResult.nextTickAt };
      }
    }

    let finalEggBalance = data.eggBalance || 0;
    if (accruedEggs > 0) {
      finalEggBalance += accruedEggs;
      updates.eggBalance = finalEggBalance;
    }

    if (Object.keys(updates).length) await ref.update(updates);

    return res.json({ ok: true, farmState: result, eggBalance: finalEggBalance, hatchedThisTick });
  } catch (err) {
    console.error('[/api/farm/state]', err);
    return res.status(500).json({ error: 'Server error.' });
  }
});

// ── POST /api/farm/place — add a nest to the hatchery ─────────────────────────
router.post('/farm/place', requireAuth, async (req, res) => {
  try {
    const { nestId } = req.body;
    if (!nestId) return res.status(400).json({ error: 'nestId required.' });

    const uid = req.user.uid;
    const db  = getFirestore();
    const ref = db.collection('users').doc(uid);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'User not found.' });

    const data      = doc.data();
    const inventory = data.inventory || [];
    const nest      = inventory.find(i => i.id === nestId && i.type === 'nest');
    if (!nest) return res.status(404).json({ error: 'Nest not found.' });
    if (nest.rarity === 'free') return res.status(400).json({ error: 'Free nests cannot use the hatchery.' });
    if ((nest.level||0) < 3) return res.status(400).json({ error: 'Nest must be Lvl 3+.' });

    const rate = FARM_EGG_RATES[nest.rarity]?.[nest.level||0];
    if (!rate) return res.status(400).json({ error: 'No egg rate for this nest.' });

    const farmState = data.farmState || {};
    // If already placed, just return current state (auto-hatching any pending eggs if needed)
    if (farmState[nestId]) {
      const { pendingEggs, nextTickAt, dirty } = tickNestState(farmState[nestId], rate, Date.now());
      if (dirty || (farmState[nestId].pendingEggs || 0) > 0) {
        if (pendingEggs > 0) {
          const newEggBalance = (data.eggBalance || 0) + pendingEggs;
          await ref.update({
            [`farmState.${nestId}`]: { pendingEggs: 0, nextTickAt },
            eggBalance: newEggBalance
          });
          return res.json({ ok: true, nestId, pendingEggs: 0, nextTickAt, eggBalance: newEggBalance });
        }
      }
      return res.json({ ok: true, nestId, pendingEggs: 0, nextTickAt, eggBalance: data.eggBalance || 0 });
    }

    // Start fresh timer
    const nextTickAt = new Date(Date.now() + rate.ms).toISOString();
    await ref.update({ [`farmState.${nestId}`]: { pendingEggs: 0, nextTickAt } });

    console.log(`[farm/place] uid=${uid} nestId=${nestId}`);
    return res.json({ ok: true, nestId, pendingEggs: 0, nextTickAt, eggBalance: data.eggBalance || 0 });
  } catch (err) {
    console.error('[/api/farm/place]', err);
    return res.status(500).json({ error: 'Server error.' });
  }
});

// ── POST /api/farm/remove — remove a nest from the hatchery ──────────────────
router.post('/farm/remove', requireAuth, async (req, res) => {
  try {
    const { nestId } = req.body;
    if (!nestId) return res.status(400).json({ error: 'nestId required.' });

    const uid = req.user.uid;
    const db  = getFirestore();
    const ref = db.collection('users').doc(uid);

    // Firestore: delete the field by setting to FieldValue.delete()
    const { FieldValue } = require('firebase-admin').firestore;
    await ref.update({ [`farmState.${nestId}`]: FieldValue.delete() });

    console.log(`[farm/remove] uid=${uid} nestId=${nestId}`);
    return res.json({ ok: true, nestId });
  } catch (err) {
    console.error('[/api/farm/remove]', err);
    return res.status(500).json({ error: 'Server error.' });
  }
});

// ── POST /api/farm/hatch — REMOVED (auto-hatch handled by GET /api/farm/state) ─
// Kept as a stub so old clients don't crash with 404.
// Returns the real current eggBalance so any old UI stays accurate.
router.post('/farm/hatch', requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const db  = getFirestore();
    const doc = await db.collection('users').doc(uid).get();
    const eggBalance = doc.exists ? (doc.data().eggBalance || 0) : 0;
    return res.json({ ok: true, hatched: 0, eggBalance, message: 'Auto-hatch is active. Use GET /api/farm/state.' });
  } catch (err) {
    console.error('[/api/farm/hatch stub]', err);
    return res.status(500).json({ error: 'Server error.' });
  }
});

// ── GET /api/gold-ca ──────────────────────────────────────────────────────────
// Returns the $GOLD token contract address from .env so the frontend
// can build the pump.fun link dynamically without hardcoding the CA.
router.get('/gold-ca', (_req, res) => {
  const ca = process.env.GOLD_CA || null;
  res.json({ ca });
});

// ── POST /api/cron/cutoff ─────────────────────────────────────────────────────
// Called by cron-job.org at 11:40 AM GMT+8. Secured with x-cron-secret header.
router.post('/cron/cutoff', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers['x-cron-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  try {
    const { runCutoff, getPayoutConfig, getGmt8DateString } = require('../utils/payoutScheduler');
    const todayStr = getGmt8DateString();
    const config   = await getPayoutConfig();
    if (config.lastCutoffDate === todayStr) {
      console.log('[cron/cutoff] Already ran today, skipping.');
      return res.json({ ok: true, skipped: true, reason: 'Already ran today.' });
    }
    const result = await runCutoff();
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[cron/cutoff]', err);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/cron/payout ─────────────────────────────────────────────────────
// Called by cron-job.org at 12:00 PM GMT+8. Secured with x-cron-secret header.
router.post('/cron/payout', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers['x-cron-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  try {
    const { runPayout, getPayoutConfig, getGmt8DateString } = require('../utils/payoutScheduler');
    const todayStr = getGmt8DateString();
    const config   = await getPayoutConfig();
    if (config.lastPayoutDate === todayStr) {
      console.log('[cron/payout] Already ran today, skipping.');
      return res.json({ ok: true, skipped: true, reason: 'Already ran today.' });
    }
    if (!config.autoApproval) {
      console.log('[cron/payout] Auto-approval is OFF — skipping.');
      return res.json({ ok: true, skipped: true, reason: 'Auto-approval is OFF.' });
    }
    const result = await runPayout();
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[cron/payout]', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;

