/* Page controller: state, search, live polling, quote header, stats, historical table. */
(() => {
  const $ = (id) => document.getElementById(id);

  const TF_LABEL = {
    "1Min": "1 min", "5Min": "5 min", "15Min": "15 min", "30Min": "30 min", "1Hour": "1 hour",
    "4Hour": "4 hour", "1Day": "Daily", "1Week": "Weekly", "1Month": "Monthly",
  };
  const RANGE_TFS = {
    "1D": ["1Min", "5Min", "15Min", "30Min", "1Hour"],
    "5D": ["1Min", "5Min", "15Min", "30Min", "1Hour"],
    "1M": ["5Min", "15Min", "30Min", "1Hour", "4Hour", "1Day"],
    "3M": ["1Hour", "4Hour", "1Day", "1Week"],
    "6M": ["1Hour", "4Hour", "1Day", "1Week"],
    "YTD": ["1Hour", "4Hour", "1Day", "1Week"],
    "1Y": ["4Hour", "1Day", "1Week"],
    "5Y": ["1Day", "1Week", "1Month"],
    "MAX": ["1Day", "1Week", "1Month"],
    "CUSTOM": Object.keys(TF_LABEL),
  };
  const RANGE_DEFAULT_TF = { "1D": "1Min", "5D": "5Min", "1M": "1Hour", "3M": "1Day", "6M": "1Day", "YTD": "1Day", "1Y": "1Day", "5Y": "1Week", "MAX": "1Week" };
  const FEED_LABEL = { iex: "IEX", sip: "SIP", "sip+iex": "SIP + IEX live" };
  const feedName = (f) => FEED_LABEL[f] || (f || "").toUpperCase();
  const DEFAULT_IND = ["volume", "sma1", "sma2", "rsi", "macd"];

  // Indicator lengths are in bars, so each interval gets its own sensible defaults (user-editable).
  const STD = { sma: [20, 50, 200], ema: [12, 26], bb: [20, 2], rsi: 14, macd: [12, 26, 9] };
  const PRESETS = {
    "1Min": { ...STD, sma: [9, 20, 50], ema: [9, 21] },
    "5Min": { ...STD, sma: [9, 20, 50], ema: [9, 21] },
    "15Min": { ...STD, sma: [20, 50, 100], ema: [9, 21] },
    "30Min": { ...STD, sma: [20, 50, 100], ema: [9, 21] },
    "1Hour": { ...STD },
    "4Hour": { ...STD },
    "1Day": { ...STD },
    "1Week": { ...STD, sma: [10, 20, 40] },
    "1Month": { ...STD, sma: [6, 12, 24] },
  };
  const TF_UNIT = {
    "1Min": "1 minute", "5Min": "5 minutes", "15Min": "15 minutes", "30Min": "30 minutes", "1Hour": "1 hour",
    "4Hour": "4 hours", "1Day": "1 trading day", "1Week": "1 week", "1Month": "1 month",
  };
  // Menu rows. fields: [paramName, index?, isDecimal?]
  const IND_ROWS = [
    { section: "Overlays" },
    { key: "sma1", label: "SMA", color: "#f39c12", fields: [["sma", 0]] },
    { key: "sma2", label: "SMA", color: "#2a6ebb", fields: [["sma", 1]] },
    { key: "sma3", label: "SMA", color: "#8e44ad", fields: [["sma", 2]] },
    { key: "ema1", label: "EMA", color: "#16a085", fields: [["ema", 0]] },
    { key: "ema2", label: "EMA", color: "#c0392b", fields: [["ema", 1]] },
    { key: "bb", label: "Bollinger", color: "#7f8c8d", fields: [["bb", 0], ["bb", 1, true]], hint: "length, σ" },
    { key: "vwap", label: "VWAP", color: "#e84393", hint: "intraday only" },
    { section: "Lower panes" },
    { key: "volume", label: "Volume" },
    { key: "rsi", label: "RSI", fields: [["rsi"]] },
    { key: "macd", label: "MACD", fields: [["macd", 0], ["macd", 1], ["macd", 2]], hint: "fast, slow, signal" },
  ];
  const LEGACY_IND = { sma20: "sma1", sma50: "sma2", sma200: "sma3", ema12: "ema1", ema26: "ema2" };
  const PAGE_SIZE = 25;
  // Calendar days of older intraday data to add each time the chart is scrolled past its left edge.
  const OLDER_STEP_DAYS = { "1Min": 3, "5Min": 10, "15Min": 20, "30Min": 30, "1Hour": 60, "4Hour": 180 };

  const store = {
    get(k, fallback) { try { const v = localStorage.getItem("qtm." + k); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
    set(k, v) { try { localStorage.setItem("qtm." + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };

  const url = new URLSearchParams(location.search);
  const state = {
    symbol: (url.get("symbol") || store.get("symbol", "AAPL")).toUpperCase(),
    range: (url.get("range") || store.get("range", "1D")).toUpperCase(),
    timeframe: url.get("tf") || null,
    type: store.get("type", "candles"),
    indicators: new Set(store.get("indicators", DEFAULT_IND).map((k) => LEGACY_IND[k] || k)),
    indOverrides: store.get("indParams", {}), // { [timeframe]: params }
    extended: store.get("extended", false),
    from: url.get("from") || "",
    to: url.get("to") || "",
    clock: null,
    quote: null,
    bars: null,
    page: 0,
    lastPrice: null,
    lastQuoteAt: 0,
    lastBarsAt: 0,
    barsCtrl: null,
    loadingBars: false,
    loadFrom: null, // intraday: extra history requested by scrolling back
  };
  if (!RANGE_TFS[state.range]) state.range = "1D";
  if (state.range === "CUSTOM" && !state.from) state.range = "1D";

  const chart = new ChartView({
    main: $("paneMain"), rsi: $("paneRsi"), macd: $("paneMacd"), legend: $("legend"),
    rsiLabel: $("rsiLabel"), macdLabel: $("macdLabel"),
  });

  // ------------------------------------------------------------------ indicator params
  const clone = (o) => JSON.parse(JSON.stringify(o));
  function indParams(tf = currentTf()) {
    return { ...clone(PRESETS[tf] || STD), ...clone(state.indOverrides[tf] || {}) };
  }
  const getField = (p, [name, i]) => (i === undefined ? p[name] : p[name][i]);
  function setField(p, [name, i], v) { if (i === undefined) p[name] = v; else p[name][i] = v; }
  function paramQuery(p) {
    return { sma: p.sma.join(","), ema: p.ema.join(","), bb: p.bb.join(","), rsi: String(p.rsi), macd: p.macd.join(",") };
  }

  // ------------------------------------------------------------------ banner / overlay
  function banner(html, kind = "error") {
    const el = $("banner");
    if (!html) { el.hidden = true; return; }
    el.className = "banner" + (kind === "warn" ? " warn" : "");
    el.innerHTML = html;
    el.hidden = false;
  }
  function overlay(html) {
    const el = $("chartOverlay");
    if (!html) { el.hidden = true; return; }
    el.innerHTML = html;
    el.hidden = false;
  }
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ------------------------------------------------------------------ controls
  function currentTf() {
    const allowed = RANGE_TFS[state.range];
    if (state.timeframe && allowed.includes(state.timeframe)) return state.timeframe;
    if (state.range === "CUSTOM") return customDefaultTf();
    return RANGE_DEFAULT_TF[state.range];
  }
  function customDefaultTf() {
    const a = new Date(state.from), b = state.to ? new Date(state.to) : new Date();
    const days = (b - a) / 864e5;
    if (days <= 5) return "5Min";
    if (days <= 60) return "1Hour";
    if (days <= 1100) return "1Day";
    return "1Week";
  }

  function renderControls() {
    document.querySelectorAll("#rangeSeg button").forEach((b) => b.classList.toggle("on", b.dataset.range === state.range));
    document.querySelectorAll("#typeSeg button").forEach((b) => b.classList.toggle("on", b.dataset.type === state.type));
    const sel = $("tfSelect"), tf = currentTf();
    sel.innerHTML = RANGE_TFS[state.range].map((t) => `<option value="${t}"${t === tf ? " selected" : ""}>${TF_LABEL[t]}</option>`).join("");
    renderIndMenu();
    $("indCount").textContent = state.indicators.size;
    $("extChk").checked = state.extended;
    $("fromDate").value = state.from;
    $("toDate").value = state.to;
    const intraday = !["1Day", "1Week", "1Month"].includes(tf);
    $("extChk").disabled = !intraday;
    $("extChk").parentElement.style.opacity = intraday ? 1 : 0.5;
  }

  function syncUrl() {
    const p = new URLSearchParams({ symbol: state.symbol, range: state.range });
    if (state.timeframe) p.set("tf", state.timeframe);
    if (state.range === "CUSTOM") { p.set("from", state.from); if (state.to) p.set("to", state.to); }
    history.replaceState(null, "", "?" + p.toString());
    store.set("symbol", state.symbol);
    if (state.range !== "CUSTOM") store.set("range", state.range);
  }

  $("rangeSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-range]");
    if (!b || b.dataset.range === state.range) return;
    state.range = b.dataset.range;
    state.timeframe = null;
    state.from = state.to = "";
    renderControls(); syncUrl(); loadBars({ fit: true });
  });
  $("tfSelect").addEventListener("change", (e) => {
    state.timeframe = e.target.value;
    renderControls(); syncUrl(); loadBars({ fit: true });
  });
  $("typeSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-type]");
    if (!b) return;
    state.type = b.dataset.type;
    store.set("type", state.type);
    chart.setType(state.type);
    renderControls();
  });
  $("extChk").addEventListener("change", (e) => {
    state.extended = e.target.checked;
    store.set("extended", state.extended);
    loadBars({ fit: true });
  });
  $("applyDates").addEventListener("click", () => {
    const from = $("fromDate").value, to = $("toDate").value;
    if (!from) { $("fromDate").focus(); return; }
    if (to && to <= from) { banner("End date must be after the start date.", "warn"); return; }
    banner(null);
    state.range = "CUSTOM"; state.from = from; state.to = to; state.timeframe = null;
    renderControls(); syncUrl(); loadBars({ fit: true });
  });

  // Indicators dropdown
  const indBtn = $("indBtn"), indMenu = $("indMenu");
  indBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    indMenu.hidden = !indMenu.hidden;
    indBtn.setAttribute("aria-expanded", String(!indMenu.hidden));
  });
  document.addEventListener("click", (e) => {
    if (!indMenu.hidden && !$("indDrop").contains(e.target)) { indMenu.hidden = true; indBtn.setAttribute("aria-expanded", "false"); }
    if (!$("searchForm").contains(e.target)) hideSuggest();
  });
  function renderIndMenu() {
    const tf = currentTf(), p = indParams(tf), preset = PRESETS[tf] || STD;
    $("indUnit").innerHTML = `Lengths are in bars · 1 bar = <b>${TF_UNIT[tf]}</b>`;
    $("indReset").textContent = `Reset lengths to ${TF_LABEL[tf]} defaults`;
    $("indRows").innerHTML = IND_ROWS.map((r) => {
      if (r.section) return `<div class="menu-h">${r.section}</div>`;
      const nums = (r.fields || []).map((f) => {
        const v = getField(p, f), dec = f[2], def = getField(preset, f);
        const custom = v !== def;
        return `<input type="number" data-f="${f[0]}" data-i="${f[1] ?? ""}" data-dec="${dec ? 1 : ""}"
          min="${dec ? 0.1 : 1}" max="${dec ? 5 : 500}" step="${dec ? 0.1 : 1}" value="${v}"
          class="${custom ? "custom" : ""}" aria-label="${r.label} setting" title="Default: ${def}">`;
      }).join("");
      return `<div class="ind-row">
        <label><input type="checkbox" data-ind="${r.key}" ${state.indicators.has(r.key) ? "checked" : ""}>
          ${r.color ? `<i class="sw" style="--c:${r.color}"></i>` : ""} ${r.label}
          ${r.hint ? `<small>${r.hint}</small>` : ""}</label>
        ${nums ? `<span class="nums">${nums}</span>` : ""}
      </div>`;
    }).join("");
  }

  indMenu.addEventListener("change", (e) => {
    const c = e.target.closest("input[data-ind]");
    if (!c) return;
    c.checked ? state.indicators.add(c.dataset.ind) : state.indicators.delete(c.dataset.ind);
    applyIndicators();
  });

  let paramTimer = 0;
  indMenu.addEventListener("input", (e) => {
    const el = e.target.closest('input[type="number"]');
    if (!el) return;
    const tf = currentTf(), p = indParams(tf);
    const field = [el.dataset.f, el.dataset.i === "" ? undefined : +el.dataset.i];
    const dec = el.dataset.dec === "1";
    const v = dec ? parseFloat(el.value) : Number(el.value);
    let ok = Number.isFinite(v) && (dec ? v >= 0.1 && v <= 5 : Number.isInteger(v) && v >= 1 && v <= 500);
    if (ok) {
      setField(p, field, v);
      if (field[0] === "bb" && field[1] === 0 && v < 2) ok = false;
      if (p.macd[0] >= p.macd[1]) ok = false; // fast must be shorter than slow
    }
    el.classList.toggle("bad", !ok);
    if (!ok) return;
    el.classList.toggle("custom", v !== getField(PRESETS[tf] || STD, field));
    state.indOverrides[tf] = p;
    store.set("indParams", state.indOverrides);
    clearTimeout(paramTimer);
    paramTimer = setTimeout(() => loadBars({ replace: true }), 350);
  });

  $("indReset").addEventListener("click", () => {
    delete state.indOverrides[currentTf()];
    store.set("indParams", state.indOverrides);
    renderIndMenu();
    loadBars({ replace: true });
  });
  $("indAll").addEventListener("click", () => { state.indicators = new Set(); applyIndicators(); });
  function applyIndicators() {
    store.set("indicators", [...state.indicators]);
    chart.setIndicators(state.indicators);
    renderControls();
  }

  // ------------------------------------------------------------------ search
  const input = $("searchInput"), suggest = $("suggest");
  let suggestItems = [], suggestSel = -1, suggestTimer = 0, suggestCtrl = null;

  function hideSuggest() { suggest.hidden = true; suggestSel = -1; }
  function renderSuggest() {
    if (!suggestItems.length) { hideSuggest(); return; }
    suggest.innerHTML = suggestItems.map((a, i) =>
      `<li role="option" data-i="${i}" class="${i === suggestSel ? "sel" : ""}"><b>${esc(a.symbol)}</b><span>${esc(a.name)}</span><em>${esc(a.exchange)}</em></li>`).join("");
    suggest.hidden = false;
  }
  input.addEventListener("input", () => {
    clearTimeout(suggestTimer);
    const q = input.value.trim();
    if (!q) { suggestItems = []; hideSuggest(); return; }
    suggestTimer = setTimeout(async () => {
      if (suggestCtrl) suggestCtrl.abort();
      suggestCtrl = new AbortController();
      try {
        suggestItems = await Api.search(q, suggestCtrl.signal);
        suggestSel = -1;
        renderSuggest();
      } catch (e) { if (e.name !== "AbortError") { suggestItems = []; hideSuggest(); } }
    }, 160);
  });
  input.addEventListener("keydown", (e) => {
    if (suggest.hidden) return;
    if (e.key === "ArrowDown") { suggestSel = Math.min(suggestSel + 1, suggestItems.length - 1); renderSuggest(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { suggestSel = Math.max(suggestSel - 1, -1); renderSuggest(); e.preventDefault(); }
    else if (e.key === "Escape") hideSuggest();
  });
  suggest.addEventListener("mousedown", (e) => {
    const li = e.target.closest("li[data-i]");
    if (!li) return;
    e.preventDefault();
    go(suggestItems[+li.dataset.i].symbol);
  });
  $("searchForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const pick = suggestSel >= 0 ? suggestItems[suggestSel].symbol : input.value.trim().toUpperCase();
    if (pick) go(pick);
  });
  function go(sym) {
    input.value = "";
    suggestItems = []; hideSuggest(); input.blur();
    loadSymbol(sym);
  }

  // ------------------------------------------------------------------ recent symbols
  function renderRecent() {
    const list = store.get("recent", []);
    $("recent").innerHTML = list.length
      ? `<span class="lbl">Recent:</span>` + list.map((s) => `<button class="chip${s === state.symbol ? " on" : ""}" data-sym="${esc(s)}">${esc(s)}</button>`).join("")
      : "";
  }
  function addRecent(sym) {
    const list = [sym, ...store.get("recent", []).filter((s) => s !== sym)].slice(0, 10);
    store.set("recent", list);
    renderRecent();
  }
  $("recent").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-sym]");
    if (b && b.dataset.sym !== state.symbol) loadSymbol(b.dataset.sym);
  });

  // ------------------------------------------------------------------ quote header & stats
  function setText(id, v) { $(id).textContent = v; }

  function renderQuote(q) {
    state.quote = q;
    document.title = `${q.symbol} ${Fmt.price(q.price)} · Quote & Chart`;
    setText("qName", q.name || q.symbol);
    setText("qSym", `(${q.symbol})`);
    setText("crumbSym", q.symbol);
    setText("qExchange", q.exchange || "—");
    setText("qClass", q.asset_class === "us_equity" ? "US Equity" : (q.asset_class || "—"));

    const priceEl = $("qPrice");
    if (state.lastPrice !== null && Fmt.isNum(q.price) && q.price !== state.lastPrice) {
      const cls = q.price > state.lastPrice ? "flash-up" : "flash-down";
      priceEl.classList.add(cls);
      setTimeout(() => priceEl.classList.remove(cls), 700);
    }
    state.lastPrice = q.price;
    priceEl.textContent = Fmt.isNum(q.price) ? "$" + Fmt.price(q.price) : "—";

    const chg = $("qChange");
    const arrow = q.change > 0 ? "▲" : q.change < 0 ? "▼" : "";
    chg.textContent = Fmt.isNum(q.change) ? `${arrow} ${Fmt.signed(q.change)} (${Fmt.pct(q.change_pct)})` : "—";
    chg.className = "chg " + Fmt.dirClass(q.change);

    const feed = feedName(q.feed);
    const liveSrc = q.feed === "sip" ? "SIP" : "IEX";
    setText("qAsOf", q.trade_time ? `As of ${Fmt.etDateTime(q.trade_time)} · Real-time (${liveSrc})` : "—");

    setText("qBid", Fmt.price(q.bid)); setText("qBidSize", Fmt.isNum(q.bid_size) ? `× ${q.bid_size}` : "");
    setText("qAsk", Fmt.price(q.ask)); setText("qAskSize", Fmt.isNum(q.ask_size) ? `× ${q.ask_size}` : "");
    setText("qVol", Fmt.compact(q.volume)); setText("qFeed", feed);

    setText("sOpen", Fmt.price(q.open));
    setText("sPrev", Fmt.price(q.prev_close));
    setText("sDayRange", Fmt.isNum(q.low) ? `${Fmt.price(q.low)} – ${Fmt.price(q.high)}` : "—");
    setText("s52Range", Fmt.isNum(q.week52_low) ? `${Fmt.price(q.week52_low)} – ${Fmt.price(q.week52_high)}` : "—");
    setText("sVol", Fmt.volume(q.volume));
    setText("sAvg10", Fmt.volume(q.avg_volume_10d));
    setText("sAvg3m", Fmt.volume(q.avg_volume_3m));
    setText("sVwap", Fmt.price(q.day_vwap));
    rangeBar("dayBar", q.low, q.high, q.price);
    rangeBar("yearBar", q.week52_low, q.week52_high, q.price);

    const yn = (v) => (v === true ? "Yes" : v === false ? "No" : "—");
    setText("dExchange", q.exchange || "—");
    setText("dTradable", yn(q.tradable));
    setText("dShortable", yn(q.shortable));
    setText("dEtb", yn(q.easy_to_borrow));
    setText("dMarginable", yn(q.marginable));
    setText("dFractional", yn(q.fractionable));
    setText("dFeed", q.feed === "sip+iex" ? "SIP history + IEX live" : q.feed === "sip" ? "SIP (consolidated)" : q.feed === "iex" ? "IEX (real-time)" : "—");
  }

  function rangeBar(id, lo, hi, v) {
    const el = $(id);
    el.querySelector(".lo").textContent = Fmt.price(lo);
    el.querySelector(".hi").textContent = Fmt.price(hi);
    const ok = Fmt.isNum(lo) && Fmt.isNum(hi) && Fmt.isNum(v) && hi > lo;
    const pos = ok ? Math.max(0, Math.min(1, (v - lo) / (hi - lo))) : 0;
    el.querySelector(".track i").style.left = `calc(${(pos * 100).toFixed(1)}% - 1px)`;
    el.querySelector(".track i").style.display = ok ? "" : "none";
  }

  function clearQuote() {
    ["qPrice", "qChange", "qBid", "qAsk", "qVol", "sOpen", "sPrev", "sDayRange", "s52Range", "sVol", "sAvg10", "sAvg3m", "sVwap"]
      .forEach((id) => setText(id, "—"));
    setText("qAsOf", "Loading…");
    $("qChange").className = "chg flat";
    state.lastPrice = null;
  }

  async function loadQuote({ silent = false } = {}) {
    const sym = state.symbol;
    try {
      const q = await Api.quote(sym);
      if (sym !== state.symbol) return;
      renderQuote(q);
      state.lastQuoteAt = Date.now();
      if (!silent) banner(null);
    } catch (e) {
      if (sym !== state.symbol) return;
      state.lastQuoteAt = Date.now();
      if (!silent) showApiError(e);
    }
  }

  // ------------------------------------------------------------------ bars
  function barsKey() {
    return [state.symbol, state.range, currentTf(), state.extended, state.from, state.to].join("|");
  }
  function isLiveRange() {
    return state.range !== "CUSTOM" || !state.to || state.to >= new Date().toISOString().slice(0, 10);
  }

  function reqKey() {
    return barsKey() + "|" + JSON.stringify(indParams());
  }

  /**
   * fit: new view (symbol / range / interval changed).  silent: live refresh.
   * older: scroll-back history.  replace: indicator lengths changed; keep the view.
   */
  async function loadBars({ fit = false, silent = false, older = false, replace = false } = {}) {
    if ((silent || older) && state.loadingBars) return;
    if (!silent && !older && !replace) state.loadFrom = null;
    if (state.barsCtrl) state.barsCtrl.abort();
    const ctrl = new AbortController();
    state.barsCtrl = ctrl;
    state.loadingBars = true;
    const key = barsKey(), rkey = reqKey();
    const tf = currentTf();
    if (older) setText("chartNote", "Loading older bars…");
    else if (replace) setText("chartNote", "Updating indicators…");
    else if (!silent) overlay(`<div><div class="spinner"></div>Loading ${esc(state.symbol)} · ${esc(TF_LABEL[tf])}…</div>`);
    try {
      const opts = { range: state.range, timeframe: tf, extended: state.extended || undefined, ...paramQuery(indParams(tf)) };
      if (state.range === "CUSTOM") { opts.start = state.from; opts.end = state.to || undefined; }
      if (state.loadFrom) opts.load_from = state.loadFrom;
      const data = await Api.bars(state.symbol, opts, ctrl.signal);
      if (rkey !== reqKey()) return;
      data._key = key;
      state.bars = data;
      state.lastBarsAt = Date.now();
      chart.setData(data, { fit, replace });
      if (!silent && !older && !replace) state.page = 0;
      renderTable();
      renderNote();
      if (!data.count) overlay(`<div>No bars returned for <b>${esc(state.symbol)}</b> in this range.<br><small>Try a longer range or enable extended hours.</small></div>`);
      else overlay(null);
    } catch (e) {
      if (e.name === "AbortError") return;
      state.lastBarsAt = Date.now();
      if (older || replace) { renderNote(); if (replace) showApiError(e); }
      else if (!silent) { overlay(`<div>${esc(e.message)}</div>`); showApiError(e); }
    } finally {
      if (state.barsCtrl === ctrl) { state.loadingBars = false; state.barsCtrl = null; }
    }
  }

  function loadOlder() {
    const b = state.bars;
    if (!b || !b.has_more || state.loadingBars) return;
    const first = new Date(b.columns.time[0] * 1000); // ET wall-clock encoded as UTC
    first.setUTCDate(first.getUTCDate() - (OLDER_STEP_DAYS[b.timeframe] || 30));
    state.loadFrom = first.toISOString().slice(0, 10);
    loadBars({ older: true });
  }
  chart.onNeedOlder = loadOlder;

  function renderNote() {
    const d = state.bars;
    if (!d || !d.count) { setText("chartNote", ""); return; }
    const parts = [`${d.count.toLocaleString()} bars since ${Fmt.barTime(d.columns.time[0], false)}`, TF_LABEL[d.timeframe], feedName(d.feed), "ET"];
    if (d.has_more) parts.push("scroll left for more");
    if (d.truncated) parts.push("bar limit reached");
    setText("chartNote", parts.join(" · "));
  }

  // ------------------------------------------------------------------ historical table
  function renderTable() {
    const tbody = $("histTable").querySelector("tbody");
    const d = state.bars && state.bars.columns;
    const n = d && d.time ? d.time.length : 0;
    const intraday = state.bars && state.bars.intraday;
    setText("histSub", n ? `${state.symbol} · ${TF_LABEL[state.bars.timeframe]} · newest first` : "");
    $("histTable").querySelector("th").textContent = intraday ? "Date / Time (ET)" : "Date";
    if (!n) {
      tbody.innerHTML = `<tr><td class="empty" colspan="9">No data</td></tr>`;
      setText("pageInfo", ""); $("prevPage").disabled = $("nextPage").disabled = true;
      return;
    }
    const pages = Math.ceil(n / PAGE_SIZE);
    state.page = Math.min(state.page, pages - 1);
    const startIdx = n - 1 - state.page * PAGE_SIZE;
    const rows = [];
    for (let i = startIdx; i > startIdx - PAGE_SIZE && i >= 0; i--) {
      const prev = i > 0 ? d.close[i - 1] : null;
      const chg = prev !== null ? d.close[i] - prev : null;
      const chgPct = prev ? (chg / prev) * 100 : null;
      const cls = Fmt.dirClass(chg);
      rows.push(`<tr>
        <td class="l">${Fmt.barTime(d.time[i], intraday)}</td>
        <td>${Fmt.price(d.open[i])}</td><td>${Fmt.price(d.high[i])}</td><td>${Fmt.price(d.low[i])}</td>
        <td><b>${Fmt.price(d.close[i])}</b></td>
        <td class="${cls}">${Fmt.signed(chg)}</td><td class="${cls}">${Fmt.pct(chgPct)}</td>
        <td>${Fmt.volume(d.volume[i])}</td><td>${Fmt.price(d.bar_vwap[i])}</td></tr>`);
    }
    tbody.innerHTML = rows.join("");
    const first = state.page * PAGE_SIZE + 1, last = Math.min(n, first + PAGE_SIZE - 1);
    setText("pageInfo", `Showing ${first.toLocaleString()}–${last.toLocaleString()} of ${n.toLocaleString()} bars`);
    $("prevPage").disabled = state.page === 0;
    $("nextPage").disabled = state.page >= pages - 1;
  }
  $("prevPage").addEventListener("click", () => { state.page = Math.max(0, state.page - 1); renderTable(); });
  $("nextPage").addEventListener("click", () => { state.page += 1; renderTable(); });

  $("csvBtn").addEventListener("click", () => {
    const b = state.bars;
    if (!b || !b.count) return;
    const d = b.columns;
    const cols = Object.keys(d).filter((c) => c !== "time");
    const p = b.params;
    const NAME = {
      sma1: `sma_${p.sma[0]}`, sma2: `sma_${p.sma[1]}`, sma3: `sma_${p.sma[2]}`, ema1: `ema_${p.ema[0]}`, ema2: `ema_${p.ema[1]}`,
      bb_mid: `bb${p.bb_len}_mid`, bb_upper: `bb${p.bb_len}_upper`, bb_lower: `bb${p.bb_len}_lower`, rsi: `rsi_${p.rsi}`,
      macd: `macd_${p.macd[0]}_${p.macd[1]}`, macd_signal: `macd_signal_${p.macd[2]}`, macd_hist: "macd_hist",
    };
    const lines = [["datetime_et", ...cols.map((c) => NAME[c] || c)].join(",")];
    for (let i = 0; i < d.time.length; i++) {
      lines.push([Fmt.barTimeISO(d.time[i], b.intraday), ...cols.map((c) => (d[c][i] === null ? "" : d[c][i]))].join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${b.symbol}_${b.range}_${b.timeframe}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  // ------------------------------------------------------------------ market clock
  function renderClock(c) {
    state.clock = c;
    const el = $("mktStatus");
    el.className = "mkt-status " + (c.is_open ? "open" : "closed");
    const t = (iso) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" });
    el.querySelector("span").textContent = c.is_open ? `Market Open · closes ${t(c.next_close)} ET` : `Market Closed · opens ${t(c.next_open)} ET`;
    setText("dNextOpen", Fmt.etDateTime(c.next_open, false));
    setText("dNextClose", Fmt.etDateTime(c.next_close, false));
    $("livePill").hidden = !c.is_open;
  }
  async function loadClock() {
    try { renderClock(await Api.clock()); } catch { /* shown via other errors */ }
  }

  // ------------------------------------------------------------------ errors
  function showApiError(e) {
    if (e.status === 503) {
      banner(`<b>Alpaca credentials missing.</b> Add <code>ALPACA_API_KEY</code> and <code>ALPACA_SECRET_KEY</code>
        (and optionally <code>ALPACA_ENDPOINT</code>) to the <code>.env</code> file in the project root, save it, then reload.`);
    } else if (e.status === 401 || e.status === 403) {
      banner(`<b>Alpaca rejected the request.</b> ${esc(e.message)}<br>Check that the key/secret in <code>.env</code> are correct and match the endpoint (paper vs live).`);
    } else if (e.status === 404) {
      banner(esc(e.message), "warn");
    } else {
      banner(esc(e.message));
    }
  }

  // ------------------------------------------------------------------ symbol load
  function loadSymbol(sym) {
    state.symbol = sym.toUpperCase();
    state.bars = null;
    clearQuote();
    addRecent(state.symbol);
    syncUrl();
    loadQuote();
    loadBars({ fit: true });
  }

  // ------------------------------------------------------------------ live loop
  function tick() {
    if (document.hidden) return;
    const open = !!(state.clock && state.clock.is_open);
    const now = Date.now();
    if (now - state.lastQuoteAt > (open ? 5000 : 30000)) loadQuote({ silent: true });
    if (isLiveRange() && now - state.lastBarsAt > (open ? 10000 : 60000)) loadBars({ silent: true });
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(); });

  // ------------------------------------------------------------------ boot
  async function boot() {
    renderControls();
    chart.setType(state.type);
    chart.setIndicators(state.indicators);
    renderRecent();
    try {
      const h = await Api.health();
      const badge = $("acctBadge");
      badge.textContent = h.configured ? `${h.account} · ${h.feed}` : "not connected";
      badge.className = "acct-badge " + (h.configured ? h.account : "");
      setText("dAcct", h.configured ? (h.account === "paper" ? "Paper" : "Live") : "—");
      if (!h.configured) {
        showApiError({ status: 503 });
        overlay(`<div>Waiting for Alpaca credentials in <b>.env</b>.</div>`);
        renderTable();
        setInterval(async () => { try { if ((await Api.health()).configured) location.reload(); } catch { /* ignore */ } }, 5000);
        return;
      }
    } catch (e) {
      showApiError(e);
      return;
    }
    loadClock();
    setInterval(loadClock, 60000);
    loadSymbol(state.symbol);
    setInterval(tick, 2500);
  }
  boot();
})();
