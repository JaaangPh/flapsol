// firebase-admin v14+ uses modular imports
const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore: _getFirestore }   = require('firebase-admin/firestore');

let db;
let firestoreCircuitOpenUntil = 0;
const FIRESTORE_COOLDOWN_MS = 30000;

function getFirestore() {
  if (!db) {
    const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;

    if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
      throw new Error(
        'Missing Firebase env vars: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY must all be set.'
      );
    }

    if (getApps().length === 0) {
      initializeApp({
        credential: cert({
          projectId:   FIREBASE_PROJECT_ID,
          clientEmail: FIREBASE_CLIENT_EMAIL,
          privateKey:  FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        }),
      });
    }
    db = _getFirestore();
  }
  return db;
}

function isQuotaError(err) {
  return !!err && (
    err.code === 8 ||
    err.code === 'RESOURCE_EXHAUSTED' ||
    /RESOURCE_EXHAUSTED|quota exceeded|quota/i.test(err.message || '')
  );
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runWithFirestoreRetry(operation, fallbackValue = null) {
  if (Date.now() < firestoreCircuitOpenUntil) {
    return fallbackValue;
  }

  let attempts = 0;
  while (attempts < 3) {
    try {
      return await operation();
    } catch (err) {
      if (!isQuotaError(err)) throw err;

      attempts += 1;
      if (attempts >= 3) {
        firestoreCircuitOpenUntil = Date.now() + FIRESTORE_COOLDOWN_MS;
        return fallbackValue;
      }

      await delay(500 * attempts);
    }
  }

  return fallbackValue;
}

module.exports = { getFirestore, runWithFirestoreRetry, isQuotaError };
