const express          = require('express');
const router           = express.Router();
const { getFirestore } = require('../config/firebase');
const {
  Connection, PublicKey, LAMPORTS_PER_SOL,
  SystemProgram, Transaction, Keypair, sendAndConfirmTransaction
} = require('@solana/web3.js');
const bs58        = require('bs58');
const { decrypt } = require('../utils/wallet');

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
    const { score, duration } = req.body;
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

    // Rate limit: minimum 30 seconds between score submissions (read from Firestore)
    const MIN_GAME_MS = 30 * 1000;
    const lastPlayed  = data.lastPlayedAt ? new Date(data.lastPlayedAt).getTime() : 0;
    if (Date.now() - lastPlayed < MIN_GAME_MS)
      return res.status(429).json({ error: 'Please wait before submitting another score.' });

    const prevBest = data.highScore ?? 0;
    const newBest  = Math.max(score, prevBest);

    // EXP Calculation: base EXP on duration and score (always random 1-10 EXP)
    const playDuration = typeof duration === 'number' && isFinite(duration) ? Math.max(0, duration) : 0;
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
      highScore:          newBest,
      totalScore:         (data.totalScore || 0) + score, // cumulative — used for leaderboard ranking
      currentExp,
      requiredExp,
      level,
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
// Returns live SOL/PHP price from CoinGecko + computed $GOLD prices per nest.
// 1 $GOLD = 1 PHP. Gold price = floor(nestSOLPrice * solPHP).
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

    const data = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=php');
    const solPhp = data?.solana?.php;

    if (!solPhp || typeof solPhp !== 'number') {
      return res.status(502).json({ error: 'Could not fetch SOL price.' });
    }

    // Get nest SOL prices (dynamic or defaults)
    const catalog = await getNestCatalog();

    return res.json({
      ok: true,
      solPhp,
      gold: {
        common:    Math.floor(catalog.common.price    * solPhp),
        rare:      Math.floor(catalog.rare.price      * solPhp),
        legendary: Math.floor(catalog.legendary.price * solPhp),
      },
    });
  } catch (err) {
    console.error('[/api/marketplace/sol-php]', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/marketplace/buy-nest-gold ──────────────────────────────────────
// Purchase a nest using $GOLD balance. Gold price = floor(nestSOLPrice * solPHP).
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

    const catalog      = await getNestCatalog();
    const nestInfo     = catalog[rarity];
    const goldRequired = Math.floor(nestInfo.price * solPhp);

    // ── Check gold balance ────────────────────────────────────────────────
    const currentGold = userData.goldBalance || 0;
    if (currentGold < goldRequired) {
      return res.status(400).json({
        error: `Insufficient $GOLD. Need ${goldRequired.toLocaleString()}, you have ${currentGold.toLocaleString()}.`
      });
    }

    // ── Deduct gold and add item ──────────────────────────────────────────
    const tag4    = String(Math.floor(1000 + Math.random() * 9000));
    const nestTag = `${nestInfo.baseName}#${tag4}`;

    const newNestItem = {
      id:          `nest_${Date.now()}_${tag4}`,
      type:        'nest',
      rarity,
      baseName:    nestInfo.baseName,
      nestTag,
      priceSol:    nestInfo.price,
      priceGold:   goldRequired,
      paymentMethod: 'gold',
      purchasedAt: new Date().toISOString(),
      image:       `images/nest/${rarity}.png`,
    };

    const currentInventory = userData.inventory || [];
    currentInventory.push(newNestItem);
    const newGold = currentGold - goldRequired;

    // ── Add nest's slots as full energy immediately on purchase ──────────
    const newNestCfg    = ENERGY_CONFIG[rarity];
    const newNestSlots  = newNestCfg ? newNestCfg.slotBonus : 0;
    const newNestRegenMs = newNestCfg ? newNestCfg.regenMs : 86400000;

    // Recalculate total slots from the updated inventory
    let newTotalSlots = BASE_ENERGY_SLOTS;
    for (const item of currentInventory) {
      if (item.type !== 'nest') continue;
      const cfg = ENERGY_CONFIG[item.rarity];
      if (cfg) newTotalSlots += cfg.slotBonus;
    }

    // Current energy + the new nest's slot bonus, capped at new total
    const currentEnergy = typeof userData.energy === 'number' ? userData.energy : 0;
    const newEnergy = Math.min(currentEnergy + newNestSlots, newTotalSlots);

    // Add a nestTimer for the new nest — already full, so next tick starts now + regenMs
    const nestTimers = { ...(userData.nestTimers || {}), [newNestItem.id]: { nextTickAt: new Date(Date.now() + newNestRegenMs).toISOString() } };

    await ref.update({ inventory: currentInventory, goldBalance: newGold, energy: newEnergy, nestTimers });

    console.log(`[buy-nest-gold] uid=${uid} bought ${nestTag} rarity=${rarity} goldSpent=${goldRequired} goldLeft=${newGold} energy=${newEnergy}/${newTotalSlots}`);

    return res.json({ ok: true, nestTag, newGold });

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

    // ── Add nest's slots as full energy immediately on purchase ──────────
    const newNestCfg     = ENERGY_CONFIG[rarity];
    const newNestSlots   = newNestCfg ? newNestCfg.slotBonus : 0;
    const newNestRegenMs = newNestCfg ? newNestCfg.regenMs : 86400000;

    let newTotalSlots = BASE_ENERGY_SLOTS;
    for (const item of currentInventory) {
      if (item.type !== 'nest') continue;
      const cfg = ENERGY_CONFIG[item.rarity];
      if (cfg) newTotalSlots += cfg.slotBonus;
    }

    const currentEnergy = typeof userData.energy === 'number' ? userData.energy : 0;
    const newEnergy = Math.min(currentEnergy + newNestSlots, newTotalSlots);
    const nestTimers = { ...(userData.nestTimers || {}), [newNestItem.id]: { nextTickAt: new Date(Date.now() + newNestRegenMs).toISOString() } };

    await ref.update({
      inventory: currentInventory,
      energy: newEnergy,
      nestTimers,
      ...(newBalance !== null ? { walletBalance: newBalance } : {}),
    });

    console.log(`[buy-nest] uid=${uid} bought ${nestTag} rarity=${rarity} tx=${txSignature} energy=${newEnergy}/${newTotalSlots}`);

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
// Slot rules (total capacity):
//   Base:      20 slots always (all users)
//   free:       +0 slots, 1 energy per 4 hours
//   common:     +0 slots, 1 energy per 1.5 hours
//   rare:      +10 slots, 1 energy per 1 hour
//   legendary: +20 slots, 1 energy per 30 minutes
//
// Example: user has 1 common + 1 rare → 20 (base) + 0 + 10 = 30 slots
// Example: user has 1 rare + 1 common + 1 legendary → 20 + 10 + 20 = 50 slots
//
// Each nest generates energy independently on its own schedule.
// Timers stored as absolute ISO timestamps in Firestore — survive logout/device switch.

const ENERGY_CONFIG = {
  free:      { slotBonus: 0,  regenMs:  4 * 60 * 60 * 1000 },   //  4 h
  common:    { slotBonus: 0,  regenMs: 1.5 * 60 * 60 * 1000 },  // 1.5 h
  rare:      { slotBonus: 10, regenMs:       60 * 60 * 1000 },   //  1 h
  legendary: { slotBonus: 20, regenMs:  0.5 * 60 * 60 * 1000 }, // 30 min
};

const BASE_ENERGY_SLOTS = 20; // every user always has at least 20 slots

/**
 * Calculate total energy capacity from a user's inventory.
 * Base 20 + 10 per rare + 20 per legendary owned.
 */
function calcTotalSlots(inventory = []) {
  let bonus = 0;
  for (const item of inventory) {
    if (item.type !== 'nest') continue;
    const cfg = ENERGY_CONFIG[item.rarity];
    if (cfg) bonus += cfg.slotBonus;
  }
  return BASE_ENERGY_SLOTS + bonus;
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
    // If we're now full, pause this nest's timer (don't advance further)
    if (energy >= totalSlots) {
      // Keep nextTickAt at the last-calculated value so timer resumes correctly
      // after energy is consumed
      updatedTimers[nestId] = { nextTickAt: new Date(nextTick).toISOString() };
    } else {
      updatedTimers[nestId] = { nextTickAt: new Date(nextTick).toISOString() };
    }

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

    await ref.update({ energy: afterEnergy, nestTimers: timersToSave });

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

// ── POST /api/swap/gold-to-sol ────────────────────────────────────────────────
// User burns $GOLD; backend sends real SOL from store wallet to user's wallet.
// Rate: 1 GOLD = 1 PHP. SOL/PHP fetched live from CoinGecko.
// 2% slippage fee applied. Minimum: 102 GOLD.
router.post('/swap/gold-to-sol', requireAuth, async (req, res) => {
  try {
    const { goldAmount } = req.body;

    if (!Number.isInteger(goldAmount) || goldAmount <= 0)
      return res.status(400).json({ error: 'goldAmount must be a positive integer.' });

    const MIN_GOLD = 102;
    if (goldAmount < MIN_GOLD)
      return res.status(400).json({ error: `Minimum swap is ${MIN_GOLD} GOLD.` });

    const uid = req.user.uid;
    const db  = getFirestore();
    const ref = db.collection('users').doc(uid);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'User not found.' });

    const userData    = doc.data();
    const currentGold = userData.goldBalance || 0;

    if (currentGold < goldAmount)
      return res.status(400).json({
        error: `Insufficient GOLD. Have ${currentGold.toLocaleString()}, need ${goldAmount.toLocaleString()}.`
      });

    // ── Fetch live SOL/PHP price ──────────────────────────────────────────
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
      console.error('[swap/gold-to-sol] CoinGecko error:', e);
    }

    if (!solPhp || typeof solPhp !== 'number')
      return res.status(502).json({ error: 'Could not fetch live SOL price. Try again shortly.' });

    // Apply 2% slippage fee: user pays goldAmount, gets 98% worth of SOL
    // 1 GOLD = 1 PHP → effectiveGold PHP ÷ solPhp = SOL to send
    const SLIPPAGE      = 0.02;
    const effectiveGold = goldAmount * (1 - SLIPPAGE); // 98% of gold value
    const solAmount     = effectiveGold / solPhp;       // convert PHP → SOL
    const lamports      = Math.floor(solAmount * LAMPORTS_PER_SOL);

    if (lamports <= 0)
      return res.status(400).json({ error: 'Swap amount too small to produce any SOL.' });

    // ── Load store wallet keypair ─────────────────────────────────────────
    const storePrivKeyB58 = process.env.STORE_WALLET_PRIVATE_KEY;
    if (!storePrivKeyB58) {
      console.error('[swap/gold-to-sol] STORE_WALLET_PRIVATE_KEY not set in .env');
      return res.status(500).json({ error: 'Store wallet not configured.' });
    }

    let storeKeypair;
    try {
      storeKeypair = Keypair.fromSecretKey(bs58.decode(storePrivKeyB58));
    } catch (e) {
      console.error('[swap/gold-to-sol] Invalid store keypair:', e);
      return res.status(500).json({ error: 'Store wallet key invalid.' });
    }

    // ── Check store wallet balance ────────────────────────────────────────
    const connection   = getSolanaConnection();
    const storeBalance = await connection.getBalance(storeKeypair.publicKey);
    const feeCushion   = 5000; // ~0.000005 SOL for tx fee

    if (storeBalance < lamports + feeCushion) {
      console.error(`[swap/gold-to-sol] Store wallet low: ${storeBalance} lamports, needs ${lamports + feeCushion}`);
      return res.status(503).json({ error: 'Congested transaction, please try again later.' });
    }

    // ── Get user wallet address ───────────────────────────────────────────
    let userWalletAddress;
    try {
      userWalletAddress = userData.walletPublicKey ? decrypt(userData.walletPublicKey) : null;
    } catch {
      userWalletAddress = userData.walletPublicKey || null;
    }

    if (!userWalletAddress)
      return res.status(400).json({ error: 'No wallet address found for this account.' });

    const userPubkey = new PublicKey(userWalletAddress);

    // ── Deduct GOLD first (prevents double-spend) ─────────────────────────
    const newGold = currentGold - goldAmount;
    await ref.update({ goldBalance: newGold });

    // ── Send SOL from store wallet → user wallet ──────────────────────────
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: storeKeypair.publicKey,
        toPubkey:   userPubkey,
        lamports,
      })
    );

    let txSignature;
    try {
      txSignature = await sendAndConfirmTransaction(
        connection, transaction, [storeKeypair], { commitment: 'confirmed' }
      );
    } catch (txErr) {
      // TX failed — refund the gold
      console.error('[swap/gold-to-sol] TX failed, refunding gold:', txErr);
      await ref.update({ goldBalance: currentGold });
      return res.status(400).json({
        error: 'Solana transaction failed: ' + (txErr.message || 'Unknown error')
      });
    }

    // ── Record swap history ───────────────────────────────────────────────
    await db.collection('swaps').add({
      uid,
      goldBurned:  goldAmount,
      feeGold:     Math.round(goldAmount * SLIPPAGE),
      solSent:     solAmount,
      lamports,
      solPhp,
      txSignature,
      toWallet:    userWalletAddress,
      createdAt:   new Date().toISOString(),
    });

    console.log(`[swap/gold-to-sol] uid=${uid} goldBurned=${goldAmount} solSent=${solAmount.toFixed(6)} tx=${txSignature}`);

    return res.json({
      ok:         true,
      goldBurned: goldAmount,
      feeGold:    Math.round(goldAmount * SLIPPAGE),
      solSent:    parseFloat(solAmount.toFixed(6)),
      newGold,
      txSignature,
      rate:       `${goldAmount} GOLD → ${solAmount.toFixed(6)} SOL`,
    });

  } catch (err) {
    console.error('[swap/gold-to-sol]', err);
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// ── POST /api/game/end ────────────────────────────────────────────────────────
// Called when a play-to-earn game ends.
// Seeds & Gold: physically collected in-game (pipe spawns driven by nest rates).
// BP: awarded at game end based on rarest nest owned.
// Drop rates per nest rarity (stacking):
//   free:      seeds 2%,  gold 0.5%
//   common:    seeds 10%, gold 5%
//   rare:      seeds 15%, gold 10%
//   legendary: seeds 25%, gold 17%
// Triple-rarity bonus (3+ same rarity):
//   common×3+:    +5% seeds, +2% gold
//   rare×3+:      +7% seeds, +5% gold
//   legendary×3+: +10% seeds, +7% gold
// BP range by rarest nest: free 1-20 | common 21-40 | rare 41-70 | legendary 71-100
router.post('/game/end', requireAuth, async (req, res) => {
  try {
    const { seedsCollected = 0, goldCollected = 0 } = req.body;

    // Cap to prevent abuse (max 50 of each per game)
    const safeSeeds = Math.min(Math.max(0, Math.floor(Number(seedsCollected) || 0)), 50);
    const safeGold  = Math.min(Math.max(0, Math.floor(Number(goldCollected)  || 0)), 50);

    const uid = req.user.uid;
    const db  = getFirestore();
    const ref = db.collection('users').doc(uid);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'User not found.' });

    const data      = doc.data();
    const inventory = data.inventory || [];
    const nests     = inventory.filter(i => i.type === 'nest');

    // ── Rarity configs ────────────────────────────────────────────────────
    const RARITY_ORDER = ['free', 'common', 'rare', 'legendary'];
    const RARITY_CFG = {
      free:      { seedPct: 0.02,  goldPct: 0,     bpMin: 1,  bpMax: 20  },
      common:    { seedPct: 0.10,  goldPct: 0.05,  bpMin: 21, bpMax: 40  },
      rare:      { seedPct: 0.15,  goldPct: 0.10,  bpMin: 41, bpMax: 70  },
      legendary: { seedPct: 0.25,  goldPct: 0.17,  bpMin: 71, bpMax: 100 },
    };
    const TRIPLE_BONUS = {
      common:    { seedBonus: 0.05, goldBonus: 0.02 },
      rare:      { seedBonus: 0.07, goldBonus: 0.05 },
      legendary: { seedBonus: 0.10, goldBonus: 0.07 },
    };

    let bpEarned = 0;

    if (nests.length > 0) {
      const counts = { free: 0, common: 0, rare: 0, legendary: 0 };
      for (const n of nests) {
        if (counts[n.rarity] !== undefined) counts[n.rarity]++;
      }

      // BP: determined by rarest nest
      let rarestRarity = 'free';
      for (const r of RARITY_ORDER) {
        if (counts[r] > 0) rarestRarity = r;
      }
      const bpCfg = RARITY_CFG[rarestRarity];
      bpEarned = Math.floor(Math.random() * (bpCfg.bpMax - bpCfg.bpMin + 1)) + bpCfg.bpMin;
    }

    // ── Save to Firestore ─────────────────────────────────────────────────
    const updates = {
      totalBP: (data.totalBP || 0) + bpEarned,
    };
    if (safeSeeds > 0) updates.seeds       = (data.seeds       || 0) + safeSeeds;
    if (safeGold  > 0) updates.goldBalance = (data.goldBalance  || 0) + safeGold;

    await ref.update(updates);

    // ── Build reward summary ──────────────────────────────────────────────
    const rewards = [];
    if (bpEarned  > 0) rewards.push({ type: 'bp',   amount: bpEarned,  label: `+${bpEarned} Battle Points` });
    if (safeSeeds > 0) rewards.push({ type: 'seed',  amount: safeSeeds, label: `+${safeSeeds} Seeds` });
    if (safeGold  > 0) rewards.push({ type: 'gold',  amount: safeGold,  label: `+${safeGold} Gold` });

    console.log(`[game/end] uid=${uid} bp=${bpEarned} seeds=${safeSeeds} gold=${safeGold}`);

    return res.json({
      ok:          true,
      bpEarned,
      seedsEarned: safeSeeds,
      goldEarned:  safeGold,
      newBP:       updates.totalBP,
      rewards,
    });

  } catch (err) {
    console.error('[game/end]', err);
    return res.status(500).json({ error: 'Server error: ' + err.message });
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

module.exports = router;

