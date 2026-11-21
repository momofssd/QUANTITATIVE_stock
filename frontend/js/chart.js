/* K-line chart with overlays + synced RSI / MACD panes (TradingView Lightweight Charts v4). */
window.ChartView = (() => {
  const LC = window.LightweightCharts;

  const C = {
    up: "#368727", down: "#c8102e",
    upVol: "rgba(54,135,39,0.42)", downVol: "rgba(200,16,46,0.38)",
    line: "#2b6c1f",
    sma1: "#f39c12", sma2: "#2a6ebb", sma3: "#8e44ad",
    ema1: "#16a085", ema2: "#c0392b", bb: "#7f8c8d", vwap: "#e84393",
    rsi: "#2a6ebb", macd: "#2a6ebb", signal: "#f39c12",
    grid: "#f1f1f1", rule: "#d8d8d8", text: "#555",
  };

  // Labels are functions of the indicator lengths the server actually used (payload.params).
  const OVERLAYS = [
    { key: "sma1", col: "sma1", label: (p) => `SMA${p.sma[0]}`, color: C.sma1 },
    { key: "sma2", col: "sma2", label: (p) => `SMA${p.sma[1]}`, color: C.sma2 },
    { key: "sma3", col: "sma3", label: (p) => `SMA${p.sma[2]}`, color: C.sma3 },
    { key: "ema1", col: "ema1", label: (p) => `EMA${p.ema[0]}`, color: C.ema1 },
    { key: "ema2", col: "ema2", label: (p) => `EMA${p.ema[1]}`, color: C.ema2 },
    { key: "bb", col: "bb_upper", label: (p) => `BB${p.bb_len} Up`, color: C.bb, style: 2 },
    { key: "bb", col: "bb_mid", label: () => "BB Mid", color: C.bb, style: 1, legend: false },
    { key: "bb", col: "bb_lower", label: () => "Lo", color: C.bb, style: 2 },
    { key: "vwap", col: "vwap", label: () => "VWAP", color: C.vwap, width: 2 },
  ];

  function baseOptions() {
    return {
      autoSize: true,
      layout: {
        background: { type: "solid", color: "#ffffff" }, textColor: C.text, fontSize: 11,
        attributionLogo: false, // attribution is given as text in the page footer instead
        fontFamily: '"Helvetica Neue", Helvetica, Arial, sans-serif',
      },
      grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
      rightPriceScale: { borderColor: C.rule, minimumWidth: 78 },
      timeScale: { borderColor: C.rule, timeVisible: true, secondsVisible: false, rightOffset: 3, minBarSpacing: 0.5 },
      crosshair: {
        mode: LC.CrosshairMode.Normal,
        vertLine: { color: "#9a9a9a", labelBackgroundColor: "#333" },
        horzLine: { color: "#9a9a9a", labelBackgroundColor: "#333" },
      },
    };
  }

  class ChartView {
    constructor({ main, rsi, macd, legend, rsiLabel, macdLabel }) {
      this.el = { main, rsi, macd, legend, rsiLabel, macdLabel };
      this.params = null;
      this.data = null;
      this.meta = null;
      this.type = "candles";
      this.enabled = new Set();
      this.timeIndex = new Map();

      this.main = LC.createChart(main, baseOptions());
      this.rsiChart = LC.createChart(rsi, baseOptions());
      this.macdChart = LC.createChart(macd, baseOptions());
      this.charts = [this.main, this.rsiChart, this.macdChart];

      this.priceSeries = null;
      this._createPriceSeries();

      this.volSeries = this.main.addHistogramSeries({
        priceScaleId: "vol", priceFormat: { type: "volume" }, priceLineVisible: false, lastValueVisible: false,
      });
      this.main.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

      this.overlaySeries = OVERLAYS.map((o) => ({
        ...o,
        series: this.main.addLineSeries({
          color: o.color, lineWidth: o.width || 1, lineStyle: o.style || 0,
          priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, visible: false,
        }),
      }));

      this.rsiSeries = this.rsiChart.addLineSeries({ color: C.rsi, lineWidth: 1.5, priceLineVisible: false });
      for (const lvl of [70, 30]) {
        this.rsiSeries.createPriceLine({ price: lvl, color: "#bbb", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "" });
      }
      this.rsiChart.priceScale("right").applyOptions({ scaleMargins: { top: 0.1, bottom: 0.1 } });

      this.macdHist = this.macdChart.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
      this.macdLine = this.macdChart.addLineSeries({ color: C.macd, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: true });
      this.macdSignal = this.macdChart.addLineSeries({ color: C.signal, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: true });

      this._syncCharts();
    }

    // ------------------------------------------------------------------ setup
    _createPriceSeries() {
      if (this.priceSeries) this.main.removeSeries(this.priceSeries);
      const common = { priceLineVisible: true, priceLineWidth: 1, priceLineStyle: 2 };
      if (this.type === "line") {
        this.priceSeries = this.main.addLineSeries({ ...common, color: C.line, lineWidth: 2 });
      } else if (this.type === "bars") {
        this.priceSeries = this.main.addBarSeries({ ...common, upColor: C.up, downColor: C.down, thinBars: false });
      } else {
        this.priceSeries = this.main.addCandlestickSeries({
          ...common, upColor: C.up, downColor: C.down, borderUpColor: C.up, borderDownColor: C.down,
          wickUpColor: C.up, wickDownColor: C.down,
        });
      }
      this._applyPriceMargins();
    }

    _applyPriceMargins() {
      const vol = this.enabled.has("volume");
      this.priceSeries.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: vol ? 0.24 : 0.06 } });
    }

    _syncCharts() {
      // Scrolled past the oldest bar (blank space on the left) -> ask for older data.
      this.onNeedOlder = null;
      this.main.timeScale().subscribeVisibleLogicalRangeChange((range) => {
        if (range && range.from < -2 && this.data && this.onNeedOlder) this.onNeedOlder();
      });
      let syncing = false;
      this.charts.forEach((src) => {
        src.timeScale().subscribeVisibleLogicalRangeChange((range) => {
          if (syncing || !range) return;
          syncing = true;
          this.charts.forEach((dst) => { if (dst !== src) dst.timeScale().setVisibleLogicalRange(range); });
          syncing = false;
        });
      });

      const pairs = [
        [this.main, () => this.priceSeries, "close"],
        [this.rsiChart, () => this.rsiSeries, "rsi"],
        [this.macdChart, () => this.macdLine, "macd"],
      ];
      let xSyncing = false;
      pairs.forEach(([src]) => {
        src.subscribeCrosshairMove((param) => {
          if (xSyncing) return;
          xSyncing = true;
          try { this._onCrosshair(src, pairs, param); } finally { xSyncing = false; }
        });
      });
    }

    _onCrosshair(src, pairs, param) {
          const t = param && param.time;
          pairs.forEach(([dst, seriesFn, col]) => {
            if (dst === src) return;
            if (t === undefined) { dst.clearCrosshairPosition(); return; }
            const i = this.timeIndex.get(t);
            const v = i !== undefined ? this.data[col][i] : null;
            if (v === null || v === undefined) dst.clearCrosshairPosition();
            else dst.setCrosshairPosition(v, t, seriesFn());
          });
          this._renderLegend(t === undefined ? null : this.timeIndex.get(t));
    }

    // ------------------------------------------------------------------ data
    _point(i, kind) {
      const d = this.data, t = d.time[i];
      switch (kind) {
        case "price":
          return this.type === "line" ? { time: t, value: d.close[i] }
            : { time: t, open: d.open[i], high: d.high[i], low: d.low[i], close: d.close[i] };
        case "vol":
          return { time: t, value: d.volume[i], color: d.close[i] >= d.open[i] ? C.upVol : C.downVol };
        case "macdHist": {
          const v = d.macd_hist[i];
          if (v === null) return { time: t };
          const prev = i > 0 ? d.macd_hist[i - 1] : null;
          const growing = prev === null || Math.abs(v) >= Math.abs(prev);
          const color = v >= 0 ? (growing ? "rgba(54,135,39,0.75)" : "rgba(54,135,39,0.35)")
            : (growing ? "rgba(200,16,46,0.7)" : "rgba(200,16,46,0.32)");
          return { time: t, value: v, color };
        }
        default: {
          const v = d[kind][i];
          return v === null || v === undefined ? { time: t } : { time: t, value: v };
        }
      }
    }

    _seriesPlan() {
      return [
        [this.priceSeries, "price"],
        [this.volSeries, "vol"],
        ...this.overlaySeries.map((o) => [o.series, o.col]),
        [this.rsiSeries, "rsi"],
        [this.macdHist, "macdHist"],
        [this.macdLine, "macd"],
        [this.macdSignal, "macd_signal"],
      ];
    }

    /** Replace all data, or (if it is just the live tail moving) update the last few bars in place. */
    /** fit: reset the view to the range. replace: values changed (new indicator lengths); redraw all, keep the view. */
    setData(payload, { fit = false, replace = false } = {}) {
      const cols = payload.columns || {};
      const n = (cols.time || []).length;
      const old = this.data;
      const sameKey = this.meta && this.meta.key === payload._key;
      const canIncrement = !replace && sameKey && old && n > 0 && old.time.length > 0
        && cols.time[0] === old.time[0]
        && n >= old.time.length && n - old.time.length <= 5
        && cols.time[old.time.length - 1] === old.time[old.time.length - 1];

      this.data = n ? cols : null;
      this.params = payload.params || this.params;
      this._updatePaneLabels();
      this.meta = { key: payload._key, intraday: payload.intraday, symbol: payload.symbol, timeframe: payload.timeframe, range: payload.range };
      this.timeIndex = new Map((cols.time || []).map((t, i) => [t, i]));

      if (!n) {
        this._seriesPlan().forEach(([s]) => s.setData([]));
        this._renderLegend(null);
        return;
      }

      this._applyFormat();

      if (canIncrement) {
        const from = old.time.length - 1;
        this._seriesPlan().forEach(([s, kind]) => {
          for (let i = from; i < n; i++) s.update(this._point(i, kind));
        });
      } else {
        const prevRange = this.main.timeScale().getVisibleLogicalRange();
        // Older bars were prepended (scroll-back load): keep the same bars on screen.
        const shift = sameKey && old && !fit ? this.timeIndex.get(old.time[0]) : undefined;
        this._seriesPlan().forEach(([s, kind]) => {
          const arr = new Array(n);
          for (let i = 0; i < n; i++) arr[i] = this._point(i, kind);
          s.setData(arr);
        });
        if (shift > 0 && prevRange) {
          this.main.timeScale().setVisibleLogicalRange({ from: prevRange.from + shift, to: prevRange.to + shift });
        } else if (fit || !sameKey || !old || cols.time[0] !== old.time[0]) {
          this.showFrom(payload.view_start);
        }
      }
      this._renderLegend(null);
    }

    _updatePaneLabels() {
      const p = this.params;
      if (!p) return;
      if (this.el.rsiLabel) this.el.rsiLabel.textContent = `RSI (${p.rsi})`;
      if (this.el.macdLabel) this.el.macdLabel.textContent = `MACD (${p.macd.join(", ")})`;
    }

    /** Initial view: from the range's start date to the latest bar (older history stays scrollable). */
    showFrom(viewStart) {
      const t = this.data && this.data.time;
      if (!t || !t.length) return;
      let i = viewStart == null ? 0 : t.findIndex((x) => x >= viewStart);
      if (i <= 0) { this.main.timeScale().fitContent(); return; }
      this.main.timeScale().setVisibleLogicalRange({ from: i - 0.5, to: t.length - 1 + 3 });
    }

    _applyFormat() {
      const last = this.data.close[this.data.close.length - 1];
      const precision = last < 1 ? 4 : 2;
      const pf = { type: "price", precision, minMove: 1 / 10 ** precision };
      this.priceSeries.applyOptions({ priceFormat: pf });
      this.overlaySeries.forEach((o) => o.series.applyOptions({ priceFormat: pf }));
      const intraday = this.meta.intraday;
      const fmt = (t) => Fmt.barTime(t, intraday);
      this.charts.forEach((c) => c.applyOptions({
        localization: { timeFormatter: fmt },
        timeScale: { timeVisible: intraday },
      }));
    }

    // ------------------------------------------------------------------ options
    setType(type) {
      if (type === this.type) return;
      this.type = type;
      const range = this.main.timeScale().getVisibleLogicalRange();
      this._createPriceSeries();
      if (this.data) {
        const n = this.data.time.length, arr = new Array(n);
        for (let i = 0; i < n; i++) arr[i] = this._point(i, "price");
        this.priceSeries.setData(arr);
        this._applyFormat();
        if (range) this.main.timeScale().setVisibleLogicalRange(range);
      }
    }

    setIndicators(enabled) {
      this.enabled = new Set(enabled);
      this.overlaySeries.forEach((o) => o.series.applyOptions({ visible: this.enabled.has(o.key) }));
      this.volSeries.applyOptions({ visible: this.enabled.has("volume") });
      this._applyPriceMargins();
      this.el.rsi.classList.toggle("hidden", !this.enabled.has("rsi"));
      this.el.macd.classList.toggle("hidden", !this.enabled.has("macd"));
      // Only the bottom-most visible pane shows the time axis.
      const bottom = this.enabled.has("macd") ? this.macdChart : this.enabled.has("rsi") ? this.rsiChart : this.main;
      this.charts.forEach((c) => c.applyOptions({ timeScale: { visible: c === bottom } }));
      this._renderLegend(null);
    }

    // ------------------------------------------------------------------ legend
    _renderLegend(idx) {
      const el = this.el.legend;
      if (!this.data) { el.innerHTML = ""; return; }
      const d = this.data;
      const i = idx === null || idx === undefined ? d.time.length - 1 : idx;
      const prevClose = i > 0 ? d.close[i - 1] : d.open[i];
      const chg = d.close[i] - prevClose;
      const chgPct = prevClose ? (chg / prevClose) * 100 : null;
      const cls = Fmt.dirClass(chg);
      const p = (v) => Fmt.price(v);
      const k = (label, v, color) => `<span><span class="k"${color ? ` style="color:${color}"` : ""}>${label}</span> ${v}</span>`;

      let l2 = "";
      const seen = new Set();
      this.overlaySeries.forEach((o) => {
        if (!this.enabled.has(o.key) || o.legend === false) return;
        const id = o.key + o.col;
        if (seen.has(id)) return;
        seen.add(id);
        l2 += k(o.label(this.params), p(d[o.col][i]), o.color);
      });
      if (this.enabled.has("rsi")) l2 += k(`RSI${this.params.rsi}`, Fmt.isNum(d.rsi[i]) ? d.rsi[i].toFixed(2) : "—", C.rsi);
      if (this.enabled.has("macd")) {
        const f = (v) => (Fmt.isNum(v) ? v.toFixed(3) : "—");
        l2 += k("MACD", f(d.macd[i]), C.macd) + k("Sig", f(d.macd_signal[i]), C.signal) + k("Hist", f(d.macd_hist[i]));
      }

      el.innerHTML = `
        <div class="l1">
          <b>${this.meta.symbol}</b>
          <span class="k">${Fmt.barTime(d.time[i], this.meta.intraday)}</span>
          ${k("O", p(d.open[i]))}${k("H", p(d.high[i]))}${k("L", p(d.low[i]))}${k("C", p(d.close[i]))}
          <span class="${cls}">${Fmt.signed(chg)} (${Fmt.pct(chgPct)})</span>
          ${k("Vol", Fmt.compact(d.volume[i]))}
        </div>
        ${l2 ? `<div class="l2">${l2}</div>` : ""}`;
    }
  }

  return ChartView;
})();
