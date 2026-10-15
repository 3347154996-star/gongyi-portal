(() => {
  'use strict';
  const hint = document.getElementById('loginInitialPasswordHint');
  const value = document.getElementById('loginInitialPasswordValue');
  const input = document.getElementById('passwordInput');
  if (!hint || !value || !input) return;

  // This optional deployment-local notice is public to visitors, never a login fallback.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  (async () => {
    try {
      const response = await fetch('login-help.local.txt', {
        cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal
      });
      if (!response.ok) return;
      const content = await response.text();
      if (content.length > 2048) return;
      const notice = JSON.parse(content);
      if (notice?.enabled !== true || typeof notice.initialPassword !== 'string' ||
          notice.initialPassword.length < 8 || notice.initialPassword.length > 128 ||
          /[\x00-\x1f\x7f]/.test(notice.initialPassword)) return;
      value.textContent = notice.initialPassword;
      hint.hidden = false;
      input.setAttribute('aria-describedby', hint.id);
    } catch (_) {
      // Missing, invalid or unavailable notice must not prevent normal sign-in.
    } finally {
      clearTimeout(timeout);
    }
  })();
})();
