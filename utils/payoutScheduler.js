/**
 * utils/payoutScheduler.js
 * Implements the daily cutoff (11:40 AM GMT+8) and payout (12:00 PM GMT+8) logic.
 * Toggled auto/manual and logged in Firestore config/payout.
 */

const { getFirestore } = require('../config/firebase');
const { Connection, Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');
const { decrypt } = require('./wallet');
const { getSPLTokenBalance, transferSPLToken } = require('./solanaToken');

// Solana connection configuration
function getSolanaConnection() {
  const rpc = process.env.SOLANA_RPC_URL
    || (process.env.SOLANA_NETWORK === 'devnet'
      ? 'https://api.devnet.solana.com'
      : 'https://api.mainnet-beta.solana.com');
  return new Connection(rpc, 'confirmed');
}

/**
 * Helper to get the current date string in GMT+8 (YYYY-MM-DD).
 */
function getGmt8DateString(date = new Date()) {
  // Convert standard date to GMT+8 time
  const gmt8OffsetMs = 8 * 60 * 60 * 1000;
  const utcMs = date.getTime() + (date.getTimezoneOffset() * 60000);
  const gmt8Date = new Date(utcMs + gmt8OffsetMs);
  
  const yyyy = gmt8Date.getFullYear();
  const mm = String(gmt8Date.getMonth() + 1).padStart(2, '0');
  const dd = String(gmt8Date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Gets the payout configuration from Firestore.
 */
async function getPayoutConfig() {
  try {
    const db = getFirestore();
    const doc = await db.collection('config').doc('payout').get();
    if (doc.exists) {
      const data = doc.data();
      return {
        autoApproval:    data.autoApproval    ?? true,
        lastCutoffDate:  data.lastCutoffDate  || '',
        lastPayoutDate:  data.lastPayoutDate  || '',
        updatedAt:       data.updatedAt       || null,
      };
    }
    // Return default if not exists
    return {
      autoApproval:    true,
      lastCutoffDate:  '',
      lastPayoutDate:  '',
      updatedAt:       null,
    };
  } catch (err) {
    console.error('[getPayoutConfig] Error fetching payout config:', err);
    return { autoApproval: true, lastCutoffDate: '', lastPayoutDate: '' };
  }
}

/**
 * Updates the payout configuration in Firestore.
 */
async function updatePayoutConfig(updates) {
  try {
    const db = getFirestore();
    await db.collection('config').doc('payout').set(
      {
        ...updates,
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );
    return true;
  } catch (err) {
    console.error('[updatePayoutConfig] Error updating payout config:', err);
    return false;
  }
}

/**
 * Freezes the current user goldBalance as of the daily cutoff time (11:40 AM GMT+8)
 * by snapshotting it into payoutPendingBalance.
 */
async function runCutoff() {
  console.log('[payoutScheduler] Starting daily cutoff snapshot (11:40 AM GMT+8)...');
  try {
    const db = getFirestore();
    const snap = await db.collection('users').where('goldBalance', '>', 0).get();
    
    if (snap.empty) {
      console.log('[payoutScheduler] No users with positive gold balance to cutoff.');
      const todayStr = getGmt8DateString();
      await updatePayoutConfig({ lastCutoffDate: todayStr });
      return { success: true, count: 0 };
    }

    const batch = db.batch();
    let count = 0;

    snap.docs.forEach(doc => {
      const d = doc.data();
      if (d.suspiciousFlag) {
        console.log(`[payoutScheduler] Skipping cutoff snapshot for suspicious user uid=${doc.id}`);
        return;
      }
      const currentGold = d.goldBalance || 0;
      batch.update(doc.ref, {
        payoutPendingBalance: currentGold
      });
      count++;
    });

    await batch.commit();
    const todayStr = getGmt8DateString();
    await updatePayoutConfig({ lastCutoffDate: todayStr });
    
    console.log(`[payoutScheduler] Daily cutoff completed. Snapshotted payoutPendingBalance for ${count} users.`);
    return { success: true, count };
  } catch (err) {
    console.error('[payoutScheduler] Error running daily cutoff:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Processes on-chain payouts of GOLD tokens from Treasury Wallet to user wallets.
 * Paid amounts are deducted from goldBalance and payoutPendingBalance in Firestore.
 */
async function runPayout() {
  console.log('[payoutScheduler] Starting GOLD token payout run (12:00 PM GMT+8)...');
  const results = [];
  try {
    const db = getFirestore();
    const snap = await db.collection('users').where('payoutPendingBalance', '>', 0).get();

    if (snap.empty) {
      console.log('[payoutScheduler] No users with pending payout balance.');
      const todayStr = getGmt8DateString();
      await updatePayoutConfig({ lastPayoutDate: todayStr });
      return { success: true, count: 0, results };
    }

    // Load Treasury Keypair
    const treasuryPrivKeyB58 = process.env.TREASURY_WALLET_PRIVATE_KEY;
    if (!treasuryPrivKeyB58) {
      throw new Error('TREASURY_WALLET_PRIVATE_KEY not set in environment.');
    }

    const treasuryKeypair = Keypair.fromSecretKey(bs58.decode(treasuryPrivKeyB58));
    const connection = getSolanaConnection();
    const goldCA = process.env.GOLD_CA || '3KSojyU77i1D6DRqDnUhPvM2kWjuF6VFYHcL6Lzjpump';

    // Verify treasury token balance before proceeding
    const treasuryAddress = treasuryKeypair.publicKey.toBase58();
    const treasuryBalance = await getSPLTokenBalance(connection, treasuryAddress, goldCA);
    console.log(`[payoutScheduler] Treasury address: ${treasuryAddress}, Balance: ${treasuryBalance.toLocaleString()} GOLD`);

    let totalPending = 0;
    snap.docs.forEach(doc => {
      totalPending += doc.data().payoutPendingBalance || 0;
    });

    if (treasuryBalance < totalPending) {
      console.warn(`[payoutScheduler] WARNING: Treasury has insufficient tokens. Pending: ${totalPending}, Have: ${treasuryBalance}. Executing what we can.`);
    }

    let processedCount = 0;

    for (const doc of snap.docs) {
      const uid = doc.id;
      const d = doc.data();
      const amount = d.payoutPendingBalance || 0;
      
      if (d.suspiciousFlag) {
        console.warn(`[payoutScheduler] Skipping payout for suspicious user uid=${uid}`);
        results.push({ uid, amount, status: 'failed', error: 'Suspicious user flag active' });
        continue;
      }
      
      let recipientAddress = null;
      try {
        recipientAddress = d.walletPublicKey ? decrypt(d.walletPublicKey) : null;
      } catch {
        recipientAddress = d.walletPublicKey || null;
      }

      if (!recipientAddress) {
        console.warn(`[payoutScheduler] Skipping user uid=${uid}: No wallet address.`);
        results.push({ uid, amount, status: 'failed', error: 'No wallet address' });
        continue;
      }

      console.log(`[payoutScheduler] Processing payout of ${amount} GOLD to uid=${uid} address=${recipientAddress}...`);
      
      try {
        const txSig = await transferSPLToken(
          connection,
          treasuryKeypair,
          recipientAddress,
          goldCA,
          amount
        );

        console.log(`[payoutScheduler] Success! tx=${txSig}`);
        
        // Payout succeeded, deduct from database
        const newGoldBalance = Math.max(0, (d.goldBalance || 0) - amount);
        
        await doc.ref.update({
          goldBalance: newGoldBalance,
          payoutPendingBalance: 0,
          lastPayoutTx: txSig,
          lastPayoutAt: new Date().toISOString()
        });

        results.push({ uid, amount, status: 'success', txSignature: txSig });
        processedCount++;
      } catch (txErr) {
        console.error(`[payoutScheduler] Failed payout to uid=${uid}:`, txErr.message);
        results.push({ uid, amount, status: 'failed', error: txErr.message });
      }
    }

    const todayStr = getGmt8DateString();
    await updatePayoutConfig({ lastPayoutDate: todayStr });

    console.log(`[payoutScheduler] Payout run completed. Successfully processed ${processedCount}/${snap.docs.length} payouts.`);
    return { success: true, count: processedCount, results };
  } catch (err) {
    console.error('[payoutScheduler] Critical error in daily payout:', err);
    return { success: false, error: err.message, results };
  }
}

/**
 * Checks schedule against current UTC time.
 * Daily Cutoff: 11:40 AM GMT+8 -> 03:40 AM UTC
 * Daily Payout: 12:00 PM GMT+8 -> 04:00 AM UTC
 */
async function checkSchedule() {
  try {
    const now = new Date();
    const utcHours = now.getUTCHours();
    const utcMinutes = now.getUTCMinutes();
    
    // Format current GMT+8 date string
    const todayStr = getGmt8DateString(now);
    
    // Daily Cutoff check at 03:40 UTC
    if (utcHours === 3 && utcMinutes === 40) {
      const config = await getPayoutConfig();
      if (config.lastCutoffDate !== todayStr) {
        await runCutoff();
      }
    }

    // Daily Payout check at 04:00 UTC
    if (utcHours === 4 && utcMinutes === 0) {
      const config = await getPayoutConfig();
      if (config.lastPayoutDate !== todayStr) {
        if (config.autoApproval) {
          await runPayout();
        } else {
          console.log('[payoutScheduler] Auto-approval is OFF. Skipping daily auto-payout at 12:00 PM GMT+8.');
        }
      }
    }
  } catch (err) {
    console.error('[payoutScheduler] Error in checkSchedule interval:', err);
  }
}

module.exports = {
  getPayoutConfig,
  updatePayoutConfig,
  runCutoff,
  runPayout,
  checkSchedule,
  getGmt8DateString
};
