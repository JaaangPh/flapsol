/* =========================================================
   SolClash – Flappy Bird  |  game.js
   ========================================================= */

'use strict';

// ── Assets ───────────────────────────────────────────────────────────────────
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
const lbModal        = document.getElementById('lbModal');
const lbBody         = document.getElementById('lbBody');
const birdWrap       = document.getElementById('birdWrap');
const birdNormal     = document.getElementById('birdNormal');
const birdFlap       = document.getElementById('birdFlap');
const tapZone        = document.getElementById('tapZone');
const fsBtn          = document.getElementById('fsBtn');

document.getElementById('lbToggleBtn')?.addEventListener('click', openLeaderboard);
document.getElementById('lbToggleBtn2')?.addEventListener('click', openLeaderboard);
document.getElementById('closeLb')?.addEventListener('click', () => { lbModal.style.display = 'none'; });

// ── State ─────────────────────────────────────────────────────────────────────
let user         = null;
let selectedBird = 'bird-1';
let score        = 0;
let highScore    = 0;
let gameState    = 'idle'; // idle | ready | playing | dead
let birdY        = 0;
let birdDy       = 0;
let pipes        = [];
let frameCount   = 0;
let animId       = null;
let flapFlag     = false;
let flapFrames   = 0;
let floatFrame   = 0; // for idle float animation
let gameStartTime = null;

// ── Energy state ──────────────────────────────────────────────────────────────
let currentEnergy   = 0;
let maxEnergy       = 1;

// ── Collectibles state ────────────────────────────────────────────────────────
let collectibles      = [];   // { el, x, y, type:'seed'|'gold', collected }
let seedsCollected    = 0;
let goldCollected     = 0;
const COLLECTIBLE_SIZE = 28;  // px

const GRAVITY           = 0.44;
const FLAP_POWER        = -8.2;
const MOVE_SPEED        = 3;
const PIPE_GAP_PX       = () => {
  // Random gap: 20% chance of a tight gap (~18% screen height), otherwise normal (24–32%)
  const r = Math.random();
  if (r < 0.20) return window.innerHeight * 0.18; // tight — challenging but passable
  if (r < 0.55) return window.innerHeight * 0.24; // normal
  return window.innerHeight * 0.32;               // wide — breather round
};
const PIPE_SPAWN_FRAMES = 180;
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

// ── Energy helpers ────────────────────────────────────────────────────────────

// Per-nest absolute nextTickAt timestamps from server (source of truth)
let nestTimers = {}; // nestId → nextTickAt ISO string
let gameRegenInt = null;

function msToHMS(ms) {
  if (ms <= 0) return '0s';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0 || h > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

function updateEnergyHUD() {
  // Show or hide the no-energy warning on the start screen
  const warn    = document.getElementById('energyWarn');
  const warnTxt = document.getElementById('energyWarnText');
  const playBtn = document.getElementById('playBtn');

  if (currentEnergy <= 0) {
    if (warn) warn.style.display = 'flex';
    if (playBtn) { playBtn.disabled = true; playBtn.style.opacity = '0.4'; playBtn.style.cursor = 'not-allowed'; }
    startGameRegenCountdown();
  } else {
    if (warn) warn.style.display = 'none';
    if (playBtn) { playBtn.disabled = false; playBtn.style.opacity = ''; playBtn.style.cursor = ''; }
    stopGameRegenCountdown();
  }
}

function startGameRegenCountdown() {
  stopGameRegenCountdown();
  const warnTxt = document.getElementById('energyWarnText');

  function tick() {
    if (!warnTxt) return;
    const now = Date.now();
    let fastestMs = Infinity;
    for (const nextTickAt of Object.values(nestTimers)) {
      const ms = new Date(nextTickAt).getTime() - now;
      if (ms < fastestMs) fastestMs = ms;
    }
    if (fastestMs <= 0 || fastestMs === Infinity) {
      stopGameRegenCountdown();
      fetchEnergy(); // regen happened — re-fetch
      return;
    }
    warnTxt.textContent = `No energy! Next in ${msToHMS(fastestMs)}`;
  }

  tick();
  gameRegenInt = setInterval(tick, 1000);
}

function stopGameRegenCountdown() {
  if (gameRegenInt) { clearInterval(gameRegenInt); gameRegenInt = null; }
}

async function fetchEnergy() {
  try {
    const res  = await fetch('/api/energy');
    const data = await res.json();
    if (data.ok) {
      currentEnergy = data.energy;
      maxEnergy     = data.maxEnergy;
      // Store absolute per-nest timestamps from server
      nestTimers = {};
      if (data.nests) {
        for (const n of data.nests) {
          if (n.nextTickAt) nestTimers[n.nestId] = n.nextTickAt;
        }
      }
      updateEnergyHUD();
    }
  } catch (e) {
    console.warn('[energy fetch]', e);
  }
}

/** Calls POST /api/energy/use. Returns true if energy was consumed, false if denied. */
async function useEnergy() {
  try {
    const res  = await fetch('/api/energy/use', { method: 'POST' });
    const data = await res.json();
    if (res.ok && data.ok) {
      currentEnergy = data.energy;
      maxEnergy     = data.maxEnergy;
      nestTimers = {};
      if (data.nests) {
        for (const n of data.nests) {
          if (n.nextTickAt) nestTimers[n.nestId] = n.nextTickAt;
        }
      }
      updateEnergyHUD();
      return true;
    } else {
      if (data.energy !== undefined) currentEnergy = data.energy;
      if (data.maxEnergy !== undefined) maxEnergy = data.maxEnergy;
      if (data.nests) {
        nestTimers = {};
        for (const n of data.nests) {
          if (n.nextTickAt) nestTimers[n.nestId] = n.nextTickAt;
        }
      }
      updateEnergyHUD();
      return false;
    }
  } catch (e) {
    console.warn('[energy use]', e);
    return false;
  }
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

  try {
    const res  = await fetch('/auth/me');
    const data = await res.json();
    if (!data.loggedIn) { window.location.href = '/'; return; }

    user         = data;
    selectedBird = data.selectedBird || 'bird-1';
    highScore    = data.highScore    || 0;

    userAvatarEl.src       = data.avatar || 'images/birds/Bird.png';
    // Show truncated wallet: CHqN9X4r....yEZb
    const w = data.walletAddress || data.walletPublicKey || '';
    userNameEl.textContent = w.length > 12
      ? w.slice(0, 8) + '….' + w.slice(-4)
      : (data.name || 'Player');
    bestValEl.textContent  = highScore;
    userAvatarEl.onerror   = () => { userAvatarEl.src = 'images/birds/Bird.png'; };
  } catch {
    window.location.href = '/';
    return;
  }

  // Load energy from server
  await fetchEnergy();

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
  previewBird.src = BIRDS[id].flap;
  setBirdImages(id);
  showFlapImg(false);

  if (save && user) {
    fetch('/api/bird', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bird: id }),
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

  // Show current energy in game-over card
  const goEnergyRow   = document.getElementById('goEnergyRow');
  const goEnergyCount = document.getElementById('goEnergyCount');
  if (goEnergyRow && goEnergyCount) {
    goEnergyCount.textContent = `${currentEnergy} / ${maxEnergy}`;
    goEnergyRow.classList.toggle('empty', currentEnergy <= 0);
  }
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
  gameStartTime = null;

  // Reset collectibles
  collectibles.forEach(c => c.el.remove());
  collectibles   = [];
  seedsCollected = 0;
  goldCollected  = 0;

  const goExpContainer = document.getElementById('goExpContainer');
  if (goExpContainer) goExpContainer.style.display = 'none';
  const goRewardsContainer = document.getElementById('goRewardsContainer');
  if (goRewardsContainer) goRewardsContainer.style.display = 'none';

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

  // Enter 'ready' — bird floats, pipes frozen, waiting for first flap
  gameState = 'ready';
  tapZone.classList.add('active');

  if (animId) cancelAnimationFrame(animId);
  animId = requestAnimationFrame(gameLoop);
}

async function endGame() {
  gameState = 'dead';
  tapZone.classList.remove('active');
  playSound(sndDie);
  birdWrap.style.display = 'none';
  cancelAnimationFrame(animId);

  // Remove all collectibles
  collectibles.forEach(c => c.el.remove());
  collectibles = [];

  if (score > highScore) {
    highScore = score;
    bestValEl.textContent = highScore;
  }

  const playDuration = gameStartTime ? (Date.now() - gameStartTime) / 1000 : 0;

  if (user) {
    // Fire both requests in parallel
    const [scoreRes, rewardRes] = await Promise.allSettled([
      fetch('/api/score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ score, duration: playDuration }),
      }),
      fetch('/api/game/end', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seedsCollected, goldCollected }),
      }),
    ]);

    // ── Handle score / EXP ───────────────────────────────────────────────
    if (scoreRes.status === 'fulfilled' && scoreRes.value.ok) {
      try {
        const data = await scoreRes.value.json();
        if (data.highScore !== undefined && data.highScore > highScore) {
          highScore = data.highScore;
          bestValEl.textContent = highScore;
        }

        if (data.expGained !== undefined) {
          const goExpContainer = document.getElementById('goExpContainer');
          const goLevelLabel   = document.getElementById('goLevelLabel');
          const goExpVal       = document.getElementById('goExpVal');
          const goExpBar       = document.getElementById('goExpBar');
          const goLevelUpText  = document.getElementById('goLevelUpText');

          if (goExpContainer) {
            goExpContainer.style.display = 'block';
            goLevelLabel.textContent = `Level ${data.level ?? 0}`;
            goExpVal.textContent     = `+${data.expGained} EXP`;

            const currentExp  = data.currentExp  ?? 0;
            const requiredExp = data.requiredExp  ?? 200;

            let prevExp = currentExp - data.expGained;
            let prevRequired = requiredExp;
            if (data.leveledUp) {
              const prevLevel = (data.level ?? 1) - 1;
              prevRequired = (prevLevel + 1) * 200;
              prevExp = prevRequired - (data.expGained - currentExp);
            }

            const startPercent = Math.max(0, Math.min(100, Math.round(prevExp / prevRequired * 100)));
            const endPercent   = Math.max(0, Math.min(100, Math.round(currentExp / requiredExp * 100)));

            goExpBar.style.transition = 'none';
            goExpBar.style.width      = startPercent + '%';
            void goExpBar.offsetHeight;
            goExpBar.style.transition = 'width 0.8s cubic-bezier(0.4, 0, 0.2, 1)';

            if (data.leveledUp) {
              goExpBar.style.width = '100%';
              if (goLevelUpText) goLevelUpText.style.display = 'block';
              setTimeout(() => {
                goExpBar.style.transition = 'none';
                goExpBar.style.width      = '0%';
                void goExpBar.offsetHeight;
                goExpBar.style.transition = 'width 0.5s cubic-bezier(0.4, 0, 0.2, 1)';
                goExpBar.style.width      = endPercent + '%';
              }, 800);
            } else {
              goExpBar.style.width = endPercent + '%';
              if (goLevelUpText) goLevelUpText.style.display = 'none';
            }
          }
        }
      } catch (err) {
        console.error('[score parse error]', err);
      }
    }

    // ── Handle nest rewards ──────────────────────────────────────────────
    if (rewardRes.status === 'fulfilled' && rewardRes.value.ok) {
      try {
        const rdata = await rewardRes.value.json();
        if (rdata.ok && rdata.rewards && rdata.rewards.length > 0) {
          const container = document.getElementById('goRewardsContainer');
          const row       = document.getElementById('goRewardsRow');
          if (container && row) {
            row.innerHTML = '';
            rdata.rewards.forEach(r => {
              const pill = document.createElement('div');
              pill.className = 'go-reward-pill go-reward-' + r.type;
              let icon = '';
              if (r.type === 'bp')   icon = '<img src="images/bp.png" alt="BP" />';
              if (r.type === 'seed') icon = '<img src="images/seed.png" alt="Seed" />';
              if (r.type === 'gold') icon = '<img src="images/gold.png" alt="Gold" />';
              pill.innerHTML = `${icon}<span>${r.label}</span>`;
              row.appendChild(pill);
            });
            container.style.display = 'block';
          }
        }
      } catch (err) {
        console.error('[reward parse error]', err);
      }
    }
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
      flapFlag  = false;
      gameState = 'playing'; // first flap starts the game
      birdDy    = FLAP_POWER;
      flapFrames = FLAP_HOLD;
      gameStartTime = Date.now(); // track start of gameplay
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

  updateCollectibles();

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
  const gap      = PIPE_GAP_PX(); // capture gap at spawn time

  const topEl = document.createElement('div');
  topEl.className = 'pipe pipe-top';
  document.body.appendChild(topEl);

  const botEl = document.createElement('div');
  botEl.className = 'pipe pipe-bottom';
  document.body.appendChild(botEl);

  const pipe = { x: window.innerWidth, topEl, botEl, scored: false, gapRatio, pipeW, gap };
  pipes.push(pipe);
  applyPipeDimensions(pipe);

  // Spawn a collectible in this pipe's gap
  spawnCollectible(pipe);
}

function applyPipeDimensions(pipe) {
  const H    = window.innerHeight;
  const gap  = pipe.gap || PIPE_GAP_PX();
  const gapC = pipe.gapRatio * H;
  const topH = Math.max(1, gapC - gap / 2);
  const botT = gapC + gap / 2;
  const botH = Math.max(1, H - botT);

  pipe.topEl.style.cssText = `position:fixed;width:${pipe.pipeW}px;height:${topH}px;top:0;left:${pipe.x}px;z-index:20;background-image:url('images/pipes/toppipe.png');background-repeat:no-repeat;background-size:100% 100%;`;
  pipe.botEl.style.cssText = `position:fixed;width:${pipe.pipeW}px;height:${botH}px;top:${botT}px;left:${pipe.x}px;z-index:20;background-image:url('images/pipes/bottompipe.png');background-repeat:no-repeat;background-size:100% 100%;`;
}

// ── Collectibles ──────────────────────────────────────────────────────────────
// Spawned in the center of each pipe gap. 30% seed, 15% gold, 55% nothing.
function spawnCollectible(pipe) {
  const roll = Math.random();
  let type = null;
  if (roll < 0.15)       type = 'gold';
  else if (roll < 0.45)  type = 'seed';
  if (!type) return;

  const H    = window.innerHeight;
  const gap  = pipe.gap;
  const gapC = pipe.gapRatio * H;
  // Center of the gap
  const cy   = gapC; // vertical center of the gap opening
  const cx   = pipe.x + pipe.pipeW / 2 - COLLECTIBLE_SIZE / 2;

  const el = document.createElement('img');
  el.src       = type === 'seed' ? 'images/seed.png' : 'images/gold.png';
  el.className = 'collectible collectible-' + type;
  el.style.cssText = `position:fixed;width:${COLLECTIBLE_SIZE}px;height:${COLLECTIBLE_SIZE}px;left:${cx}px;top:${cy - COLLECTIBLE_SIZE/2}px;z-index:25;pointer-events:none;`;
  document.body.appendChild(el);

  collectibles.push({ el, x: cx, y: cy - COLLECTIBLE_SIZE / 2, type, collected: false });
}

function updateCollectibles() {
  const birdRect = birdWrap.getBoundingClientRect();

  for (let i = collectibles.length - 1; i >= 0; i--) {
    const c = collectibles[i];
    if (c.collected) continue;

    // Move with pipes
    c.x -= MOVE_SPEED;
    c.el.style.left = c.x + 'px';

    // Remove if off-screen
    if (c.x + COLLECTIBLE_SIZE < 0) {
      c.el.remove();
      collectibles.splice(i, 1);
      continue;
    }

    // Collision with bird (generous hitbox)
    const cr = { left: c.x, right: c.x + COLLECTIBLE_SIZE, top: c.y, bottom: c.y + COLLECTIBLE_SIZE };
    const margin = 6;
    const hit = !(birdRect.right  - margin < cr.left   + margin ||
                  birdRect.left   + margin > cr.right  - margin ||
                  birdRect.bottom - margin < cr.top    + margin ||
                  birdRect.top    + margin > cr.bottom - margin);

    if (hit) {
      c.collected = true;
      if (c.type === 'seed') seedsCollected++;
      if (c.type === 'gold') goldCollected++;
      showCollectPop(c.type, c.x + COLLECTIBLE_SIZE / 2, c.y);
      c.el.remove();
      collectibles.splice(i, 1);
    }
  }
}

function showCollectPop(type, x, y) {
  const el = document.createElement('div');
  el.className   = 'collect-pop collect-pop-' + type;
  el.textContent = type === 'seed' ? '🌱 +1' : '🪙 +1';
  el.style.cssText = `position:fixed;left:${x}px;top:${y}px;z-index:200;pointer-events:none;`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 700);
}


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
      </tr>`).join('');
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
  if (isFs) { exitFullscreen(); } else { requestFullscreen(); }
});

function onFullscreenChange() {
  if (fsBtn) {
    const isFs = document.fullscreenElement || document.webkitFullscreenElement
               || document.mozFullScreenElement;
    fsBtn.textContent = isFs ? '✕' : '⛶';
  }
  onResize();
}

document.addEventListener('fullscreenchange',       onFullscreenChange);
document.addEventListener('webkitfullscreenchange', onFullscreenChange);
document.addEventListener('mozfullscreenchange',    onFullscreenChange);

playBtn.addEventListener('click', async () => {
  if (currentEnergy <= 0) return; // guard — button should already be disabled
  const ok = await useEnergy();
  if (!ok) return;
  requestFullscreen();
  startGame();
});
restartBtn.addEventListener('click', () => {
  // Go back to start screen so player sees updated energy before committing
  gameOverScreen.style.display = 'none';
  showStart();
});
window.addEventListener('resize',   onResize);

init();
