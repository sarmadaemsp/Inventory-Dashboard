/* ============================================================
   metricsEngine.js — Centralized frontend metrics cache.

   Single source of truth for all KPI data across the UI.
   Every page reads from MetricsEngine instead of making its
   own API call or computing its own formulas.

   Usage:
     const data = await MetricsEngine.load();
     const phantom = MetricsEngine.get('phantomUnits');
     MetricsEngine.invalidate();   // after uploads — forces fresh fetch
   ============================================================ */

const MetricsEngine = (() => {
  let _cache   = null;
  let _promise = null;

  async function load(force = false) {
    if (_cache && !force) return _cache;
    if (_promise && !force) return _promise;

    _promise = API.getDashboardKPIs()
      .then(data => {
        _cache   = data;
        _promise = null;
        return data;
      })
      .catch(err => {
        _promise = null;
        throw err;
      });

    return _promise;
  }

  function get(field) {
    return _cache?.[field] ?? null;
  }

  function getAll() {
    return _cache ?? {};
  }

  function invalidate() {
    _cache   = null;
    _promise = null;
  }

  return { load, get, getAll, invalidate };
})();
