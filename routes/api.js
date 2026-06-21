const express          = require('express');
const router           = express.Router();
const { getFirestore } = require('../config/firebase');
const {
  Connection, PublicKey, LAMPORTS_PER_SOL,
  SystemProgram, Transaction, Keypair, sendAndConfirmTransaction
} = require('@solana/web3.js');
const bs58        = require('bs58').default;
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

    const data     = doc.data();
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
      // Always write highScore — initializes it for SSO users who don't have
      // the field yet, and updates it when a new best is achieved.
      highScore: newBest,
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
router.get('/leaderboard', async (_req, res) => {
  try {
    const db   = getFirestore();
    const snap = await db.collection('users')
      .orderBy('highScore', 'desc')
      .limit(10)
      .get();

    const board = snap.docs.map((d, i) => {
      const { name, avatar, highScore, rank, selectedBird, walletPublicKey } = d.data();
      
      let walletAddress = null;
      if (walletPublicKey) {
        try {
          walletAddress = decrypt(walletPublicKey);
        } catch {
          if (!walletPublicKey.includes(':')) {
            walletAddress = walletPublicKey;
          }
        }
      }

      let displayName = name || 'Player';
      if (walletAddress && walletAddress.length > 12) {
        displayName = walletAddress.slice(0, 8) + '....' + walletAddress.slice(-4);
      }
      return {
        rank:         i + 1,
        name:         displayName,
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

    await ref.update({ inventory: currentInventory, goldBalance: newGold });

    console.log(`[buy-nest-gold] uid=${uid} bought ${nestTag} rarity=${rarity} goldSpent=${goldRequired} goldLeft=${newGold}`);

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

    await ref.update({
      inventory: currentInventory,
      ...(newBalance !== null ? { walletBalance: newBalance } : {}),
    });

    console.log(`[buy-nest] uid=${uid} bought ${nestTag} rarity=${rarity} tx=${txSignature}`);

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

module.exports = router;

