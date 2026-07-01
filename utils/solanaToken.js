/**
 * utils/solanaToken.js
 * Utility helper functions for Solana SPL Token operations.
 * Works natively with @solana/web3.js without needing extra libraries.
 */

const {
  PublicKey,
  Transaction,
  SystemProgram,
  TransactionInstruction,
  sendAndConfirmTransaction
} = require('@solana/web3.js');

const SPL_ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const RENT_SYSVAR_ID = new PublicKey('SysvarRent111111111111111111111111111111111');

/**
 * Dynamically queries the owner program of the mint (Token or Token-2022).
 */
async function getMintTokenProgramId(connection, mintPubkey) {
  try {
    const info = await connection.getAccountInfo(mintPubkey);
    if (info && info.owner.toBase58() === TOKEN_2022_PROGRAM_ID.toBase58()) {
      return TOKEN_2022_PROGRAM_ID;
    }
  } catch (err) {
    console.error('[getMintTokenProgramId] Error querying mint owner, defaulting to standard Token Program:', err);
  }
  return TOKEN_PROGRAM_ID;
}

/**
 * Derives the Associated Token Account (ATA) address for a given owner and mint.
 */
function getAssociatedTokenAddress(mint, owner, tokenProgramId = TOKEN_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgramId.toBuffer(), mint.toBuffer()],
    SPL_ASSOCIATED_TOKEN_PROGRAM_ID
  )[0];
}

/**
 * Creates a TransactionInstruction to initialize/create the Associated Token Account.
 */
function createAssociatedTokenAccountInstruction(payer, associatedToken, owner, mint, tokenProgramId = TOKEN_PROGRAM_ID) {
  return new TransactionInstruction({
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: associatedToken, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgramId, isSigner: false, isWritable: false },
      { pubkey: RENT_SYSVAR_ID, isSigner: false, isWritable: false },
    ],
    programId: SPL_ASSOCIATED_TOKEN_PROGRAM_ID,
    data: Buffer.alloc(0),
  });
}

/**
 * Creates a TransactionInstruction to transfer SPL tokens.
 */
function createTransferInstruction(source, destination, owner, amount, tokenProgramId = TOKEN_PROGRAM_ID) {
  const data = Buffer.alloc(9);
  data.writeUInt8(3, 0); // 3 = Transfer instruction
  
  // Write amount as 64-bit unsigned integer in little endian
  const lo = Number(BigInt(amount) & 0xffffffffn);
  const hi = Number((BigInt(amount) >> 32n) & 0xffffffffn);
  data.writeUInt32LE(lo, 1);
  data.writeUInt32LE(hi, 5);

  return new TransactionInstruction({
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    programId: tokenProgramId,
    data,
  });
}

/**
 * Gets the token supply decimals dynamically.
 */
async function getTokenDecimals(connection, mintPubkey) {
  try {
    const supply = await connection.getTokenSupply(mintPubkey);
    return supply.value.decimals;
  } catch (err) {
    console.error('[getTokenDecimals] Error fetching token supply decimals, defaulting to 6:', err);
    return 6; // Standard pump.fun decimals is 6
  }
}

/**
 * Gets the SPL token balance for a given wallet and mint address.
 * Returns the human-readable UI amount (e.g. 100.5).
 */
async function getSPLTokenBalance(connection, walletAddress, tokenMintAddress) {
  try {
    const pubkey = new PublicKey(walletAddress);
    const mint = new PublicKey(tokenMintAddress);
    const accounts = await connection.getParsedTokenAccountsByOwner(pubkey, { mint });
    
    if (accounts.value.length === 0) return 0;
    
    let balance = 0;
    for (const acc of accounts.value) {
      const amount = acc.account.data.parsed.info.tokenAmount.uiAmount;
      if (amount) balance += amount;
    }
    return balance;
  } catch (err) {
    console.error(`[getSPLTokenBalance] Error checking balance for ${walletAddress}:`, err.message);
    return 0;
  }
}

/**
 * Transfers SPL tokens from sender Keypair to recipient address.
 * If recipient ATA doesn't exist, it is created.
 */
async function transferSPLToken(connection, senderKeypair, recipientAddress, mintAddress, amountTokens) {
  const mint = new PublicKey(mintAddress);
  const recipient = new PublicKey(recipientAddress);
  const sender = senderKeypair.publicKey;

  // Dynamically resolve correct Token Program ID for the mint
  const tokenProgramId = await getMintTokenProgramId(connection, mint);

  const senderATA = getAssociatedTokenAddress(mint, sender, tokenProgramId);
  const recipientATA = getAssociatedTokenAddress(mint, recipient, tokenProgramId);

  const transaction = new Transaction();

  // Check if recipient token account exists
  const recipientAccountInfo = await connection.getAccountInfo(recipientATA);
  if (!recipientAccountInfo) {
    console.log(`[transferSPLToken] Recipient Associated Token Account does not exist. Adding create instruction...`);
    transaction.add(
      createAssociatedTokenAccountInstruction(sender, recipientATA, recipient, mint, tokenProgramId)
    );
  }

  // Get token decimals
  const decimals = await getTokenDecimals(connection, mint);
  const baseAmount = BigInt(Math.floor(amountTokens * Math.pow(10, decimals)));

  // Add transfer instruction
  transaction.add(
    createTransferInstruction(senderATA, recipientATA, sender, baseAmount, tokenProgramId)
  );

  // Send and confirm
  try {
    const signature = await sendAndConfirmTransaction(
      connection,
      transaction,
      [senderKeypair],
      { commitment: 'confirmed' }
    );
    return signature;
  } catch (txErr) {
    let detailMsg = txErr.message;
    let logsList = null;
    if (txErr.logs) {
      logsList = txErr.logs;
    } else if (typeof txErr.getLogs === 'function') {
      logsList = txErr.getLogs();
    }
    if (logsList) {
      console.error('[transferSPLToken] Transaction logs:', logsList);
      detailMsg += ` | Logs: ${JSON.stringify(logsList)}`;
    }
    const newErr = new Error(detailMsg);
    newErr.logs = logsList;
    throw newErr;
  }
}

module.exports = {
  getAssociatedTokenAddress,
  getSPLTokenBalance,
  transferSPLToken,
  getTokenDecimals,
  getMintTokenProgramId
};
