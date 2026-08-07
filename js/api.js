/* ============================================================
   api.js — Cloud Run API client.

   Transport functions:
     _crGet(path, params)      — GET  with Bearer token + 401 auto-refresh
     _crPost(path, body)       — POST JSON with Bearer token + 401 auto-refresh
     _crPatch(path, body)      — PATCH JSON with Bearer token + 401 auto-refresh
     _crDelete(path)           — DELETE with Bearer token + 401 auto-refresh
     _crMultipart(path, file)  — POST multipart/form-data (file uploads)

   Auth endpoints use raw transport to break the refresh retry loop.
   ============================================================ */

const API = (() => {

  function getToken() {
    return sessionStorage.getItem(CONFIG.SESSION_KEY) || null;
  }

  /* ── 401 interceptor — auto-refresh + forced logout ──────── */
  let _refreshPromise = null;

  function _forceLogout() {
    // Clear BOTH storages — Phase A "Remember this device" stores the
    // refresh token + identity in localStorage when the user opted in.
    // A forced logout must wipe both or the next page-load will silently
    // restore the killed session.
    for (const key of [CONFIG.SESSION_KEY, CONFIG.USER_KEY, CONFIG.ORG_KEY, CONFIG.MEMBERSHIPS_KEY, 'patman_refresh_token']) {
      sessionStorage.removeItem(key);
      localStorage.removeItem(key);
    }
    localStorage.removeItem('patman_remembered');
    window.dispatchEvent(new CustomEvent('auth:logout'));
  }

  // Read the refresh token from whichever storage currently has it.
  // localStorage (remembered devices) takes priority because if both
  // are populated, the remembered one is the canonical source of
  // truth — sessionStorage is just a per-tab cache of it.
  function _readRefresh() {
    return localStorage.getItem('patman_refresh_token')
        || sessionStorage.getItem('patman_refresh_token')
        || null;
  }

  // Persist a rotated refresh token to whichever storage was
  // originally used. Detected by which storage CURRENTLY holds a
  // token at write time — covers the "remember" case (localStorage)
  // and the per-tab case (sessionStorage) without needing the
  // remember flag plumbed everywhere.
  function _writeRefresh(token) {
    if (!token) return;
    if (localStorage.getItem('patman_refresh_token') !== null) {
      localStorage.setItem('patman_refresh_token', token);
    } else {
      sessionStorage.setItem('patman_refresh_token', token);
    }
  }

  function _attemptRefresh() {
    if (_refreshPromise) return _refreshPromise;
    const storedRefresh      = _readRefresh();
    const storedMembershipId = _getMembershipIdFromToken();
    if (!storedRefresh) { _forceLogout(); return Promise.reject(new Error('Session expired')); }
    _refreshPromise = _crPostRaw('/auth/refresh', { refresh_token: storedRefresh, membership_id: storedMembershipId })
      .then(data => {
        sessionStorage.setItem(CONFIG.SESSION_KEY, data.access_token);
        if (data.refresh_token) _writeRefresh(data.refresh_token);
      })
      .catch(async err => {
        // Multi-tab race: another tab may have rotated the refresh
        // token between when we read it (storedRefresh) and when the
        // server processed our request. Server returns 401 because
        // our copy is now revoked. Re-read storage — if a different
        // token is there now, retry ONCE before giving up.
        if (err.status === 401) {
          const current = _readRefresh();
          if (current && current !== storedRefresh) {
            try {
              const data = await _crPostRaw('/auth/refresh', { refresh_token: current, membership_id: storedMembershipId });
              sessionStorage.setItem(CONFIG.SESSION_KEY, data.access_token);
              if (data.refresh_token) _writeRefresh(data.refresh_token);
              return;
            } catch {
              _forceLogout();
              throw err;
            }
          }
          _forceLogout();
          throw err;
        }
        // 503/500/network errors = server issue — keep session so the
        // user is not ejected due to a backend outage.
        if (!err.status) _forceLogout();
        throw err;
      })
      .finally(() => { _refreshPromise = null; });
    return _refreshPromise;
  }

  function _getMembershipIdFromToken() {
    const token = getToken();
    if (!token) return null;
    try {
      return JSON.parse(atob(token.split('.')[1])).membership_id || null;
    } catch { return null; }
  }

  /* ── Shared fetch helpers ────────────────────────────────── */
  async function _fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(id);
      return res;
    } catch (err) {
      clearTimeout(id);
      if (err.name === 'AbortError') throw new Error('Request timed out. Please try again.');
      throw err;
    }
  }

  async function _parseResponse(res) {
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { /* non-JSON — fall through */ }

    if (!res.ok) {
      const message = parsed?.error || `HTTP ${res.status}: ${res.statusText}`;
      const err     = new Error(message);
      err.status    = res.status;
      if (parsed?.success === false) err.serverError = true;
      throw err;
    }

    if (parsed?.success === false) {
      const err     = new Error(parsed.error || 'Server returned an error.');
      err.serverError = true;
      throw err;
    }
    return parsed?.data !== undefined ? parsed.data : parsed;
  }

  /* ── GET ─────────────────────────────────────────────────── */
  async function _crGetRaw(path, params = {}) {
    const tok = getToken();
    const url = new URL(CONFIG.CLOUD_RUN_URL + path);
    for (const [k, v] of Object.entries(params)) {
      if (v == null || v === '') continue;
      url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    const res = await _fetchWithTimeout(url.toString(), {
      method: 'GET',
      headers: tok ? { Authorization: `Bearer ${tok}` } : {},
    }, CONFIG.TIMEOUT_MS);
    return _parseResponse(res);
  }

  async function _crGet(path, params = {}) {
    try { return await _crGetRaw(path, params); }
    catch (err) {
      if (err.status !== 401) throw err;
      await _attemptRefresh();
      return _crGetRaw(path, params);
    }
  }

  /* ── GET (raw Blob — for CSV exports) ───────────────────── */
  async function _crGetBlobRaw(path, params = {}) {
    const tok = getToken();
    const url = new URL(CONFIG.CLOUD_RUN_URL + path);
    for (const [k, v] of Object.entries(params)) {
      if (v == null || v === '') continue;
      url.searchParams.set(k, String(v));
    }
    const res = await _fetchWithTimeout(url.toString(), {
      method: 'GET',
      headers: tok ? { Authorization: `Bearer ${tok}` } : {},
    }, 120000);
    if (!res.ok) {
      const err = new Error(`Export failed: HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.blob();
  }

  async function _crGetBlob(path, params = {}) {
    try { return await _crGetBlobRaw(path, params); }
    catch (err) {
      if (err.status !== 401) throw err;
      await _attemptRefresh();
      return _crGetBlobRaw(path, params);
    }
  }

  /* ── POST ────────────────────────────────────────────────── */
  async function _crPostRaw(path, body) {
    const tok = getToken();
    const res = await _fetchWithTimeout(CONFIG.CLOUD_RUN_URL + path, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
      body:    JSON.stringify(body),
    }, CONFIG.TIMEOUT_MS);
    return _parseResponse(res);
  }

  async function _crPost(path, body) {
    try { return await _crPostRaw(path, body); }
    catch (err) {
      if (err.status !== 401) throw err;
      await _attemptRefresh();
      return _crPostRaw(path, body);
    }
  }

  /* ── PATCH ───────────────────────────────────────────────── */
  async function _crPatchRaw(path, body) {
    const tok = getToken();
    const res = await _fetchWithTimeout(CONFIG.CLOUD_RUN_URL + path, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
      body:    JSON.stringify(body),
    }, CONFIG.TIMEOUT_MS);
    return _parseResponse(res);
  }

  async function _crPatch(path, body) {
    try { return await _crPatchRaw(path, body); }
    catch (err) {
      if (err.status !== 401) throw err;
      await _attemptRefresh();
      return _crPatchRaw(path, body);
    }
  }

  /* ── DELETE ──────────────────────────────────────────────── */
  async function _crDeleteRaw(path, body) {
    const tok = getToken();
    const headers = tok ? { Authorization: `Bearer ${tok}` } : {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await _fetchWithTimeout(CONFIG.CLOUD_RUN_URL + path, {
      method:  'DELETE',
      headers,
      body:    body !== undefined ? JSON.stringify(body) : undefined,
    }, CONFIG.TIMEOUT_MS);
    return _parseResponse(res);
  }

  async function _crDelete(path, body) {
    try { return await _crDeleteRaw(path, body); }
    catch (err) {
      if (err.status !== 401) throw err;
      await _attemptRefresh();
      return _crDeleteRaw(path, body);
    }
  }

  /* ── MULTIPART (file upload) ─────────────────────────────── */
  // Sends a File object as multipart/form-data.
  // Do NOT set Content-Type — the browser sets it with the boundary automatically.
  //
  // Uploads use a much longer timeout than regular API calls because bulk
  // Add/Update/Remove pipelines run against BigQuery DML which can take
  // minutes for tens of thousands of rows. 5 minutes covers the typical
  // worst case (100K-row removes ≈ 2–3 minutes server-side).
  const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;

  async function _crMultipartRaw(path, file) {
    const tok      = getToken();
    const formData = new FormData();
    formData.append('file', file, file.name);
    const res = await _fetchWithTimeout(CONFIG.CLOUD_RUN_URL + path, {
      method:  'POST',
      headers: tok ? { Authorization: `Bearer ${tok}` } : {},
      body:    formData,
    }, UPLOAD_TIMEOUT_MS);
    return _parseResponse(res);
  }

  async function _crMultipart(path, file) {
    try { return await _crMultipartRaw(path, file); }
    catch (err) {
      if (err.status !== 401) throw err;
      await _attemptRefresh();
      return _crMultipartRaw(path, file);
    }
  }

  /* ── Public API ─────────────────────────────────────────── */
  return {

    /* Auth — raw transport: never trigger 401 refresh on auth endpoints.
       Phase A "Remember this device" (2026-05-18): login + select-org
       now accept a `remember` flag; logout POSTs the current refresh
       token so the server can revoke it (audit C2 fix). */
    async login(username, password, remember = false) {
      const data = await _crPostRaw('/auth/login', { username, password, remember: !!remember });
      // data shape differs: single-org vs multi-org
      return data;
    },

    async selectOrg(pendingToken, membershipId, remember) {
      const body = { membership_id: membershipId };
      if (remember !== undefined) body.remember = !!remember;
      const res = await _fetchWithTimeout(CONFIG.CLOUD_RUN_URL + '/auth/select-org', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pendingToken}` },
        body:    JSON.stringify(body),
      }, CONFIG.TIMEOUT_MS);
      return _parseResponse(res);
    },

    async switchOrg(membershipId) {
      return _crPost('/auth/switch-org', { membership_id: membershipId });
    },

    // Server-side logout: revokes the refresh token in the
    // refresh_tokens table. Storage clearing happens in Auth.logout
    // (js/auth.js) — this method ONLY hits the server. Best-effort:
    // network / 503 failures don't block local logout.
    async logout(refreshToken) {
      try {
        await _crPostRaw('/auth/logout', refreshToken ? { refresh_token: refreshToken } : {});
      } catch { /* best-effort; local logout still proceeds */ }
    },

    async refreshToken(refreshToken, membershipId) {
      return _crPostRaw('/auth/refresh', { refresh_token: refreshToken, membership_id: membershipId });
    },

    async verifySession() {
      const user = JSON.parse(sessionStorage.getItem(CONFIG.USER_KEY) || 'null');
      if (user) return { user };
      throw new Error('No session');
    },

    /* Dashboard */
    async getDashboardKPIs()                        { return _crGet('/dashboard/kpis'); },
    async getPerformanceData(weeks=12, platform='') { return _crGet('/dashboard/performance', { weeks, ...(platform ? { platform } : {}) }); },
    async getInventoryAnalytics()                   { return _crGet('/dashboard/inventory-analytics'); },

    /* Lookup */
    async lookup(query) { return _crGet('/lookup', { query }); },

    /* Inventory — SKU View is the canonical inventory page, one row per SKU.
       Backed by the same metrics engine that powers dashboard KPIs. */
    async getSkuSummary(page=1, pageSize=CONFIG.PAGE_SIZE, search='', options={}) { return _crGet('/inventory/sku-summary', { page, pageSize, search, ...options }); },
    async getRawRowsBySku(sku)                                                    { return _crGet('/inventory/by-sku', { sku }); },
    async exportSkuSummary(filters={})                                            { return _crGetBlob('/inventory/sku-summary/export', filters); },
    async exportInventoryListRaw(filters={})                                      { return _crGetBlob('/inventory/sku-summary/export-raw', filters); },

    /* Orders */
    async getOrders(page=1, pageSize=CONFIG.PAGE_SIZE, filters={}) { return _crGet('/orders', { page, pageSize, ...filters }); },
    async exportOrders(filters={})    { return _crGetBlob('/orders/export', filters); },
    async getPlatforms()                                            { return _crGet('/orders/platforms'); },
    async deleteOrders(payload)                                     { return _crDelete('/orders/rows', payload); },
    async updateOrder(rowId, updates)                               { return _crPatch(`/orders/${encodeURIComponent(rowId)}`, updates); },

    /* Inventory */
    async getInventoryAlternatives(sku)                                        { return _crGet('/inventory/alternatives', { sku }); },
    // rowUid is the canonical inventory row tracker (NOT the SKU — SKUs can be duplicated).
    async updateInventory(rowUid, updates)                                     { return _crPatch(`/inventory/${encodeURIComponent(rowUid)}`, updates); },
    async deleteInventoryRows(rowUids)                                         { return _crDelete('/inventory/rows', { row_uids: rowUids }); },

    /* Activity */
    async getActivity(limit=10)                                                { return _crGet('/activity', { limit }); },
    async getLogs(limit=20)                                                   { return _crGet('/activity', { limit }); },

    /* Uploads — file is a File object (multipart).
       Phase A async lifecycle (2026-05-18): these now return 202 with
       { upload_id, status: 'accepted' }. Use getUploadStatus(uploadId)
       to poll for terminal status — see js/uploads.js _doUpload. */
    async uploadInventory(file) { return _crMultipart('/uploads/inventory', file); },
    async uploadOrders(file)    { return _crMultipart('/uploads/orders', file); },
    async getUploadStatus(uploadId) { return _crGet(`/uploads/status/${encodeURIComponent(uploadId)}`); },
    async getUploadHistory(type='') { return _crGet('/uploads/history', { type }); },
    async downloadTemplate(type)    { return _crGet(`/uploads/template/${type}`); },

    /* Users / Memberships */
    async getUsers()                         { return _crGet('/users'); },
    async checkUsername(username)            { return _crGet('/users/check-username', { username }); },
    async createUser(userData)               { return _crPost('/users', userData); },
    async updateUser(membershipId, updates)  { return _crPatch(`/users/${membershipId}`, updates); },
    async deleteUser(membershipId)           { return _crDelete(`/users/${membershipId}`); },
    // Permanent (irreversible) hard delete — only allowed once the user
    // is already deactivated. Removes the user row + every membership
    // + every refresh token. Activity log entries are intentionally
    // preserved server-side for audit.
    async permanentDeleteUser(userId)        { return _crDelete(`/users/${userId}/permanent`); },

    /* Memberships */
    async getMemberships()                   { return _crGet('/memberships'); },
    async updateMembership(id, updates)      { return _crPatch(`/memberships/${id}`, updates); },
    async removeMembership(id)               { return _crDelete(`/memberships/${id}`); },

    /* Organizations */
    async getOrganizations()                 { return _crGet('/organizations'); },
    async createOrganization(data)           { return _crPost('/organizations', data); },
    async updateOrganization(id, updates)    { return _crPatch(`/organizations/${id}`, updates); },
    // Permanent (irreversible) hard delete with full cascade. Only
    // allowed once the org is_active=false AND the caller is signed
    // into a DIFFERENT org. Removes memberships, inventory, orders,
    // both upload audit tables, all four summary tables, and the
    // organizations row last.
    async permanentDeleteOrganization(id)    { return _crDelete(`/organizations/${id}/permanent`); },

    /* System */
    async ping()              { return _crGet('/health'); },
    async getSystemStatus()   { return _crGet('/health'); },

    /* Admin diagnostics — admin-role only.
       Used by Settings → System Status → Admin Operations panel for
       the Phase B parity-validation workflow. */
    async adminRefreshAllOrgs()                     { return _crPost('/admin/refresh-all-orgs', {}); },
    async adminDiagnostics()                        { return _crGet('/admin/diagnostics'); },
    async adminPurgeOldData(days = 30, pin = '')    { return _crPost('/admin/purge-old-data', { days, pin }); },
    async adminRefreshOrg(organizationId)           { return _crPost('/admin/summary-refresh', { organization_id: organizationId }); },
    async adminSummaryStatus(organizationId)        { return _crGet('/admin/summary-status', organizationId ? { org: organizationId } : {}); },
    async adminParityReport(hours = 24)             { return _crGet('/admin/parity-report', { hours }); },
    async adminRefreshHealth(hours = 24)            { return _crGet('/admin/refresh-health', { hours }); },
  };
})();
