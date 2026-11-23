/* SD Desk ChartModal: one reusable OLED dialog that drives SDCharts.QuadrantChart for any
   country index, commodity, crypto, bond or stock row in the Global Radar views. */
(function (root) {
  "use strict";

  const M = root.SDMath;
  const C = root.SDCharts;
  const DAILY_BPY = 252;
  const WEEKLY_BPY = 52.1775;
  const DAY_MS = 86400000;

  /* --- Compact series codec (mirrors pack_series in fetch_global.py) --- */
  function isoFromMs(ms) {
    const d = new Date(ms);
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${d.getUTCFullYear()}-${m}-${day}`;
  }

  function expandSeries(packed) {
    if (!packed || !packed.t0 || !packed.c || !packed.c.length) return { t: [], c: [], v: [] };
    const base = M.parseIsoDate(packed.t0).getTime();
    const t = new Array(packed.c.length);
    let day = 0;
    for (let i = 0; i < packed.c.length; i++) {
      day += packed.dt[i] || 0;
      t[i] = isoFromMs(base + day * DAY_MS);
    }
    return { t, c: packed.c.slice(), v: new Array(packed.c.length).fill(0) };
  }

  /* Index levels and share prices both read better with thousands separators than
     quad-chart's chart-axis formatter gives, so tables and the modal footer use this. */
  function fmtVal(v, dp) {
    if (v == null || !Number.isFinite(v)) return "--";
    const a = Math.abs(v);
    const d = dp != null ? dp : a >= 1000 ? 0 : a >= 10 ? 2 : 3;
    return v.toLocaleString("en-GB", { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  /* --- Welford block (Python dict) -> QuadrantChart stats (camelCase + residuals) --- */
  function blockToStats(block, closes, useLog) {
    if (!block || !(block.sd > 0) || !Number.isFinite(block.mean_now) || !Number.isFinite(block.mean_1y)) return null;
    const n = block.n;
    const bpy = block.bpy || WEEKLY_BPY;
    const meanNow = block.mean_now;
    const mean1Y = block.mean_1y;
    let slope;
    let endSpace;
    if (useLog) {
      endSpace = Math.log(meanNow);
      slope = Math.log(mean1Y / meanNow) / bpy;
    } else {
      endSpace = meanNow;
      slope = (mean1Y - meanNow) / bpy;
    }
    const startSpace = endSpace - slope * (n - 1);
    const sd = block.sd;
    const residuals = new Array(closes.length).fill(0);
    return {
      n, slope, startSpace, endSpace, sd,
      r: block.r, z: block.z,
      trendPct: block.trend_pct,
      meanNow, mean1Y,
      toMean1YPct: block.to_mean_1y_pct,
      distNowPct: 0,
      residuals,
    };
  }

  function tvSymbol(yf) {
    const map = {
      "^GSPC": "SP:SPX", "^FTSE": "TVC:UKX", "^N225": "TVC:NI225", "^GDAXI": "XETR:DAX",
      "^FCHI": "EURONEXT:PX1", "^SSMI": "SIX:SMI", "^GSPTSE": "TSX:TSX", "^AXJO": "ASX:XJO",
      "^AEX": "EURONEXT:AEX", "^IBEX": "BME:IBC", "FTSEMIB.MI": "MIL:FTSEMIB",
      "^OMX": "OMXSTO:OMXS30", "^OMXC25": "OMXCOP:OMXC25", "OBX.OL": "OSL:OBX",
      "^OMXH25": "OMXHEX:OMXH25", "^BFX": "EURONEXT:BEL20", "^ATX": "VIE:ATX",
      "^STI": "SGX:STI", "^HSI": "HSI:HSI", "^NZ50": "NZX:NZ50G", "^KS11": "KRX:KOSPI",
      "^TWII": "TWSE:TAIEX", "^NSEI": "NSE:NIFTY", "000300.SS": "SSE:000300",
      "^BVSP": "BMFBOVESPA:IBOV", "^MXX": "BMV:ME",
      "GC=F": "COMEX:GC1!", "SI=F": "COMEX:SI1!", "HG=F": "COMEX:HG1!",
      "CL=F": "NYMEX:CL1!", "BZ=F": "ICEEUR:BRN1!", "NG=F": "NYMEX:NG1!", "PL=F": "NYMEX:PL1!",
      "BTC-USD": "BITSTAMP:BTCUSD", "ETH-USD": "BITSTAMP:ETHUSD", "SOL-USD": "COINBASE:SOLUSD",
    };
    if (map[yf]) return map[yf];
    const suffix = {
      ".L": "LSE", ".T": "TSE", ".DE": "XETR", ".PA": "EURONEXT", ".AS": "EURONEXT",
      ".BR": "EURONEXT", ".MC": "BME", ".MI": "MIL", ".HE": "OMXHEX", ".OL": "OSL",
      ".SS": "SSE", ".JO": "JSE", ".WA": "GPW",
    };
    const dot = yf.lastIndexOf(".");
    if (dot > 0) {
      const ex = suffix[yf.slice(dot)];
      if (ex) return `${ex}:${yf.slice(0, dot).replace(/-/g, ".")}`;
    }
    return yf.replace(/-/g, ".");
  }

  class ChartModal {
    constructor() {
      this.el = null;
      this.chart = null;
      this.ctx = null;
      this.state = { useLog: true, lookback: "max", bands: "34" };
      this._onKey = (e) => { if (e.key === "Escape") this.close(); };
    }

    _build() {
      if (this.el) return;
      const wrap = document.createElement("div");
      wrap.className = "sd-modal-backdrop";
      wrap.innerHTML = `
        <div class="sd-modal" role="dialog" aria-modal="true" aria-label="SD channel chart">
          <div class="sd-modal-head">
            <div class="sd-modal-title">
              <strong id="sdmTitle"></strong>
              <span id="sdmSub"></span>
            </div>
            <div class="sd-modal-head-right">
              <a class="tv-tool-btn" id="sdmTv" target="_blank" rel="noopener">TradingView</a>
              <a class="tv-tool-btn" id="sdmYf" target="_blank" rel="noopener">Yahoo</a>
              <button class="icon-btn" id="sdmClose" title="Close (Esc)" aria-label="Close">×</button>
            </div>
          </div>
          <div class="tv-subbar sd-modal-bar">
            <div class="tv-subbar-group">
              <button class="tv-tool-btn active" data-sdm-lb="max">Max</button>
              <button class="tv-tool-btn" data-sdm-lb="2500">2500D</button>
              <span class="tv-sep"></span>
              <button class="tv-tool-btn active" data-sdm-sc="log">Log</button>
              <button class="tv-tool-btn" data-sdm-sc="lin">Lin</button>
              <span class="tv-sep"></span>
              <button class="tv-tool-btn active" data-sdm-bands="34">-3/-4 SD</button>
              <button class="tv-tool-btn" data-sdm-bands="12">-1/-2 SD</button>
            </div>
            <div class="tv-subbar-group">
              <span class="sd-modal-hint">Scroll to zoom · Drag to pan · Double-click to reset</span>
              <button class="tv-tool-btn" id="sdmReset">Reset</button>
            </div>
          </div>
          <div class="sd-modal-stage"><div class="chart-canvas-wrap"><canvas id="sdmCanvas"></canvas></div></div>
          <div class="sd-modal-foot" id="sdmFoot"></div>
        </div>`;
      document.body.appendChild(wrap);
      this.el = wrap;

      wrap.addEventListener("mousedown", (e) => { if (e.target === wrap) this.close(); });
      wrap.querySelector("#sdmClose").addEventListener("click", () => this.close());
      wrap.querySelector("#sdmReset").addEventListener("click", () => this.chart && this.chart.resetZoom());
      const pick = (attr, key) => {
        wrap.querySelectorAll(`[data-sdm-${attr}]`).forEach((b) => {
          b.addEventListener("click", () => {
            wrap.querySelectorAll(`[data-sdm-${attr}]`).forEach((x) => x.classList.remove("active"));
            b.classList.add("active");
            this.state[key] = b.dataset[`sdm${attr.charAt(0).toUpperCase()}${attr.slice(1)}`];
            if (key === "scale") this.state.useLog = this.state.scale === "log";
            this._draw();
          });
        });
      };
      pick("lb", "lookback");
      pick("sc", "scale");
      pick("bands", "bands");
      this.chart = new C.QuadrantChart(wrap.querySelector("#sdmCanvas"), "modal");
      window.addEventListener("resize", () => { if (this.isOpen()) this._draw(true); });
    }

    isOpen() {
      return Boolean(this.el && this.el.classList.contains("open"));
    }

    _syncButtons() {
      const q = (sel, val) => this.el.querySelectorAll(sel).forEach((b) => {
        b.classList.toggle("active", b.dataset[Object.keys(b.dataset)[0]] === val);
      });
      q("[data-sdm-lb]", this.state.lookback);
      q("[data-sdm-sc]", this.state.useLog ? "log" : "lin");
      q("[data-sdm-bands]", this.state.bands);
      const has2500 = this.ctx && this.ctx.has2500;
      const btn = this.el.querySelector('[data-sdm-lb="2500"]');
      btn.disabled = !has2500;
      btn.title = has2500 ? "2,500 trading-day window" : "Not enough history for a 2500D window";
    }

    /* ctx.kind "series": full compact series, stats recomputed in the browser.
       ctx.kind "points": downsampled price points drawn against exact precomputed stats. */
    open(ctx) {
      this._build();
      this.ctx = ctx;
      this.state.useLog = true;
      this.state.lookback = ctx.has2500 === false ? "max" : (ctx.lookback || "max");
      this.state.bands = "34";
      this.el.querySelector("#sdmTitle").textContent = ctx.title || "";
      this.el.querySelector("#sdmSub").textContent = ctx.subtitle || "";
      const tv = this.el.querySelector("#sdmTv");
      const yfLink = this.el.querySelector("#sdmYf");
      tv.href = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tvSymbol(ctx.yf))}`;
      yfLink.href = `https://finance.yahoo.com/quote/${encodeURIComponent(ctx.yf)}`;
      this._syncButtons();
      this.el.classList.add("open");
      document.body.classList.add("sd-modal-lock");
      document.addEventListener("keydown", this._onKey);
      requestAnimationFrame(() => this._draw());
    }

    close() {
      if (!this.el) return;
      this.el.classList.remove("open");
      document.body.classList.remove("sd-modal-lock");
      document.removeEventListener("keydown", this._onKey);
    }

    _payloadFromSeries() {
      const ctx = this.ctx;
      const useLog = this.state.useLog;
      // The 2500D window is only ever drawn from the stored daily bars, never from a
      // weekly slice relabelled as 2500D.
      const daily = this.state.lookback === "2500" && ctx.daily && ctx.daily.c.length > 0;
      if (this.state.lookback === "2500" && !daily) this.state.lookback = "max";
      const raw = daily ? ctx.daily : ctx.weekly;
      const bpy = daily ? DAILY_BPY : WEEKLY_BPY;
      const sliced = daily ? raw : M.sliceByLookback(raw, "max");
      const stats = M.welfordOLS(sliced.c, useLog, bpy);
      if (!stats) return null;
      return {
        series: sliced,
        stats,
        useLog,
        lookback: this.state.lookback,
        bands: this.state.bands,
        futureBars: Math.round(bpy * 2.2),
        asset: { currency: ctx.currency || "" },
        barLabel: daily ? "D" : "W",
      };
    }

    _payloadFromPoints() {
      const ctx = this.ctx;
      const useLog = this.state.useLog;
      const d2500 = this.state.lookback === "2500";
      const block = ctx.blocks[`${d2500 ? "d2500" : "max"}_${useLog ? "log" : "lin"}`];
      if (!block) return null;
      const bpy = d2500 ? DAILY_BPY : WEEKLY_BPY;
      block.bpy = bpy;

      const pts = ctx.points;
      const K = pts.c.length;
      if (K < 4) return null;
      const t0 = M.parseIsoDate(pts.t0).getTime();
      const t1 = M.parseIsoDate(pts.t1).getTime();
      const stepMs = K > 1 ? (t1 - t0) / (K - 1) : DAY_MS;

      // Affine map from point index k to the fitted line's own bar index
      let k0 = 0;
      let a = 0;
      let b = 1;
      if (d2500) {
        const winStart = t1 - ctx.windowCalDays * DAY_MS;
        while (k0 < K - 4 && t0 + k0 * stepMs < winStart) k0 += 1;
        const spanMs = Math.max(DAY_MS, t1 - winStart);
        a = ((t0 + k0 * stepMs - winStart) / spanMs) * (block.n - 1);
        b = (stepMs / spanMs) * (block.n - 1);
      } else {
        b = (block.n - 1) / (K - 1);
        a = 0;
      }

      const t = [];
      const c = [];
      for (let k = k0; k < K; k++) {
        t.push(isoFromMs(t0 + k * stepMs));
        c.push(pts.c[k]);
      }
      const stats = blockToStats(block, c, useLog);
      if (!stats) return null;
      // Re-express the fitted line in drawn-point index space: y(k) = (s0 + m*a) + (m*b)*k
      const realSlope = stats.slope;
      stats.slope = realSlope * b;
      stats.startSpace = stats.startSpace + realSlope * a;
      for (let i = 0; i < c.length; i++) {
        const y = useLog ? Math.log(c[i]) : c[i];
        stats.residuals[i] = stats.sd > 0 ? (y - (stats.startSpace + stats.slope * i)) / stats.sd : 0;
      }
      stats.n = c.length;
      return {
        series: { t, c, v: new Array(c.length).fill(0) },
        stats,
        useLog,
        lookback: this.state.lookback,
        bands: this.state.bands,
        futureBars: Math.max(4, Math.round(bpy / Math.max(1e-9, b))),
        asset: { currency: ctx.currency || "" },
        barLabel: "W",
      };
    }

    _draw(preserveZoom) {
      if (!this.isOpen() || !this.ctx) return;
      const payload = this.ctx.kind === "points" ? this._payloadFromPoints() : this._payloadFromSeries();
      const foot = this.el.querySelector("#sdmFoot");
      if (!payload) {
        foot.textContent = "No fit available for this window and scale.";
        return;
      }
      this.chart.setData(payload, Boolean(preserveZoom));
      const st = payload.stats;
      const lbTxt = payload.lookback === "max" ? "Max" : "2500D";
      const scTxt = payload.useLog ? "Log" : "Lin";
      const bars = this.ctx.kind === "points" && payload.lookback === "2500"
        ? `${this.ctx.blocks.d2500_log ? this.ctx.blocks.d2500_log.n : st.n} daily bars (curve drawn on weekly samples)`
        : `${st.n} ${payload.barLabel === "D" ? "daily" : "weekly"} bars`;
      foot.innerHTML = `
        <span><b>${lbTxt} ${scTxt}</b> · ${bars}</span>
        <span>Z <b class="${st.z <= 0 ? "z-low" : st.z < 1 ? "z-mid" : st.z < 1.5 ? "z-warm" : "z-hot"}">${st.z >= 0 ? "+" : ""}${st.z.toFixed(2)} SD</b></span>
        <span>R <b>${st.r.toFixed(3)}</b></span>
        <span>Trend <b class="${st.trendPct >= 0 ? "up" : "dn"}">${st.trendPct >= 0 ? "+" : ""}${st.trendPct.toFixed(1)}%/yr</b></span>
        <span>Mean now <b>${fmtVal(st.meanNow)}</b></span>
        <span>+1Y Mean <b>${fmtVal(st.mean1Y)}</b></span>
        <span>To +1Y Mean <b class="${st.toMean1YPct >= 0 ? "up" : "dn"}">${st.toMean1YPct >= 0 ? "+" : ""}${st.toMean1YPct.toFixed(1)}%</b></span>`;
    }
  }

  root.SDModal = new ChartModal();
  root.SDModalUtils = { expandSeries, blockToStats, tvSymbol, isoFromMs, fmtVal };
})(window);
