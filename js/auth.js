/* ============================================================
   auth.js — Login flow, org selection, session management,
             idle timeout, cross-tab logout sync.
   ============================================================ */

const Auth = (() => {

  const REFRESH_KEY     = 'patman_refresh_token';
  const REMEMBER_KEY    = 'patman_remembered';
  const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
  const _channel        = typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel('patman_auth') : null;

  let _idleTimer = null;

  /* ── Session storage ──────────────────────────────────────────
     Phase A "Remember this device" (2026-05-18):

       • Non-remembered (default): everything in sessionStorage,
         per-tab, dies on tab close. Matches pre-2026-05-18 behavior.

       • Remembered: refresh token + user identity + org + memberships
         in localStorage (survives browser restart). Access token
         still in sessionStorage — it's short-lived and per-tab is the
         right scope; on a fresh tab we silently refresh from the
         localStorage refresh token to mint a new access token.

     The "remembered" flag itself lives in localStorage so any tab can
     answer "is this a remembered device?" without parsing the JWT.
  */
  function _store(remembered) {
    return remembered ? localStorage : sessionStorage;
  }

  function isRemembered() {
    return localStorage.getItem(REMEMBER_KEY) === '1';
  }

  function saveSession(token, user, organization, refreshToken, memberships, remembered) {
    // When `remembered` is omitted (e.g. refresh in /auth.js below
    // re-saving), preserve the existing preference.
    const effectiveRemembered = (typeof remembered === 'boolean')
      ? remembered
      : isRemembered();
    const store = _store(effectiveRemembered);

    // Access token always lives in sessionStorage (per-tab, short-lived).
    sessionStorage.setItem(CONFIG.SESSION_KEY, token);

    // Identity + refresh token go to the chosen store.
    store.setItem(CONFIG.USER_KEY,        JSON.stringify(user));
    store.setItem(CONFIG.ORG_KEY,         JSON.stringify(organization));
    if (refreshToken) store.setItem(REFRESH_KEY, refreshToken);
    if (memberships)  store.setItem(CONFIG.MEMBERSHIPS_KEY, JSON.stringify(memberships));

    // Persist the "remembered" preference itself. localStorage so a
    // fresh tab can read it before any auth state has been restored.
    if (effectiveRemembered) localStorage.setItem(REMEMBER_KEY, '1');
    else                     localStorage.removeItem(REMEMBER_KEY);

    // If we're flipping from non-remembered → remembered, also nuke
    // any stale sessionStorage copy of the same keys so reads from
    // _readEither() always get the canonical localStorage value.
    if (effectiveRemembered) {
      sessionStorage.removeItem(CONFIG.USER_KEY);
      sessionStorage.removeItem(CONFIG.ORG_KEY);
      sessionStorage.removeItem(CONFIG.MEMBERSHIPS_KEY);
      sessionStorage.removeItem(REFRESH_KEY);
    }

    console.log('[AUTH] saveSession — org:', organization?.organization_id, 'memberships:', Array.isArray(memberships) ? memberships.length : memberships, 'hasRefresh:', !!refreshToken, 'remembered:', effectiveRemembered);
  }

  function clearSession() {
    for (const key of [CONFIG.SESSION_KEY, CONFIG.USER_KEY, CONFIG.ORG_KEY, CONFIG.MEMBERSHIPS_KEY, REFRESH_KEY]) {
      sessionStorage.removeItem(key);
      localStorage.removeItem(key);
    }
    localStorage.removeItem(REMEMBER_KEY);
  }

  // Read a key from whichever store currently has it. localStorage
  // wins when both are populated (canonical for remembered devices);
  // falls back to sessionStorage for per-tab sessions.
  function _readEither(key) {
    return localStorage.getItem(key) ?? sessionStorage.getItem(key) ?? null;
  }

  function _decodeJwt(token) {
    try { return JSON.parse(atob(token.split('.')[1])); } catch { return null; }
  }

  function getToken()   { return sessionStorage.getItem(CONFIG.SESSION_KEY) || null; }
  function isLoggedIn() { return !!getToken(); }

  function getUser() {
    const stored = _readEither(CONFIG.USER_KEY);
    if (stored) { try { const u = JSON.parse(stored); if (u) return u; } catch {} }
    // Fallback: reconstruct from JWT payload so a partial session still works.
    const token = getToken();
    if (token) {
      const p = _decodeJwt(token);
      if (p?.user_id) {
        const u = { user_id: p.user_id, username: p.username, display_name: p.display_name };
        _store(isRemembered()).setItem(CONFIG.USER_KEY, JSON.stringify(u));
        return u;
      }
    }
    return null;
  }

  function getOrganization() {
    const stored = _readEither(CONFIG.ORG_KEY);
    if (stored) { try { const o = JSON.parse(stored); if (o) return o; } catch {} }
    // Fallback: reconstruct from JWT payload — handles old sessions missing org data.
    const token = getToken();
    if (token) {
      const p = _decodeJwt(token);
      if (p?.organization_id && p?.membership_id) {
        const o = {
          organization_id: p.organization_id,
          membership_id:   p.membership_id,
          role:            p.role,
          display_name:    p.org_display_name || '—',
          slug:            p.org_slug || '',
        };
        _store(isRemembered()).setItem(CONFIG.ORG_KEY, JSON.stringify(o));
        return o;
      }
    }
    return null;
  }

  function getMemberships() {
    try {
      const parsed = JSON.parse(_readEither(CONFIG.MEMBERSHIPS_KEY));
      return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
    } catch { return []; }
  }

  function _getRefreshToken() {
    return _readEither(REFRESH_KEY);
  }

  function _getMembershipId() {
    const token = getToken();
    if (!token) return null;
    try { return JSON.parse(atob(token.split('.')[1])).membership_id || null; }
    catch { return null; }
  }

  /* ── Idle timeout ─────────────────────────────────────────── */
  function _resetIdleTimer() {
    clearTimeout(_idleTimer);
    _idleTimer = setTimeout(() => {
      logout();
      if (typeof Notify !== 'undefined') Notify.warning?.('Signed out due to inactivity.');
    }, IDLE_TIMEOUT_MS);
  }

  function startIdleWatch() {
    ['mousemove', 'keydown', 'click', 'touchstart', 'scroll'].forEach(
      e => document.addEventListener(e, _resetIdleTimer, { passive: true })
    );
    _resetIdleTimer();
  }

  function stopIdleWatch() {
    clearTimeout(_idleTimer);
    _idleTimer = null;
    ['mousemove', 'keydown', 'click', 'touchstart', 'scroll'].forEach(
      e => document.removeEventListener(e, _resetIdleTimer)
    );
  }

  // Canonical 3-tier role hierarchy. Legacy aliases (staff/operator/user/view)
  // collapse to the closest canonical tier so old JWTs still resolve.
  const ROLE_LEVEL = {
    admin:    3,
    manager:  2, staff:    2, operator: 2, user: 2,  // legacy → manager
    viewer:   1, view:     1,                         // legacy → viewer
  };

  function hasRole(required) {
    const org = getOrganization();
    if (!org) return false;
    return (ROLE_LEVEL[org.role] || 0) >= (ROLE_LEVEL[required] || 0);
  }

  /* ── Login UI ─────────────────────────────────────────────── */
  let _loginForm     = null;
  let _loginError    = null;
  let _loginBtn      = null;
  let _usernameInput = null;
  let _passwordInput = null;
  let _rememberInput = null;

  // Org selector state — _pendingRemember is captured from the login
  // checkbox so the eventual /auth/select-org call uses the same
  // preference, even though the org-selector screen has no UI for it.
  let _pendingToken       = null;
  let _pendingUser        = null;
  let _pendingMemberships = [];
  let _pendingRemember    = false;

  function _bindLoginUI() {
    _loginForm     = document.getElementById('login-form');
    _loginError    = document.getElementById('login-error');
    _loginBtn      = document.getElementById('login-btn');
    _usernameInput = document.getElementById('login-username');
    _passwordInput = document.getElementById('login-password');
    _rememberInput = document.getElementById('login-remember');

    // Restore the remembered preference into the checkbox so the user
    // sees their last choice. (Cosmetic; the storage flag is what
    // actually controls behavior.)
    if (_rememberInput) _rememberInput.checked = isRemembered();

    if (_loginForm) {
      _loginForm.addEventListener('submit', async e => {
        e.preventDefault();
        await _doLogin();
      });
    }

    // Org selector: clicking a workspace card
    const orgList = document.getElementById('org-list');
    if (orgList) {
      orgList.addEventListener('click', async e => {
        const card = e.target.closest('[data-membership-id]');
        if (!card) return;
        await _selectOrg(card.dataset.membershipId);
      });
    }

    // Back button from org selector
    const backBtn = document.getElementById('org-selector-back');
    if (backBtn) {
      backBtn.addEventListener('click', () => {
        _pendingToken = null;
        _pendingUser  = null;
        _pendingMemberships = [];
        _showScreen('login');
      });
    }
  }

  function _showError(msg) {
    if (_loginError) { _loginError.textContent = msg; _loginError.classList.add('visible'); }
  }
  function _hideError() {
    if (_loginError) _loginError.classList.remove('visible');
  }

  function _showScreen(screen) {
    document.getElementById('login-screen')?.style.setProperty('display', screen === 'login' ? 'flex' : 'none');
    document.getElementById('org-selector-screen')?.style.setProperty('display', screen === 'org' ? 'flex' : 'none');
    document.getElementById('app-shell')?.style.setProperty('display', screen === 'app' ? 'flex' : 'none');
    document.getElementById('loading-screen')?.style.setProperty('display', 'none');
  }

  async function _doLogin() {
    const username = _usernameInput?.value.trim();
    const password = _passwordInput?.value;
    const remember = !!_rememberInput?.checked;

    _hideError();
    if (!username || !password) { _showError('Please enter your username and password.'); return; }

    Loading.btn(_loginBtn, true);

    try {
      const result = await API.login(username, password, remember);

      if (result.requires_org_selection) {
        // Multi-org: show workspace selector
        _pendingToken       = result.pending_token;
        _pendingUser        = result.user;
        _pendingMemberships = result.memberships;
        _pendingRemember    = remember;
        _passwordInput.value = '';
        _showOrgSelector(result.user, result.memberships);
      } else {
        // Single-org: auto-entered
        _passwordInput.value = '';
        saveSession(result.access_token, result.user, result.organization, result.refresh_token, [result.organization], remember);
        App.showApp();
      }
    } catch (err) {
      _showError(err.message || 'Login failed. Check your credentials.');
    } finally {
      Loading.btn(_loginBtn, false);
    }
  }

  function _showOrgSelector(user, memberships) {
    const nameEl = document.getElementById('org-selector-user-name');
    if (nameEl) nameEl.textContent = user.display_name || user.username;

    const orgList = document.getElementById('org-list');
    if (orgList) {
      orgList.innerHTML = memberships.map(m => `
        <div class="org-card" data-membership-id="${Utils.escapeHtml(m.membership_id)}" style="cursor:pointer;padding:14px 16px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--r-sm);margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;transition:background .15s">
          <div>
            <div style="font-weight:600;font-size:14px;color:var(--txt-1)">${Utils.escapeHtml(m.display_name)}</div>
            <div style="font-size:12px;color:var(--txt-3);margin-top:2px">${Utils.badgeHtml(m.role === 'admin' ? 'error' : m.role === 'manager' ? 'warning' : 'gray', Utils.capitalize(m.role))}</div>
          </div>
          <span style="color:var(--txt-4);font-size:18px">→</span>
        </div>`
      ).join('');

      // Hover effect
      orgList.querySelectorAll('.org-card').forEach(card => {
        card.addEventListener('mouseenter', () => { card.style.background = 'var(--surface-3)'; });
        card.addEventListener('mouseleave', () => { card.style.background = 'var(--surface-2)'; });
      });
    }

    const errEl = document.getElementById('org-selector-error');
    if (errEl) { errEl.textContent = ''; errEl.classList.remove('visible'); }

    _showScreen('org');
  }

  async function _selectOrg(membershipId) {
    if (!_pendingToken) { _showScreen('login'); return; }

    const cards = document.querySelectorAll('#org-list [data-membership-id]');
    cards.forEach(c => c.style.opacity = '0.5');

    try {
      const result = await API.selectOrg(_pendingToken, membershipId, _pendingRemember);
      _pendingToken = null;
      _pendingUser  = null;

      saveSession(result.access_token, result.user, result.organization, result.refresh_token, _pendingMemberships, _pendingRemember);
      _pendingMemberships = [];
      _pendingRemember    = false;
      App.showApp();
    } catch (err) {
      cards.forEach(c => c.style.opacity = '');
      const errEl = document.getElementById('org-selector-error');
      if (errEl) { errEl.textContent = err.message || 'Failed to enter workspace.'; errEl.classList.add('visible'); }
    }
  }

  /* ── Org switching (in-app) ──────────────────────────────── */
  // Performs a full state reset before showing the new org. While in flight,
  // a fullscreen interaction lock prevents the user from clicking anything
  // that would render stale data from the previous org.
  async function switchOrg(membershipId) {
    Loading.lock(true, 'Switching organization…');
    try {
      const result      = await API.switchOrg(membershipId);
      const currentUser = getUser();

      // Wipe all frontend caches/state BEFORE persisting the new org. This
      // guarantees that nothing in the next render cycle can read stale data.
      App.resetAllState();

      // Force navigation hash to dashboard so showApp() doesn't restore a
      // page that was bound to the previous org's data.
      try { history.replaceState(null, '', '#dashboard'); } catch {}

      // Server returns a freshly-rotated refresh_token — persist THAT one,
      // not the old refresh in storage. With server-side revocation now
      // active (Phase A, 2026-05-18), reusing the old token would be
      // rejected on next refresh.
      saveSession(
        result.access_token, currentUser, result.organization,
        result.refresh_token || _getRefreshToken(),
        getMemberships(),
        isRemembered(),
      );

      App.showApp();
    } catch (err) {
      if (typeof Notify !== 'undefined') Notify.error('Switch failed', err.message);
    } finally {
      Loading.lock(false);
    }
  }

  /* ── Logout ───────────────────────────────────────────────── */
  async function logout() {
    stopIdleWatch();
    _channel?.postMessage({ type: 'logout' });
    // Hand the refresh token to the server so it can revoke the row
    // in refresh_tokens. Best-effort — local clear still happens
    // even if the network call fails (audit C2 fix, 2026-05-18).
    const refresh = _getRefreshToken();
    try { await API.logout(refresh); } catch { /* local clear still proceeds */ }
    clearSession();
    App.showLogin();
  }

  /* ── JWT expiry helper ─────────────────────────────────────── */
  function _tokenExpiresAt(token) {
    try { const p = JSON.parse(atob(token.split('.')[1])); return p.exp ? p.exp * 1000 : null; }
    catch { return null; }
  }

  /* ── Session verification on page load ──────────────────── */
  async function checkSession() {
    console.log('[AUTH] restore started');
    let token = getToken();

    // ── Step 0: silent restore from localStorage (remembered devices).
    // Access token is per-tab (sessionStorage) so a fresh browser tab
    // has none — but if the user opted into "Remember this device" we
    // still have a refresh token in localStorage. Use it to mint a
    // fresh access token before declaring the session dead.
    if (!token && _getRefreshToken()) {
      const refresh = _getRefreshToken();
      console.log('[AUTH] no access token but found refresh in storage — silent restore');
      try {
        const data = await API.refreshToken(refresh, null);
        sessionStorage.setItem(CONFIG.SESSION_KEY, data.access_token);
        if (data.refresh_token) {
          _store(isRemembered()).setItem(REFRESH_KEY, data.refresh_token);
        }
        token = data.access_token;
        console.log('[AUTH] silent restore succeeded');
      } catch (err) {
        console.warn('[AUTH] silent restore failed', err.status, err.message);
        // 401 = token actually revoked/expired → clear and show login.
        // Other errors = transient; clear refresh to avoid loops.
        clearSession();
        return false;
      }
    }

    if (!token) { console.log('[AUTH] no token — showing login'); return false; }
    console.log('[AUTH] token restored');

    // ── Step 1: Reconstruct memberships from JWT if storage is empty/stale.
    // Must happen BEFORE any refresh call so saveSession gets the right memberships.
    const rawMemberships = _readEither(CONFIG.MEMBERSHIPS_KEY);
    console.log('[AUTH] raw memberships storage:', rawMemberships);
    let memberships = getMemberships();

    if (memberships.length === 0) {
      const p = _decodeJwt(token);
      console.log('[AUTH] JWT fields for reconstruction — org_id:', p?.organization_id, 'mbr_id:', p?.membership_id, 'role:', p?.role, 'type:', p?.type);
      if (p?.organization_id && p?.membership_id) {
        const synthetic = {
          organization_id: p.organization_id,
          membership_id:   p.membership_id,
          role:            p.role            || 'viewer',
          display_name:    p.org_display_name || '—',
          slug:            p.org_slug         || '',
        };
        memberships = [synthetic];
        _store(isRemembered()).setItem(CONFIG.MEMBERSHIPS_KEY, JSON.stringify(memberships));
        console.log('[AUTH] memberships reconstructed from JWT:', synthetic.organization_id);
      } else {
        console.warn('[AUTH] JWT missing org fields — token issued by old backend, redeploy required');
      }
    }
    console.log('[AUTH] memberships restored:', memberships.length, 'entries');

    // ── Step 2: Refresh expired token, using now-restored memberships.
    const expMs = _tokenExpiresAt(token);
    const now   = Date.now();

    if (expMs && now >= expMs) {
      console.log('[AUTH] token expired — attempting refresh');
      const storedRefresh = _getRefreshToken();
      if (!storedRefresh) { console.log('[AUTH] no refresh token — clearing session'); clearSession(); return false; }
      try {
        const data = await API.refreshToken(storedRefresh, _getMembershipId());
        saveSession(data.access_token, getUser(), getOrganization(), data.refresh_token, getMemberships(), isRemembered());
        console.log('[AUTH] token refreshed');
      } catch (err) {
        // 401 = real auth failure → logout. 503/500/network → keep session.
        console.warn('[AUTH] refresh failed', err.status, err.message);
        if (err.status === 401 || !err.status) { clearSession(); return false; }
      }
    } else if (expMs && expMs - now < 2 * 60 * 1000) {
      const storedRefresh = _getRefreshToken();
      if (storedRefresh) {
        API.refreshToken(storedRefresh, _getMembershipId())
          .then(data => saveSession(data.access_token, getUser(), getOrganization(), data.refresh_token, getMemberships(), isRemembered()))
          .catch(() => {});
      }
    }

    // ── Step 3: Restore active org — prefer stored value, fall back to memberships.
    const user = getUser();
    let   org  = getOrganization();

    if (!org && memberships.length > 0) {
      const p       = _decodeJwt(getToken());
      const matched = p?.organization_id
        ? memberships.find(m => m.organization_id === p.organization_id) ?? null
        : null;
      org = matched ?? (memberships.length === 1 ? memberships[0] : null);
      if (org) {
        _store(isRemembered()).setItem(CONFIG.ORG_KEY, JSON.stringify(org));
        console.log('[AUTH] org auto-restored from membership:', org.organization_id);
      }
    }

    console.log('[AUTH] active org restored:', org?.organization_id, org?.role);
    console.log('[AUTH] user restored:', user?.user_id, user?.username);

    const ok = !!(user && org);
    console.log('[AUTH] validation', ok ? 'success' : 'FAILED — missing user or org');
    return ok;
  }

  /* ── Role-gate UI elements ─────────────────────────────────── */
  function applyRoleVisibility() {
    const org = getOrganization();
    if (!org) return;

    const level = ROLE_LEVEL[org.role] || 0;

    document.querySelectorAll('[data-min-role]').forEach(el => {
      const required = ROLE_LEVEL[el.dataset.minRole] || 0;
      el.style.display = level >= required ? '' : 'none';
    });

    document.querySelectorAll('[data-role]').forEach(el => {
      el.style.display = el.dataset.role === org.role ? '' : 'none';
    });
  }

  /* ── Cross-tab logout sync ─────────────────────────────────── */
  if (_channel) {
    _channel.onmessage = (e) => {
      if (e.data?.type === 'logout' && isLoggedIn()) {
        stopIdleWatch();
        clearSession();
        App.showLogin();
      }
    };
  }

  window.addEventListener('auth:logout', () => {
    stopIdleWatch();
    _channel?.postMessage({ type: 'logout' });
    clearSession();
    App.showLogin();
  });

  /* ── Public ───────────────────────────────────────────────── */
  return {
    init: _bindLoginUI,
    checkSession,
    logout,
    switchOrg,
    getUser,
    getOrganization,
    getMemberships,
    getToken,
    isLoggedIn,
    isRemembered,
    hasRole,
    saveSession,
    clearSession,
    startIdleWatch,
    stopIdleWatch,
    applyRoleVisibility,
  };
})();
