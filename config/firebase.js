// firebase-admin v14+ uses modular imports
const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore: _getFirestore }   = require('firebase-admin/firestore');

let db;

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

module.exports = { getFirestore };
