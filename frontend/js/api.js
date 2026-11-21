/* Backend API calls. */
window.Api = (() => {
  async function get(path, params, signal) {
    const qs = params
      ? "?" + new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "")).toString()
      : "";
    let resp;
    try {
      resp = await fetch(path + qs, { signal, headers: { Accept: "application/json" } });
    } catch (e) {
      if (e.name === "AbortError") throw e;
      const err = new Error("Cannot reach the local server. Is it running?");
      err.status = 0;
      throw err;
    }
    let body = null;
    try { body = await resp.json(); } catch { /* non-JSON */ }
    if (!resp.ok) {
      const err = new Error((body && body.detail) || `Request failed (${resp.status})`);
      err.status = resp.status;
      throw err;
    }
    return body;
  }
  return {
    health: () => get("/api/health"),
    clock: () => get("/api/clock"),
    search: (q, signal) => get("/api/search", { q }, signal),
    quote: (sym) => get(`/api/quote/${encodeURIComponent(sym)}`),
    bars: (sym, opts, signal) => get(`/api/bars/${encodeURIComponent(sym)}`, opts, signal),
  };
})();
