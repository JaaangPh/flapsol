// firebase-admin v14+ uses modular imports
const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore: _getFirestore }   = require('firebase-admin/firestore');

let db;

function getFirestore() {
  if (!db) {
    if (getApps().length === 0) {
      initializeApp({
        credential: cert({
          projectId:   process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        }),
      });
    }
    db = _getFirestore();
  }
  return db;
}

module.exports = { getFirestore };
