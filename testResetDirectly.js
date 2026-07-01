require('dotenv').config();
const { getFirestore } = require('./config/firebase');

async function run() {
  try {
    const uid = 'hhhAYVsbVqGhN06kyjZM'; // Lock White
    const db = getFirestore();
    const ref = db.collection('users').doc(uid);
    
    console.log('Attempting to update user stats...');
    await ref.update({
      highScore: 0,
      totalScore: 0,
      goldBalance: 0,
      clashBalance: 0,
      seeds: 0,
      totalBP: 0,
      suspiciousFlag: false,
      suspiciousReason: null,
      suspiciousFlagAt: null
    });
    console.log('Update successful!');
  } catch (err) {
    console.error('Error occurred:', err);
  }
}

run();
