/**
 * utils/wallet.js
 * Generates a new Solana keypair and returns encrypted public/private keys.
 * Encryption uses AES-256-CBC with the ENCRYPTION_KEY from .env.
 */

const { Keypair } = require('@solana/web3.js');
const bs58        = require('bs58').default;
const crypto      = require('crypto');
const bip39       = require('bip39');
const { derivePath } = require('ed25519-hd-key');

const ALGO      = 'aes-256-cbc';
const KEY_HEX   = process.env.ENCRYPTION_KEY || '0'.repeat(64);
const ENC_KEY   = Buffer.from(KEY_HEX.slice(0, 64), 'hex'); // 32 bytes

function encrypt(text) {
  const iv         = crypto.randomBytes(16);
  const cipher     = crypto.createCipheriv(ALGO, ENC_KEY, iv);
  const encrypted  = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(data) {
  const [ivHex, encHex] = data.split(':');
  const iv        = Buffer.from(ivHex, 'hex');
  const enc       = Buffer.from(encHex, 'hex');
  const decipher  = crypto.createDecipheriv(ALGO, ENC_KEY, iv);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

/**
 * Generate a new Solana wallet.
 * Returns { walletPublicKey, walletPrivateKey, walletAddress, seedPhrase } — AES-encrypted strings.
 */
function generateWallet() {
  const mnemonic   = bip39.generateMnemonic(); // Generates 12 words (128-bit entropy)
  const seed       = bip39.mnemonicToSeedSync(mnemonic);
  const derived    = derivePath("m/44'/501'/0'/0'", seed.toString('hex'));
  const keypair    = Keypair.fromSeed(derived.key);

  const publicKey  = keypair.publicKey.toBase58();
  const privateKey = bs58.encode(keypair.secretKey);

  return {
    walletPublicKey:  encrypt(publicKey),
    walletPrivateKey: encrypt(privateKey),
    walletAddress:    publicKey, // plain, for display only at creation time
    seedPhrase:       encrypt(mnemonic),
  };
}

module.exports = { generateWallet, encrypt, decrypt };
