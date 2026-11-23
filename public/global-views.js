/* SD Desk Global Radar views: Countries (world map + channel table), Macro (bond curves,
   commodities, crypto) and Scanner (~875 index constituents). Every row opens ChartModal. */
(function (root) {
  "use strict";

  const M = root.SDMath;
  const C = root.SDCharts;
  const U = root.SDModalUtils;

  const DATA_MACRO = "./data/global_macro.json";
  const DATA_STOCKS = "./data/global_stocks.json";
  const DATA_MAP = "./data/world_map.json";

  const UNMAPPED_FILL = "#111111";
  const UNMAPPED_STROKE = "#222222";

  const Z_SCALE = [
    { max: -2.0, fill: "#056656", label: "<= -2" },
    { max: -1.0, fill: "#089981", label: "-2 to -1" },
    { max: 0.0, fill: "#134e4a", label: "-1 to 0" },
    { max: 1.0, fill: "#2a2e39", label: "0 to +1" },
    { max: 1.5, fill: "#b45309", label: "+1 to +1.5" },
    { max: 2.0, fill: "#cc2f3c", label: "+1.5 to +2" },
    { max: Infinity, fill: "#f23645", label: ">= +2" },
  ];

  const ZONES = [
    { id: "b4", label: "below -4", test: (z) => z <= -4, c: "#a3163a" },
    { id: "34", label: "-3 to -4", test: (z) => z <= -3 && z > -4, c: "#f23645" },
    { id: "13", label: "-1 to -3", test: (z) => z <= -1 && z > -3, c: "#f7525f" },
    { id: "m1", label: "mean to -1", test: (z) => z < 0 && z > -1, c: "#f59e0b" },
    { id: "01", label: "mean to +1", test: (z) => z >= 0 && z < 1, c: "#f59e0b" },
    { id: "12", label: "+1 to +2", test: (z) => z >= 1 && z < 2, c: "#22d3ee" },
    { id: "a2", label: "above +2", test: (z) => z >= 2, c: "#2962ff" },
  ];

  const INDEX_TABS = [
    { code: "ALL", label: "All" },
    { code: "SP500", label: "S&P 500" },
    { code: "FTSE100", label: "FTSE 100" },
    { code: "SX50E", label: "Euro Stoxx 50" },
    { code: "N225", label: "Nikkei 225" },
  ];

  const CURVE_ROWS = [
    { issuer: "UK", label: "UK Gilts" },
    { issuer: "US", label: "US Treasuries" },
    { issuer: "Euro", label: "Euro Govts" },
  ];
  const CURVE_COLS = [
    { tenor: "Short", label: "Short 1-3y" },
    { tenor: "Medium", label: "Medium 7-10y" },
    { tenor: "Long", label: "Long 15-20y+" },
    { tenor: "Linker", label: "Linkers / TIPS" },
  ];

  const state = {
    macro: null,
    stocks: null,
    map: null,
    pending: {},
    ctry: { lookback: "max", scale: "log", group: "All", sort: "z", dir: 1, hover: null },
    mac: { lookback: "max", scale: "log" },
    scan: {
      index: "ALL", q: "", sector: "", rmin: 0.7, lookback: "2500", scale: "log",
      zones: new Set(), sort: "z", dir: 1, shown: 300,
    },
  };
  let lastScanRows = [];

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmtVal = U.fmtVal;
  const num = (v, d) => (v == null || !Number.isFinite(v) ? "-" : v.toFixed(d == null ? 2 : d));
  const signed = (v, d) => (v == null || !Number.isFinite(v) ? "-" : `${v >= 0 ? "+" : ""}${v.toFixed(d == null ? 2 : d)}`);

  function zCls(z) {
    if (z == null) return "";
    if (z <= 0.0) return "z-low";
    if (z < 1.0) return "z-mid";
    if (z < 1.5) return "z-warm";
    return "z-hot";
  }

  function zFill(z) {
    if (z == null || !Number.isFinite(z)) return UNMAPPED_FILL;
    for (let i = 0; i < Z_SCALE.length; i++) {
      if (z <= Z_SCALE[i].max) return Z_SCALE[i].fill;
    }
    return Z_SCALE[Z_SCALE.length - 1].fill;
  }

  function statKey(s) {
    return `${s.lookback === "2500" ? "d2500" : "max"}_${s.scale}`;
  }

  function barWord(s) {
    return s.lookback === "2500" ? "1D" : "1W";
  }

  /* Inline SD strip plot: axis, band ticks and the live marker. */
  function strip(z, lo, hi) {
    if (z == null || !Number.isFinite(z)) return "";
    const span = hi - lo;
    const pos = (v) => Math.max(0, Math.min(100, ((v - lo) / span) * 100));
    const ticks = [[-4, "#a3163a"], [-3, "#f23645"], [0, "#f59e0b"], [1, "#22d3ee"], [2, "#2962ff"]]
      .filter(([v]) => v >= lo && v <= hi)
      .map(([v, col]) => `<span class="gv-strip-t" style="left:${pos(v)}%;background:${col}"></span>`).join("");
    const off = z > hi || z < lo;
    const col = z >= 2 ? "#2962ff" : z >= 1 ? "#22d3ee" : z > -1 ? "#dbdbdb" : z > -3 ? "#f23645" : "#a3163a";
    return `<span class="gv-strip" aria-hidden="true"><span class="gv-strip-ax"></span>${ticks}` +
      `<span class="gv-strip-m${off ? " off" : ""}" style="left:${pos(z)}%;background:${col}"></span></span>`;
  }

  function tip() {
    let el = $("gvTip");
    if (!el) {
      el = document.createElement("div");
      el.id = "gvTip";
      el.className = "gv-tip";
      document.body.appendChild(el);
    }
    return el;
  }

  function showTip(html, x, y) {
    const el = tip();
    el.innerHTML = html;
    el.style.display = "block";
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    el.style.left = `${Math.max(6, Math.min(window.innerWidth - w - 6, x + 14))}px`;
    el.style.top = `${Math.max(6, Math.min(window.innerHeight - h - 6, y + 14))}px`;
  }

  function hideTip() {
    const el = $("gvTip");
    if (el) el.style.display = "none";
  }

  /* ---------------------------------------------------------------- data loading */

  async function loadJson(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
  }

  function once(key, loader) {
    if (!state.pending[key]) state.pending[key] = loader();
    return state.pending[key];
  }

  async function ensureMacro() {
    if (state.macro) return state.macro;
    state.macro = await once("macro", () => loadJson(DATA_MACRO));
    return state.macro;
  }

  async function ensureMap() {
    if (state.map) return state.map;
    state.map = await once("map", () => loadJson(DATA_MAP));
    return state.map;
  }

  async function ensureStocks() {
    if (state.stocks) return state.stocks;
    const raw = await once("stocks", () => loadJson(DATA_STOCKS));
    const F = {};
    raw.fields.forEach((f, i) => { F[f] = i; });
    const SF = {};
    (raw.stat_fields || ["z", "dz", "r", "n", "trend_pct", "mean_now", "mean_1y", "to_mean_1y_pct", "sd"])
      .forEach((f, i) => { SF[f] = i; });
    raw._F = F;
    raw._SF = SF;
    state.stocks = raw;
    return raw;
  }

  function tupleToBlock(tuple, SF) {
    if (!tuple) return null;
    const b = {};
    Object.keys(SF).forEach((k) => { b[k] = tuple[SF[k]]; });
    return b;
  }

  /* ---------------------------------------------------------------- chart modal */

  function openInstrument(row, lookback) {
    if (!row._weekly) row._weekly = U.expandSeries(row.weekly);
    if (!row._daily) row._daily = U.expandSeries(row.daily_2500);
    root.SDModal.open({
      kind: "series",
      title: `${row.name}`,
      subtitle: `${row.country || row.category || ""} · ${row.yf_used} · ${row.currency} · weekly since ${row.start_year}`,
      yf: row.yf_used,
      currency: row.currency,
      weekly: row._weekly,
      daily: row._daily,
      has2500: Boolean(row._daily && row._daily.c.length),
      lookback: lookback || "max",
    });
  }

  function openStock(row) {
    const F = state.stocks._F;
    const SF = state.stocks._SF;
    const blocks = {
      d2500_log: tupleToBlock(row[F.d2500_log], SF),
      d2500_lin: tupleToBlock(row[F.d2500_lin], SF),
      max_log: tupleToBlock(row[F.max_log], SF),
      max_lin: tupleToBlock(row[F.max_lin], SF),
    };
    root.SDModal.open({
      kind: "points",
      title: `${row[F.ticker]} · ${row[F.name]}`,
      subtitle: `${row[F.index]} · ${row[F.sector] || "-"} · ${row[F.currency]}`,
      yf: row[F.ticker],
      currency: row[F.currency],
      points: { t0: row[F.w0], t1: row[F.w1], c: row[F.px] },
      blocks,
      windowCalDays: state.stocks.window_2500_calendar_days || 3624,
      has2500: Boolean(blocks.d2500_log),
      lookback: blocks.d2500_log ? state.scan.lookback : "max",
    });
  }

  /* ---------------------------------------------------------------- countries */

  function countryRows() {
    const key = statKey(state.ctry);
    return state.macro.countries.map((row) => ({ row, st: row.stats[key] || null }));
  }

  function renderLegend() {
    const el = $("ctryLegend");
    if (!el) return;
    el.innerHTML = Z_SCALE.map((s) => `<span class="gv-leg"><i style="background:${s.fill}"></i>${s.label}</span>`).join("")
      + `<span class="gv-leg gv-leg-note">live SD</span>`;
  }

  function countryTipHtml(row, st) {
    if (!st) return `<b>${esc(row.country)}</b><div class="gv-tip-sub">${esc(row.name)} · no fit for this window</div>`;
    return `<b>${esc(row.country)}</b>
      <div class="gv-tip-sub">${esc(row.name)} · ${esc(row.yf_used)}</div>
      <div class="gv-tip-grid">
        <span>Close</span><span>${fmtVal(row.close)} ${esc(row.currency)}</span>
        <span>Live Z</span><span class="${zCls(st.z)}">${signed(st.z)} SD</span>
        <span>R</span><span>${num(st.r, 3)}</span>
        <span>Trend/yr</span><span class="${st.trend_pct >= 0 ? "up" : "dn"}">${signed(st.trend_pct, 1)}%</span>
        <span>To +1Y Mean</span><span class="${st.to_mean_1y_pct >= 0 ? "up" : "dn"}">${signed(st.to_mean_1y_pct, 1)}%</span>
      </div>`;
  }

  function renderMap() {
    const host = $("ctryMap");
    if (!host || !state.map) return;
    const byIso = {};
    countryRows().forEach((e) => {
      if (state.ctry.group === "All" || e.row.group === state.ctry.group) byIso[e.row.iso2] = e;
    });
    const codes = Object.keys(state.map.countries);
    const parts = codes.map((iso) => {
      const geo = state.map.countries[iso];
      const e = byIso[iso];
      const fill = e ? zFill(e.st ? e.st.z : null) : UNMAPPED_FILL;
      const cls = `gv-c${e ? " live" : ""}${geo.marker ? " marker" : ""}`;
      return `<path class="${cls}" data-iso="${iso}" fill="${fill}" stroke="${e ? "#303030" : UNMAPPED_STROKE}" d="${geo.d}"></path>`;
    });
    host.innerHTML = `<svg viewBox="${state.map.view_box}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="World index channel map">${parts.join("")}</svg>`;

    const svg = host.querySelector("svg");
    svg.addEventListener("mousemove", (ev) => {
      const p = ev.target.closest("path[data-iso]");
      const iso = p && p.dataset.iso;
      const e = iso ? byIso[iso] : null;
      svg.querySelectorAll("path.hot").forEach((x) => x.classList.remove("hot"));
      if (!e) { hideTip(); return; }
      p.classList.add("hot");
      showTip(countryTipHtml(e.row, e.st), ev.clientX, ev.clientY);
    });
    svg.addEventListener("mouseleave", () => {
      svg.querySelectorAll("path.hot").forEach((x) => x.classList.remove("hot"));
      hideTip();
    });
    svg.addEventListener("click", (ev) => {
      const p = ev.target.closest("path[data-iso]");
      const e = p && byIso[p.dataset.iso];
      if (e) openInstrument(e.row, state.ctry.lookback);
    });
  }

  const CTRY_COLS = [
    { key: "country", label: "Country" },
    { key: "name", label: "Index" },
    { key: "group", label: "Group" },
    { key: "close", label: "Close", num: true },
    { key: "z", label: "Live Z", num: true },
    { key: "dz", label: "ΔZ", num: true },
    { key: "strip", label: "Channel Strip", nosort: true },
    { key: "r", label: "R", num: true },
    { key: "trend_pct", label: "Trend / yr", num: true },
    { key: "to_mean_1y_pct", label: "To +1Y Mean", num: true },
  ];

  function ctrySortValue(entry, key) {
    if (key === "country" || key === "name" || key === "group") return entry.row[key];
    if (key === "close") return entry.row.close;
    return entry.st ? entry.st[key] : null;
  }

  function renderCountryTable() {
    const head = $("ctryHead");
    const body = $("ctryBody");
    if (!head || !body) return;
    head.innerHTML = CTRY_COLS.map((c) => {
      const label = c.key === "dz" ? `${barWord(state.ctry)} ΔZ` : c.label;
      const sorted = c.key === state.ctry.sort ? (state.ctry.dir > 0 ? " sorted-asc" : " sorted-desc") : "";
      return `<th class="${c.num ? "num-r" : ""}${sorted}"${c.nosort ? "" : ` data-ctry-sort="${c.key}"`}>${label}</th>`;
    }).join("");

    let rows = countryRows();
    if (state.ctry.group !== "All") rows = rows.filter((e) => e.row.group === state.ctry.group);
    const key = state.ctry.sort;
    rows.sort((a, b) => {
      const x = ctrySortValue(a, key);
      const y = ctrySortValue(b, key);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (typeof x === "string" ? x.localeCompare(y) : x - y) * state.ctry.dir;
    });

    body.innerHTML = rows.map((e) => {
      const r = e.row;
      const s = e.st;
      const z = s ? s.z : null;
      return `<tr data-ctry-id="${esc(r.id)}">
        <td><span class="gv-swatch" style="background:${zFill(z)}"></span><strong style="color:#fff">${esc(r.country)}</strong></td>
        <td style="color:var(--tv-muted)">${esc(r.name)}${r.used_fallback ? ` <span class="gv-tag" title="Primary ticker had too little history">via ${esc(r.yf_used)}</span>` : ""}</td>
        <td style="color:var(--tv-dim)">${esc(r.group)}</td>
        <td class="num-r">${fmtVal(r.close)}</td>
        <td class="num-r z-tag ${zCls(z)}">${s ? signed(z) + " SD" : "-"}</td>
        <td class="num-r ${s && s.dz != null ? (s.dz >= 0 ? "up" : "dn") : ""}">${s ? signed(s.dz) : "-"}</td>
        <td>${strip(z, -4, 2)}</td>
        <td class="num-r">${s ? num(s.r, 3) : "-"}</td>
        <td class="num-r ${s && s.trend_pct >= 0 ? "up" : "dn"}">${s ? signed(s.trend_pct, 1) + "%" : "-"}</td>
        <td class="num-r ${s && s.to_mean_1y_pct >= 0 ? "up" : "dn"}">${s ? signed(s.to_mean_1y_pct, 1) + "%" : "-"}</td>
      </tr>`;
    }).join("");
  }

  function renderCountries() {
    renderLegend();
    renderMap();
    renderCountryTable();
    const tag = $("ctryAsof");
    if (tag) tag.textContent = `${state.macro.counts.countries} indices · Yahoo ${state.macro.asof}`;
  }

  /* ---------------------------------------------------------------- macro */

  function macroRows(category) {
    const key = statKey(state.mac);
    return state.macro.macro
      .filter((r) => r.category === category)
      .map((row) => ({ row, st: row.stats[key] || null }));
  }

  function renderBondMatrix() {
    const host = $("bondMatrix");
    if (!host) return;
    const key = statKey(state.mac);
    const byCell = {};
    state.macro.macro.filter((r) => r.category === "bond").forEach((r) => {
      byCell[`${r.issuer}|${r.tenor}`] = r;
    });
    const header = `<div class="gv-mx-head"></div>` +
      CURVE_COLS.map((c) => `<div class="gv-mx-head">${c.label}</div>`).join("");
    const body = CURVE_ROWS.map((rw) => {
      const cells = CURVE_COLS.map((cl) => {
        const r = byCell[`${rw.issuer}|${cl.tenor}`];
        if (!r) return `<div class="gv-mx-cell empty"><div class="gv-mx-tenor">${esc(cl.label)}</div>-</div>`;
        const s = r.stats[key];
        const z = s ? s.z : null;
        return `<div class="gv-mx-cell" data-macro-id="${esc(r.id)}" style="border-left:2px solid ${zFill(z)}">
          <div class="gv-mx-tenor">${esc(cl.label)}</div>
          <div class="gv-mx-tk">${esc(r.yf_used)}</div>
          <div class="gv-mx-z ${zCls(z)}">${s ? signed(z) + " SD" : "-"}</div>
          <div class="gv-mx-s">Trend ${s ? signed(s.trend_pct, 1) + "%/yr" : "-"}</div>
          <div class="gv-mx-s">To +1Y Mean ${s ? signed(s.to_mean_1y_pct, 1) + "%" : "-"}</div>
        </div>`;
      }).join("");
      return `<div class="gv-mx-head row">${rw.label}</div>${cells}`;
    }).join("");
    host.innerHTML = header + body;
  }

  function macroTableRows(category) {
    return macroRows(category).sort((a, b) => {
      const x = a.st ? a.st.z : 99;
      const y = b.st ? b.st.z : 99;
      return x - y;
    }).map((e) => {
      const r = e.row;
      const s = e.st;
      const z = s ? s.z : null;
      const since = r.category === "crypto" ? ` <span class="gv-tag">since ${r.start_year}</span>` : "";
      return `<tr data-macro-id="${esc(r.id)}">
        <td><span class="gv-swatch" style="background:${zFill(z)}"></span><strong style="color:#fff">${esc(r.name)}</strong>${since}</td>
        <td style="color:var(--tv-muted)">${esc(r.yf_used)}</td>
        <td class="num-r">${fmtVal(r.close)}</td>
        <td class="num-r z-tag ${zCls(z)}">${s ? signed(z) + " SD" : "-"}</td>
        <td class="num-r ${s && s.dz != null ? (s.dz >= 0 ? "up" : "dn") : ""}">${s ? signed(s.dz) : "-"}</td>
        <td>${strip(z, -4, 2)}</td>
        <td class="num-r">${s ? num(s.r, 3) : "-"}</td>
        <td class="num-r ${s && s.trend_pct >= 0 ? "up" : "dn"}">${s ? signed(s.trend_pct, 1) + "%" : "-"}</td>
        <td class="num-r">${s ? fmtVal(s.mean_1y) : "-"}</td>
        <td class="num-r ${s && s.to_mean_1y_pct >= 0 ? "up" : "dn"}">${s ? signed(s.to_mean_1y_pct, 1) + "%" : "-"}</td>
      </tr>`;
    }).join("");
  }

  function renderMacro() {
    renderBondMatrix();
    const commod = $("commodBody");
    const crypto = $("cryptoBody");
    if (commod) commod.innerHTML = macroTableRows("commodity");
    if (crypto) crypto.innerHTML = macroTableRows("crypto");
    document.querySelectorAll(".gv-dz-head").forEach((el) => { el.textContent = `${barWord(state.mac)} ΔZ`; });
    const tag = $("macroAsof");
    if (tag) tag.textContent = `${state.macro.counts.macro} instruments · Yahoo ${state.macro.asof}`;
  }

  /* ---------------------------------------------------------------- scanner */

  const SCAN_COLS = [
    { key: "rank", label: "#", num: true, nosort: true },
    { key: "ticker", label: "Ticker" },
    { key: "name", label: "Name" },
    { key: "index", label: "Index" },
    { key: "sector", label: "Sector" },
    { key: "z", label: "Live Z", num: true },
    { key: "dz", label: "ΔZ", num: true },
    { key: "strip", label: "Channel Strip", nosort: true },
    { key: "r", label: "R", num: true },
    { key: "trend_pct", label: "Trend / yr", num: true },
    { key: "close", label: "Close", num: true },
    { key: "mean_now", label: "Mean", num: true },
  ];

  function scanBlock(row) {
    const F = state.stocks._F;
    const SF = state.stocks._SF;
    return tupleToBlock(row[F[statKey(state.scan)]], SF);
  }

  function scanBase() {
    const F = state.stocks._F;
    return state.stocks.rows.filter((row) => {
      if (state.scan.index !== "ALL" && row[F.index] !== state.scan.index) return false;
      const b = scanBlock(row);
      if (!b) return false;
      return (b.r == null ? -2 : b.r) >= state.scan.rmin;
    });
  }

  function scanFiltered(base) {
    const F = state.stocks._F;
    const q = state.scan.q.trim().toLowerCase();
    return base.filter((row) => {
      if (q && !String(row[F.ticker]).toLowerCase().includes(q) && !String(row[F.name]).toLowerCase().includes(q)) return false;
      if (state.scan.sector && row[F.sector] !== state.scan.sector) return false;
      if (state.scan.zones.size) {
        const z = scanBlock(row).z;
        if (!ZONES.some((zo) => state.scan.zones.has(zo.id) && zo.test(z))) return false;
      }
      return true;
    });
  }

  function scanSortValue(row, key) {
    const F = state.stocks._F;
    if (key === "ticker" || key === "name" || key === "index" || key === "sector") return row[F[key]];
    if (key === "close") return row[F.close];
    const b = scanBlock(row);
    return b ? b[key] : null;
  }

  function renderScanTabs() {
    const F = state.stocks._F;
    const host = $("scanTabs");
    if (!host) return;
    host.innerHTML = INDEX_TABS.map((t) => {
      const n = t.code === "ALL" ? state.stocks.rows.length
        : state.stocks.rows.filter((r) => r[F.index] === t.code).length;
      return `<button class="tv-tool-btn${state.scan.index === t.code ? " nav-active" : ""}" data-scan-index="${t.code}">${t.label} <span class="gv-count">${n}</span></button>`;
    }).join("");
  }

  function renderCrossings() {
    const box = $("scanCrossBox");
    if (!box) return;
    const list = state.stocks.crossings || [];
    if (!list.length) { box.hidden = true; return; }
    box.hidden = false;
    $("scanCrossCount").textContent = String(list.length);
    $("scanCrossGrid").innerHTML = list.map((c) =>
      `<button type="button" class="gv-cross-item" data-cross-tk="${esc(c.ticker)}" data-cross-ix="${esc(c.index)}">
        <b>${esc(c.ticker)}</b><span class="${zCls(c.z)}">${signed(c.z)}</span><small>${esc(c.label)}</small>
      </button>`).join("");
  }

  function renderSectorOptions(base) {
    const F = state.stocks._F;
    const sel = $("scanSector");
    if (!sel) return;
    const sectors = Array.from(new Set(base.map((r) => r[F.sector]).filter(Boolean))).sort();
    const current = state.scan.sector;
    sel.innerHTML = `<option value="">All sectors</option>` +
      sectors.map((s) => `<option value="${esc(s)}"${s === current ? " selected" : ""}>${esc(s)}</option>`).join("");
    if (current && !sectors.includes(current)) {
      state.scan.sector = "";
      sel.value = "";
    }
  }

  function renderChips(base) {
    const host = $("scanChips");
    if (!host) return;
    host.innerHTML = ZONES.map((z) => {
      const n = base.filter((r) => z.test(scanBlock(r).z)).length;
      return `<button class="gv-chip" data-scan-zone="${z.id}" aria-pressed="${state.scan.zones.has(z.id)}">
        <span class="gv-chip-dot" style="background:${z.c}"></span>${z.label} · ${n}</button>`;
    }).join("");
  }

  function renderScanner() {
    const F = state.stocks._F;
    renderScanTabs();
    renderCrossings();
    const base = scanBase();
    renderSectorOptions(base);
    renderChips(base);

    const rows = scanFiltered(base);
    rows.sort((a, b) => {
      const x = scanSortValue(a, state.scan.sort);
      const y = scanSortValue(b, state.scan.sort);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (typeof x === "string" ? x.localeCompare(y) : x - y) * state.scan.dir;
    });
    lastScanRows = rows;

    $("scanHead").innerHTML = SCAN_COLS.map((c) => {
      const label = c.key === "dz" ? `${barWord(state.scan)} ΔZ` : c.label;
      const sorted = c.key === state.scan.sort ? (state.scan.dir > 0 ? " sorted-asc" : " sorted-desc") : "";
      return `<th class="${c.num ? "num-r" : ""}${sorted}"${c.nosort ? "" : ` data-scan-sort="${c.key}"`}>${label}</th>`;
    }).join("");

    const shown = rows.slice(0, state.scan.shown);
    $("scanBody").innerHTML = shown.length ? shown.map((row, i) => {
      const b = scanBlock(row);
      const weak = (b.r == null ? 0 : b.r) < 0.7;
      const cross = row[F.cross];
      return `<tr class="${weak ? "gv-weak" : ""}" data-scan-tk="${esc(row[F.ticker])}">
        <td class="num-r gv-rank">${i + 1}</td>
        <td><strong style="color:${weak ? "var(--tv-dim)" : "#fff"}">${esc(row[F.ticker])}</strong></td>
        <td class="gv-nm" title="${esc(row[F.name])}">${esc(row[F.name])}${cross ? ` <span class="gv-tag gv-tag-cross">${esc(cross)}</span>` : ""}${weak ? ' <span class="gv-tag">weak fit</span>' : ""}</td>
        <td style="color:var(--tv-dim)">${esc(row[F.index])}</td>
        <td style="color:var(--tv-muted)" class="gv-nm">${esc(row[F.sector] || "-")}</td>
        <td class="num-r z-tag ${weak ? "" : zCls(b.z)}">${signed(b.z)} SD</td>
        <td class="num-r ${b.dz != null ? (b.dz >= 0 ? "up" : "dn") : ""}">${signed(b.dz)}</td>
        <td>${strip(b.z, -5, 5)}</td>
        <td class="num-r">${num(b.r, 2)}</td>
        <td class="num-r ${b.trend_pct >= 0 ? "up" : "dn"}">${signed(b.trend_pct, 1)}%</td>
        <td class="num-r">${fmtVal(row[F.close])}</td>
        <td class="num-r">${fmtVal(b.mean_now)}</td>
      </tr>`;
    }).join("") : `<tr><td colspan="${SCAN_COLS.length}" class="gv-empty">No rows match. Clear the search, a zone chip or lower the R filter.</td></tr>`;

    $("scanCount").textContent = `${rows.length} of ${state.stocks.total} shown`;
    const more = $("scanMore");
    more.hidden = rows.length <= state.scan.shown;
    more.textContent = `Show ${Math.min(300, rows.length - state.scan.shown)} more (${rows.length - state.scan.shown} hidden)`;
    const tag = $("scanAsof");
    if (tag) tag.textContent = `Yahoo ${state.stocks.asof} · scan ${state.stocks.generated_at.replace("T", " ").replace("Z", " UTC")}`;
  }

  function exportCsv() {
    if (!lastScanRows.length) return;
    const F = state.stocks._F;
    const head = ["ticker", "name", "index", "sector", "currency", "window", "scale",
      "sd_position", "delta_z", "pearson_r", "bars", "trend_pct_yr", "close", "mean_now", "mean_1y", "to_mean_1y_pct", "crossing"];
    const win = state.scan.lookback === "2500" ? "2500D" : "Max";
    const sc = state.scan.scale === "log" ? "Log" : "Lin";
    const lines = [head.join(",")].concat(lastScanRows.map((row) => {
      const b = scanBlock(row);
      return [row[F.ticker], row[F.name], row[F.index], row[F.sector], row[F.currency], win, sc,
        b.z, b.dz, b.r, b.n, b.trend_pct, row[F.close], b.mean_now, b.mean_1y, b.to_mean_1y_pct, row[F.cross]]
        .map((v) => (v == null ? "" : `"${String(v).replace(/"/g, '""')}"`)).join(",");
    }));
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `sd-desk-scanner-${state.stocks.asof || "latest"}-${state.scan.index.toLowerCase()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }

  /* ---------------------------------------------------------------- wiring */

  function setStatus(view, text) {
    const el = $(`gvStatus-${view}`);
    if (el) {
      el.textContent = text || "";
      el.hidden = !text;
    }
    const panel = $(`view-${view}`);
    if (panel) panel.classList.toggle("gv-busy", Boolean(text));
  }

  function bind() {
    const bindToggle = (attr, prop, store, after) => {
      document.querySelectorAll(`[data-${attr}]`).forEach((b) => {
        b.addEventListener("click", () => {
          const camel = attr.replace(/-([a-z])/g, (m, c) => c.toUpperCase());
          store[prop] = b.dataset[camel];
          document.querySelectorAll(`[data-${attr}]`).forEach((x) => x.classList.remove("active"));
          b.classList.add("active");
          after();
        });
      });
    };

    bindToggle("ctry-lb", "lookback", state.ctry, renderCountries);
    bindToggle("ctry-sc", "scale", state.ctry, renderCountries);
    bindToggle("ctry-grp", "group", state.ctry, renderCountries);
    bindToggle("mac-lb", "lookback", state.mac, renderMacro);
    bindToggle("mac-sc", "scale", state.mac, renderMacro);
    bindToggle("scan-lb", "lookback", state.scan, renderScanner);
    bindToggle("scan-sc", "scale", state.scan, renderScanner);

    $("ctryHead").addEventListener("click", (ev) => {
      const th = ev.target.closest("[data-ctry-sort]");
      if (!th) return;
      const k = th.dataset.ctrySort;
      if (state.ctry.sort === k) state.ctry.dir *= -1;
      else { state.ctry.sort = k; state.ctry.dir = (k === "country" || k === "name" || k === "group") ? 1 : (k === "z" ? 1 : -1); }
      renderCountryTable();
    });
    $("ctryBody").addEventListener("click", (ev) => {
      const tr = ev.target.closest("[data-ctry-id]");
      if (!tr) return;
      const row = state.macro.countries.find((r) => r.id === tr.dataset.ctryId);
      if (row) openInstrument(row, state.ctry.lookback);
    });

    document.querySelectorAll("[data-macro-jump]").forEach((b) => {
      b.addEventListener("click", () => {
        const target = $(b.dataset.macroJump);
        if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
    $("view-macro").addEventListener("click", (ev) => {
      const el = ev.target.closest("[data-macro-id]");
      if (!el) return;
      const row = state.macro.macro.find((r) => r.id === el.dataset.macroId);
      if (row) openInstrument(row, state.mac.lookback);
    });

    $("scanTabs").addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-scan-index]");
      if (!b) return;
      state.scan.index = b.dataset.scanIndex;
      state.scan.zones.clear();
      state.scan.shown = 300;
      renderScanner();
    });
    $("scanChips").addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-scan-zone]");
      if (!b) return;
      const z = b.dataset.scanZone;
      if (state.scan.zones.has(z)) state.scan.zones.delete(z);
      else state.scan.zones.add(z);
      state.scan.shown = 300;
      renderScanner();
    });
    $("scanSearch").addEventListener("input", (ev) => {
      state.scan.q = ev.target.value;
      state.scan.shown = 300;
      renderScanner();
    });
    $("scanSector").addEventListener("change", (ev) => {
      state.scan.sector = ev.target.value;
      state.scan.shown = 300;
      renderScanner();
    });
    $("scanFit").addEventListener("change", (ev) => {
      state.scan.rmin = Number(ev.target.value);
      state.scan.shown = 300;
      renderScanner();
    });
    $("scanHead").addEventListener("click", (ev) => {
      const th = ev.target.closest("[data-scan-sort]");
      if (!th) return;
      const k = th.dataset.scanSort;
      if (state.scan.sort === k) state.scan.dir *= -1;
      else { state.scan.sort = k; state.scan.dir = (k === "ticker" || k === "name" || k === "index" || k === "sector") ? 1 : (k === "z" ? 1 : -1); }
      renderScanner();
    });
    $("scanBody").addEventListener("click", (ev) => {
      const tr = ev.target.closest("[data-scan-tk]");
      if (!tr) return;
      const F = state.stocks._F;
      const row = state.stocks.rows.find((r) => r[F.ticker] === tr.dataset.scanTk);
      if (row) openStock(row);
    });
    $("scanCrossGrid").addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-cross-tk]");
      if (!b) return;
      state.scan.index = b.dataset.crossIx;
      state.scan.zones.clear();
      state.scan.q = b.dataset.crossTk;
      state.scan.rmin = -2;
      state.scan.shown = 300;
      $("scanSearch").value = state.scan.q;
      $("scanFit").value = "-2";
      renderScanner();
    });
    $("scanMore").addEventListener("click", () => {
      state.scan.shown += 300;
      renderScanner();
    });
    $("scanCsv").addEventListener("click", exportCsv);
  }

  async function activate(view) {
    try {
      if (view === "countries") {
        if (!state.macro || !state.map) setStatus(view, "Loading world index channels...");
        await Promise.all([ensureMacro(), ensureMap()]);
        setStatus(view, "");
        renderCountries();
      } else if (view === "macro") {
        if (!state.macro) setStatus(view, "Loading commodities, crypto and bond curves...");
        await ensureMacro();
        setStatus(view, "");
        renderMacro();
      } else if (view === "scanner") {
        if (!state.stocks) setStatus(view, "Loading global constituent scan...");
        await ensureStocks();
        setStatus(view, "");
        renderScanner();
      }
    } catch (err) {
      setStatus(view, `Could not load the Global Radar feed: ${err.message}`);
    }
  }

  root.SDGlobal = { activate, bind, state };
})(window);
