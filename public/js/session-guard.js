/**
 * session-guard.js
 * Polls /api/session-check every 30 seconds.
 * If the server reports the session was kicked (another device signed in),
 * it shows an overlay and redirects to /login after a short delay.
 */
(function () {
  const POLL_INTERVAL_MS = 30 * 1000; // 30 seconds
  const REDIRECT_DELAY_MS = 3 * 1000; // 3 seconds to read the message

  function showKickedOverlay() {
    // Avoid double-showing
    if (document.getElementById('__session-kicked-overlay')) return;

    const overlay = document.createElement('div');
    overlay.id = '__session-kicked-overlay';
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:999999',
      'background:rgba(0,0,0,0.85)',
      'display:flex', 'flex-direction:column',
      'align-items:center', 'justify-content:center',
      'font-family:sans-serif', 'color:#fff', 'text-align:center', 'padding:24px',
    ].join(';');

    overlay.innerHTML = `
      <div style="background:#1a1a2e;border:2px solid #e94560;border-radius:12px;padding:32px 40px;max-width:400px;">
        <div style="font-size:2rem;margin-bottom:12px;">⚠️</div>
        <h2 style="margin:0 0 12px;font-size:1.3rem;color:#e94560;">Session Ended</h2>
        <p style="margin:0 0 8px;font-size:0.95rem;line-height:1.5;color:#ccc;">
          Your account was signed in on another device.<br>
          You have been logged out for security.
        </p>
        <p style="margin:0;font-size:0.8rem;color:#888;">Redirecting to login…</p>
      </div>
    `;

    document.body.appendChild(overlay);

    // Stop polling
    clearInterval(window.__sessionGuardInterval);

    setTimeout(() => {
      window.location.href = '/login?reason=kicked';
    }, REDIRECT_DELAY_MS);
  }

  async function checkSession() {
    try {
      const res = await fetch('/api/session-check', { credentials: 'include' });
      if (!res.ok) return; // network/server hiccup — skip this tick

      const data = await res.json();

      if (!data.valid) {
        if (data.reason === 'kicked') {
          showKickedOverlay();
        } else if (data.reason === 'unauthenticated') {
          // Session expired normally — just redirect
          clearInterval(window.__sessionGuardInterval);
          window.location.href = '/login';
        }
      }
    } catch (_) {
      // Ignore network errors — don't log out on a transient failure
    }
  }

  // Run immediately on load, then on interval
  checkSession();
  window.__sessionGuardInterval = setInterval(checkSession, POLL_INTERVAL_MS);
})();
