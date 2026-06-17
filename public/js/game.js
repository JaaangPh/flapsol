/* =========================================================
   SolClash – Flappy Bird  |  game.js
   ========================================================= */

'use strict';

// ── Assets ───────────────────────────────────────────────────────────────────
// normal = wings down (falling/gliding)
// flap   = wings up   (just flapped)
const BIRDS = {
  'bird-1': {
    normal: 'images/birds/bird-1/Bird-2.png',
    flap:   'images/birds/bird-1/Bird.png',
  },
  'bird-2': {
    normal: 'images/birds/bird-2/Bird-2.png',
    flap:   'images/birds/bird-2/Bird.png',
  },
  'bird-3': {
    normal: 'images/birds/bird-3/bird22.png',
    flap:   'images/birds/bird-3/bird21.png',
  },
};

const BACKGROUNDS = [
  'images/background-image.PNG',
  'images/bg2.png',
  'images/bg3.gif',
];

// ── DOM refs ──────────────────────────────────────────────────────────────────
const gameBg         = document.getElementById('gameBg');
const scoreValEl     = document.getElementById('scoreVal');
const bestValEl      = document.getElementById('bestVal');
const userAvatarEl   = document.getElementById('userAvatar');
const userNameEl     = document.getElementById('userName');
const startScreen    = document.getElementById('startScreen');
const gameOverScreen = document.getElementById('gameOverScreen');
const finalScoreEl   = document.getElementById('finalScore');
const finalBestEl    = document.getElementById('finalBest');
const playBtn        = document.getElementById('playBtn');
const restartBtn     = document.getElementById('restartBtn');
const birdOptions    = document.getElementById('birdOptions');
const previewBird    = document.getElementById('previewBird');
const lbModal        = document.getElementById('lbModal');
const lbBody         = document.getElementById('lbBody');

// Bird wrapper – contains two <img> swapped by CSS class
const birdWrap    = document.getElementById('birdWrap');
const birdNormal  = document.getElementById('birdNormal');
const birdFlap    = document.getElementById('birdFlap');

document.getElementById('lbToggleBtn')?.addEventListener('click', openLeaderboard);
document.getElementById('lbToggleBtn2')?.addEventListener('click', openLeaderboard);
document.getElementById('closeLb')?.addEventListener('click', () => {
  lbModal.style.display = 'none';
});

// ── State ─────────────────────────────────────────────────────────────────────
let user         = null;
let selectedBird = 'bird-1';
let score        = 0;
let highScore    = 0;
let gameState    = 'idle';

let birdY  = 0;
let birdDy = 0;

const GRAVITY           = 0.44;
const FLAP_POWER        = -8.2;
const MOVE_SPEED        = 3;
const PIPE_GAP_PX       = () => window.innerHeight * 0.30;
const PIPE_SPAWN_FRAMES = 110;
const BIRD_LEFT_PX      = () => window.innerWidth * 0.20;
const FLAP_HOLD         = 12; // frames to show flap image after pressing

let pipes      = [];
let frameCount = 0;
let animId     = null;
let flapFlag   = false;
let flapFrames = 0;

// ── Sounds ────────────────────────────────────────────────────────────────────
const sndPoint = new Audio('sounds effect/point.mp3');
const sndDie   = new Audio('sounds effect/die.mp3');
sndPoint.volume = 0.5;
sndDie.volume   = 0.7;

// ── Bird image helpers ────────────────────────────────────────────────────────
function setBirdImages(id) {
  birdNormal.src = BIRDS[id].normal;
  birdFlap.src   = BIRDS[id].flap;
}

function showFlapImg(isFlapping) {
  if (isFlapping) {
    birdNormal.style.display = 'none';
    birdFlap.style.display   = 'block';
  } else {
    birdNormal.style.display = 'block';
    birdFlap.style.display   = 'none';
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  // Pick a random background each game session
  const bg    = BACKGROUNDS[Math.floor(Math.random() * BACKGROUNDS.length)];
  const isGif = bg.toLowerCase().endsWith('.gif');

  gameBg.style.backgroundImage = `url('${bg}')`;

  const isFixed = isGif || bg.includes('background-image');

  if (isFixed) {
    // background-image.PNG and bg3.gif — fixed full-cover, no scroll
    gameBg.style.backgroundSize     = 'cover';
    gameBg.style.backgroundRepeat   = 'no-repeat';
    gameBg.style.backgroundPosition = 'center center';
    gameBg.style.animation          = 'none';
  } else {
    // bg2.png — tiles horizontally and scrolls
    gameBg.style.backgroundSize     = 'auto 100%';
    gameBg.style.backgroundRepeat   = 'repeat-x';
    gameBg.style.backgroundPosition = 'center bottom';
    gameBg.style.animation          = 'bgscroll 22s linear infinite';
  }

  try {
    const res  = await fetch('/auth/me');
    const data = await res.json();
    if (!data.loggedIn) { window.location.href = '/'; return; }

    user         = data;
    selectedBird = data.selectedBird || 'bird-1';
    highScore    = data.highScore    || 0;

    userAvatarEl.src       = data.avatar || 'images/birds/Bird.png';
    userNameEl.textContent = data.name   || 'Player';
    bestValEl.textContent  = highScore;
    userAvatarEl.onerror   = () => { userAvatarEl.src = 'images/birds/Bird.png'; };
  } catch {
    window.location.href = '/';
    return;
  }

  birdOptions.querySelectorAll('.bird-opt').forEach(opt => {
    opt.addEventListener('click', () => selectBird(opt.dataset.bird));
  });

  selectBird(selectedBird, false);
  showStart();
}

// ── Bird selection ────────────────────────────────────────────────────────────
function selectBird(id, save = true) {
  selectedBird = id;
  birdOptions.querySelectorAll('.bird-opt').forEach(opt => {
    opt.classList.toggle('selected', opt.dataset.bird === id);
  });

  // Update preview and both bird sprites
  previewBird.src = BIRDS[id].flap; // show flap sprite in preview (looks better)
  setBirdImages(id);
  showFlapImg(false);

  if (save && user) {
    fetch('/api/bird', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ bird: id }),
    }).catch(() => {});
  }
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function showStart() {
  startScreen.style.display    = 'flex';
  gameOverScreen.style.display = 'none';
  birdWrap.style.display       = 'none';
}

function showGameOver() {
  gameOverScreen.style.display = 'flex';
  startScreen.style.display    = 'none';
  finalScoreEl.textContent     = score;
  finalBestEl.textContent      = highScore;
}

// ── Game lifecycle ────────────────────────────────────────────────────────────
function startGame() {
  pipes.forEach(p => { p.topEl.remove(); p.botEl.remove(); });
  pipes      = [];
  frameCount = 0;
  score      = 0;
  flapFlag   = false;
  flapFrames = 0;
  scoreValEl.textContent = '0';

  birdY  = window.innerHeight * 0.40;
  birdDy = 0;

  birdWrap.style.left    = BIRD_LEFT_PX() + 'px';
  birdWrap.style.top     = birdY + 'px';
  birdWrap.style.display = 'block';

  setBirdImages(selectedBird);
  showFlapImg(false);

  startScreen.style.display    = 'none';
  gameOverScreen.style.display = 'none';
  gameState = 'playing';
  tapZone.classList.add('active');

  if (animId) cancelAnimationFrame(animId);
  animId = requestAnimationFrame(gameLoop);
}

async function endGame() {
  gameState = 'dead';
  tapZone.classList.remove('active');
  sndDie.play().catch(() => {});
  birdWrap.style.display = 'none';
  cancelAnimationFrame(animId);

  if (score > highScore) {
    highScore = score;
    bestValEl.textContent = highScore;
  }

  if (user) {
    try {
      const res  = await fetch('/api/score', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ score }),
      });
      const data = await res.json();
      if (data.highScore && data.highScore > highScore) {
        highScore = data.highScore;
        bestValEl.textContent = highScore;
      }
    } catch {}
  }

  showGameOver();
}

// ── Game loop ─────────────────────────────────────────────────────────────────
function gameLoop() {
  if (gameState !== 'playing') return;

  frameCount++;

  // Flap trigger
  if (flapFlag) {
    birdDy     = FLAP_POWER;
    flapFrames = FLAP_HOLD;
    flapFlag   = false;
  }

  // Gravity
  birdDy += GRAVITY;
  birdY  += birdDy;

  // Switch sprite: flap image while flapFrames > 0, normal otherwise
  if (flapFrames > 0) {
    flapFrames--;
    showFlapImg(true);
  } else {
    showFlapImg(false);
  }

  // Tilt based on velocity
  const tilt = Math.min(Math.max(birdDy * 3, -25), 70);
  birdWrap.style.transform = `rotate(${tilt}deg)`;
  birdWrap.style.top       = birdY + 'px';

  // Boundary
  const birdRect = birdWrap.getBoundingClientRect();
  if (birdRect.top <= 0 || birdRect.bottom >= window.innerHeight) {
    endGame();
    return;
  }

  // Spawn pipes
  if (frameCount % PIPE_SPAWN_FRAMES === 0) spawnPipe();

  // Move & check pipes
  for (let i = pipes.length - 1; i >= 0; i--) {
    const p = pipes[i];
    p.x -= MOVE_SPEED;
    p.topEl.style.left = p.x + 'px';
    p.botEl.style.left = p.x + 'px';

    const pipeW = p.pipeW;
    if (p.x + pipeW < 0) {
      p.topEl.remove();
      p.botEl.remove();
      pipes.splice(i, 1);
      continue;
    }

    if (!p.scored && p.x + pipeW < birdRect.left) {
      p.scored = true;
      score++;
      scoreValEl.textContent = score;
      sndPoint.currentTime = 0;
      sndPoint.play().catch(() => {});
      showScorePop();
    }

    const topRect = p.topEl.getBoundingClientRect();
    const botRect = p.botEl.getBoundingClientRect();
    if (rectsOverlap(birdRect, topRect) || rectsOverlap(birdRect, botRect)) {
      endGame();
      return;
    }
  }

  animId = requestAnimationFrame(gameLoop);
}

// ── Pipe factory ──────────────────────────────────────────────────────────────
function spawnPipe() {
  const W     = window.innerWidth;
  const H     = window.innerHeight;
  const pipeW = Math.max(60, Math.min(80, W * 0.10));

  // Store gap centre as a RATIO (0–1) so it can be recalculated on resize
  const gapRatio = 0.25 + Math.random() * 0.47; // 25%–72% of screen height

  const topEl = document.createElement('div');
  topEl.className = 'pipe pipe-top';
  document.body.appendChild(topEl);

  const botEl = document.createElement('div');
  botEl.className = 'pipe pipe-bottom';
  document.body.appendChild(botEl);

  const pipe = { x: W, topEl, botEl, scored: false, gapRatio, pipeW };
  pipes.push(pipe);
  applyPipeDimensions(pipe);
}

// Recalculate a single pipe's height/position using current window size
function applyPipeDimensions(pipe) {
  const H    = window.innerHeight;
  const gap  = PIPE_GAP_PX();
  const gapC = pipe.gapRatio * H;
  const topH = Math.max(1, gapC - gap / 2);
  const botT = gapC + gap / 2;
  const botH = Math.max(1, H - botT);

  pipe.topEl.style.cssText = `position:fixed;width:${pipe.pipeW}px;height:${topH}px;top:0;left:${pipe.x}px;z-index:20;background-image:url('images/pipes/toppipe.png');background-repeat:no-repeat;background-size:100% 100%;`;
  pipe.botEl.style.cssText = `position:fixed;width:${pipe.pipeW}px;height:${botH}px;top:${botT}px;left:${pipe.x}px;z-index:20;background-image:url('images/pipes/bottompipe.png');background-repeat:no-repeat;background-size:100% 100%;`;
}

// Recalculate all live pipes on resize
function onResize() {
  if (gameState !== 'playing') return;

  // Re-anchor bird horizontal position
  birdWrap.style.left = BIRD_LEFT_PX() + 'px';

  // Rebuild all pipe dimensions
  pipes.forEach(applyPipeDimensions);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function rectsOverlap(a, b) {
  const m = 10;
  return !(a.right-m < b.left+m || a.left+m > b.right-m || a.bottom-m < b.top+m || a.top+m > b.bottom-m);
}

function showScorePop() {
  const el = document.createElement('div');
  el.className   = 'score-pop';
  el.textContent = '+1';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 650);
}

// ── Leaderboard ───────────────────────────────────────────────────────────────
async function openLeaderboard() {
  lbModal.style.display = 'flex';
  lbBody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#888;padding:20px">Loading…</td></tr>';
  try {
    const res  = await fetch('/api/leaderboard');
    const data = await res.json();
    if (!data.length) {
      lbBody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#888;padding:20px">No scores yet</td></tr>';
      return;
    }
    lbBody.innerHTML = data.map(row => `
      <tr>
        <td>${row.rank}</td>
        <td>
          ${row.avatar ? `<img class="lb-avatar" src="${escHtml(row.avatar)}" alt="" onerror="this.style.display='none'">` : ''}
          ${escHtml(row.name)}
        </td>
        <td>${row.highScore}</td>
        <td>${escHtml(row.tier || '')}</td>
      </tr>
    `).join('');
  } catch {
    lbBody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#f66;padding:20px">Failed to load</td></tr>';
  }
}

function escHtml(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Controls ──────────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'ArrowUp' || e.key === ' ') {
    e.preventDefault();
    if (gameState === 'playing') flapFlag = true;
  }
});

// ── Tap / click flap zone ─────────────────────────────────────────────────────
// Use a dedicated invisible full-screen div so taps are never blocked by
// pipes, HUD, or bird elements sitting on top of body.
const tapZone = document.getElementById('tapZone');

tapZone.addEventListener('pointerdown', e => {
  e.preventDefault(); // stops 300ms delay + ghost clicks on mobile
  if (gameState === 'playing') flapFlag = true;
}, { passive: false });

// Fallback touchstart for older iOS
tapZone.addEventListener('touchstart', e => {
  e.preventDefault();
  if (gameState === 'playing') flapFlag = true;
}, { passive: false });
// ── Fullscreen ────────────────────────────────────────────────────────────────
function requestFullscreen() {
  const el = document.documentElement;
  const fn = el.requestFullscreen
           || el.webkitRequestFullscreen
           || el.mozRequestFullScreen
           || el.msRequestFullscreen;
  if (fn) fn.call(el).catch(() => {});
}

function exitFullscreen() {
  const fn = document.exitFullscreen
           || document.webkitExitFullscreen
           || document.mozCancelFullScreen
           || document.msExitFullscreen;
  if (fn) fn.call(document).catch(() => {});
}

// Toggle fullscreen button in HUD
const fsBtn = document.getElementById('fsBtn');
fsBtn?.addEventListener('click', () => {
  const isFs = document.fullscreenElement
             || document.webkitFullscreenElement
             || document.mozFullScreenElement;
  if (isFs) {
    exitFullscreen();
    fsBtn.textContent = '⛶';
  } else {
    requestFullscreen();
    fsBtn.textContent = '✕';
  }
});

// Update icon when user exits fullscreen via Esc key
document.addEventListener('fullscreenchange',       updateFsIcon);
document.addEventListener('webkitfullscreenchange', updateFsIcon);
document.addEventListener('mozfullscreenchange',    updateFsIcon);

function updateFsIcon() {
  if (!fsBtn) return;
  const isFs = document.fullscreenElement
             || document.webkitFullscreenElement
             || document.mozFullScreenElement;
  fsBtn.textContent = isFs ? '✕' : '⛶';
}

playBtn.addEventListener('click', () => { requestFullscreen(); startGame(); });
restartBtn.addEventListener('click', startGame); // already fullscreen on restart

// ── Resize / fullscreen change → fix pipe dimensions ─────────────────────────
window.addEventListener('resize', onResize);
document.addEventListener('fullscreenchange',       onResize);
document.addEventListener('webkitfullscreenchange', onResize);
document.addEventListener('mozfullscreenchange',    onResize);

init();
