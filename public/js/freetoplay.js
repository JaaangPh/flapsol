/* =========================================================
   SolClash – Free To Play  |  freetoplay.js
   Same as game.js but: no score saved, no leaderboard,
   game-over redirects back to dashboard.
   ========================================================= */

'use strict';

const BIRDS = {
  'bird-1': { normal: 'images/birds/bird-1/Bird-2.png', flap: 'images/birds/bird-1/Bird.png' },
  'bird-2': { normal: 'images/birds/bird-2/Bird-2.png', flap: 'images/birds/bird-2/Bird.png' },
  'bird-3': { normal: 'images/birds/bird-3/bird22.png', flap: 'images/birds/bird-3/bird21.png' },
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
const birdWrap       = document.getElementById('birdWrap');
const birdNormal     = document.getElementById('birdNormal');
const birdFlap       = document.getElementById('birdFlap');
const tapZone        = document.getElementById('tapZone');
const fsBtn          = document.getElementById('fsBtn');

// ── State ─────────────────────────────────────────────────────────────────────
let selectedBird = 'bird-1';
let score        = 0;
let bestScore    = 0;
let gameState    = 'idle'; // idle | ready | playing | dead
let birdY        = 0;
let birdDy       = 0;
let pipes        = [];
let frameCount   = 0;
let animId       = null;
let flapFlag     = false;
let flapFrames   = 0;
let floatFrame   = 0;

const GRAVITY           = 0.44;
const FLAP_POWER        = -8.2;
const MOVE_SPEED        = 3;
const PIPE_GAP_PX       = () => window.innerHeight * 0.30;
const PIPE_SPAWN_FRAMES = 110;
const BIRD_LEFT_PX      = () => window.innerWidth * 0.20;
const FLAP_HOLD         = 12;

// ── Sounds ────────────────────────────────────────────────────────────────────
const sndPoint = new Audio('sounds effect/point.mp3');
const sndDie   = new Audio('sounds effect/die.mp3');
sndPoint.volume = 0.5;
sndDie.volume   = 0.7;

let audioCtx = null;

function unlockAudio() {
  if (audioCtx) return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    [sndPoint, sndDie].forEach(snd => {
      snd.load();
      const p = snd.play();
      if (p) p.then(() => snd.pause()).catch(() => {});
    });
  } catch {}
}

['touchstart', 'touchend', 'pointerdown', 'keydown'].forEach(evt => {
  document.addEventListener(evt, unlockAudio, { passive: true });
});

function playSound(snd) {
  try {
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().then(() => { snd.currentTime = 0; snd.play().catch(() => {}); });
    } else {
      snd.currentTime = 0;
      snd.play().catch(() => {});
    }
  } catch {}
}

// ── Bird helpers ──────────────────────────────────────────────────────────────
function setBirdImages(id) {
  birdNormal.src = BIRDS[id].normal;
  birdFlap.src   = BIRDS[id].flap;
}

function showFlapImg(isFlapping) {
  birdNormal.style.display = isFlapping ? 'none'  : 'block';
  birdFlap.style.display   = isFlapping ? 'block' : 'none';
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  const bg      = BACKGROUNDS[Math.floor(Math.random() * BACKGROUNDS.length)];
  const isFixed = bg.toLowerCase().endsWith('.gif') || bg.includes('background-image');

  gameBg.style.backgroundImage = `url('${bg}')`;
  if (isFixed) {
    gameBg.style.backgroundSize     = 'cover';
    gameBg.style.backgroundRepeat   = 'no-repeat';
    gameBg.style.backgroundPosition = 'center center';
    gameBg.style.animation          = 'none';
  } else {
    gameBg.style.backgroundSize     = 'auto 100%';
    gameBg.style.backgroundRepeat   = 'repeat-x';
    gameBg.style.backgroundPosition = 'center bottom';
    gameBg.style.animation          = 'bgscroll 22s linear infinite';
  }

  // Load user info for the HUD (display only — nothing is saved)
  try {
    const res  = await fetch('/auth/me');
    const data = await res.json();
    if (!data.loggedIn) { window.location.href = '/'; return; }
    userAvatarEl.src       = data.avatar || 'images/birds/Bird.png';
    // Show truncated wallet: CHqN9X4r….yEZb
    const w = data.walletAddress || data.walletPublicKey || '';
    userNameEl.textContent = w.length > 12
      ? w.slice(0, 8) + '….' + w.slice(-4)
      : (data.name || 'Player');
    userAvatarEl.onerror   = () => { userAvatarEl.src = 'images/birds/Bird.png'; };
    // Use the player's selected bird as default
    selectedBird = data.selectedBird || 'bird-1';
  } catch {
    window.location.href = '/';
    return;
  }

  birdOptions.querySelectorAll('.bird-opt').forEach(opt => {
    opt.addEventListener('click', () => selectBird(opt.dataset.bird));
  });

  selectBird(selectedBird);
  showStart();
}

// ── Bird selection — no API call, session only ────────────────────────────────
function selectBird(id) {
  selectedBird = id;
  birdOptions.querySelectorAll('.bird-opt').forEach(opt => {
    opt.classList.toggle('selected', opt.dataset.bird === id);
  });
  previewBird.src = BIRDS[id].flap;
  setBirdImages(id);
  showFlapImg(false);
}

// ── UI ────────────────────────────────────────────────────────────────────────
function showStart() {
  startScreen.style.display    = 'flex';
  gameOverScreen.style.display = 'none';
  birdWrap.style.display       = 'none';
}

function showGameOver() {
  gameOverScreen.style.display = 'flex';
  startScreen.style.display    = 'none';
  finalScoreEl.textContent     = score;
  finalBestEl.textContent      = bestScore;
}

// ── Game lifecycle ────────────────────────────────────────────────────────────
function startGame() {
  pipes.forEach(p => { p.topEl.remove(); p.botEl.remove(); });
  pipes      = [];
  frameCount = 0;
  score      = 0;
  flapFlag   = false;
  flapFrames = 0;
  floatFrame = 0;
  scoreValEl.textContent = '0';

  birdY  = window.innerHeight * 0.40;
  birdDy = 0;
  birdWrap.style.left      = BIRD_LEFT_PX() + 'px';
  birdWrap.style.top       = birdY + 'px';
  birdWrap.style.display   = 'block';
  birdWrap.style.transform = 'rotate(0deg)';

  setBirdImages(selectedBird);
  showFlapImg(false);

  startScreen.style.display    = 'none';
  gameOverScreen.style.display = 'none';

  // Enter 'ready' — bird floats, no pipes, waiting for first flap
  gameState = 'ready';
  tapZone.classList.add('active');

  if (animId) cancelAnimationFrame(animId);
  animId = requestAnimationFrame(gameLoop);
}

function endGame() {
  gameState = 'dead';
  tapZone.classList.remove('active');
  playSound(sndDie);
  birdWrap.style.display = 'none';
  cancelAnimationFrame(animId);

  // Update session-only best — nothing is sent to the server
  if (score > bestScore) {
    bestScore = score;
    bestValEl.textContent = bestScore;
  }

  showGameOver();
}

// ── Game loop ─────────────────────────────────────────────────────────────────
function gameLoop() {
  if (gameState === 'dead') return;

  // ── Ready state: bird floats, waiting for first flap ─────────────────────
  if (gameState === 'ready') {
    floatFrame++;
    birdY = window.innerHeight * 0.40 + Math.sin(floatFrame * 0.06) * 8;
    birdWrap.style.top       = birdY + 'px';
    birdWrap.style.transform = 'rotate(0deg)';
    showFlapImg(floatFrame % 20 < 10);

    if (flapFlag) {
      flapFlag   = false;
      gameState  = 'playing';
      birdDy     = FLAP_POWER;
      flapFrames = FLAP_HOLD;
    }

    animId = requestAnimationFrame(gameLoop);
    return;
  }

  // ── Playing state ─────────────────────────────────────────────────────────
  frameCount++;

  if (flapFlag) {
    birdDy     = FLAP_POWER;
    flapFrames = FLAP_HOLD;
    flapFlag   = false;
  }

  birdDy += GRAVITY;
  birdY  += birdDy;

  if (flapFrames > 0) { flapFrames--; showFlapImg(true); }
  else                {               showFlapImg(false); }

  const tilt = Math.min(Math.max(birdDy * 3, -25), 70);
  birdWrap.style.transform = `rotate(${tilt}deg)`;
  birdWrap.style.top       = birdY + 'px';

  const birdRect = birdWrap.getBoundingClientRect();
  if (birdRect.top <= 0 || birdRect.bottom >= window.innerHeight) { endGame(); return; }

  if (frameCount % PIPE_SPAWN_FRAMES === 0) spawnPipe();

  for (let i = pipes.length - 1; i >= 0; i--) {
    const p = pipes[i];
    p.x -= MOVE_SPEED;
    p.topEl.style.left = p.x + 'px';
    p.botEl.style.left = p.x + 'px';

    if (p.x + p.pipeW < 0) {
      p.topEl.remove(); p.botEl.remove();
      pipes.splice(i, 1);
      continue;
    }

    if (!p.scored && p.x + p.pipeW < birdRect.left) {
      p.scored = true;
      score++;
      scoreValEl.textContent = score;
      playSound(sndPoint);
      showScorePop();
    }

    if (rectsOverlap(birdRect, p.topEl.getBoundingClientRect()) ||
        rectsOverlap(birdRect, p.botEl.getBoundingClientRect())) {
      endGame(); return;
    }
  }

  animId = requestAnimationFrame(gameLoop);
}

// ── Pipe factory ──────────────────────────────────────────────────────────────
function spawnPipe() {
  const pipeW    = Math.max(60, Math.min(80, window.innerWidth * 0.10));
  const gapRatio = 0.25 + Math.random() * 0.47;

  const topEl = document.createElement('div');
  topEl.className = 'pipe pipe-top';
  document.body.appendChild(topEl);

  const botEl = document.createElement('div');
  botEl.className = 'pipe pipe-bottom';
  document.body.appendChild(botEl);

  const pipe = { x: window.innerWidth, topEl, botEl, scored: false, gapRatio, pipeW };
  pipes.push(pipe);
  applyPipeDimensions(pipe);
}

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

function onResize() {
  if (gameState !== 'playing') return;
  birdWrap.style.left = BIRD_LEFT_PX() + 'px';
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

// ── Controls ──────────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'ArrowUp' || e.key === ' ') {
    e.preventDefault();
    if (gameState === 'playing' || gameState === 'ready') flapFlag = true;
  }
});

tapZone.addEventListener('pointerdown', e => {
  e.preventDefault();
  if (gameState === 'playing' || gameState === 'ready') flapFlag = true;
}, { passive: false });

tapZone.addEventListener('touchstart', e => {
  e.preventDefault();
  if (gameState === 'playing' || gameState === 'ready') flapFlag = true;
}, { passive: false });

// ── Fullscreen ────────────────────────────────────────────────────────────────
function requestFullscreen() {
  const el = document.documentElement;
  const fn = el.requestFullscreen || el.webkitRequestFullscreen
          || el.mozRequestFullScreen || el.msRequestFullscreen;
  if (fn) fn.call(el).catch(() => {});
}

function exitFullscreen() {
  const fn = document.exitFullscreen || document.webkitExitFullscreen
          || document.mozCancelFullScreen || document.msExitFullscreen;
  if (fn) fn.call(document).catch(() => {});
}

fsBtn?.addEventListener('click', () => {
  const isFs = document.fullscreenElement || document.webkitFullscreenElement
             || document.mozFullScreenElement;
  isFs ? exitFullscreen() : requestFullscreen();
});

document.addEventListener('fullscreenchange',       onResize);
document.addEventListener('webkitfullscreenchange', onResize);

playBtn.addEventListener('click',    () => { requestFullscreen(); startGame(); });
restartBtn.addEventListener('click', startGame);
window.addEventListener('resize',   onResize);

init();
