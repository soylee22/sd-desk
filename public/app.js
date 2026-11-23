/* SD Desk UI controller: TradingView-faithful layout, full-history defaults, interactive Normalised overlay, zero-prior algebraic solver, and T212 sync. */
(function () {
  "use strict";

  const M = window.SDMath;
  const C = window.SDCharts;
  const IS_LOCAL = location.hostname === "127.0.0.1" || location.hostname === "localhost";

  const state = {
    data: window.SD_DESK_DATA || null,
    view: "quadrants",
    tf: "1W",
    lookback: "max",
    useLog: true,
    bands: "34",
    bondMode: "spliced", // Full 2009+ history by default
    focusedAsset: null,
    selectedAsset: "CSP1",
    activeRange: "ALL",
    normMode: "channel",
    normVisible: { CSP1: true, CUKX: true, SJPA: true, CSWG: true, IGL5: true },
    t212: null,
    t212Loading: false,
  };

  const quadCharts = {};
  let normChart = null;
  let computed = {};

  const $ = (id) => document.getElementById(id);
  const fmtGbp = (v) => {
    const n = Number(v || 0);
    return (n < 0 ? "-£" : "£") + Math.abs(n).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  const fmtSignedGbp = (v) => {
    const n = Number(v || 0);
    return (n >= 0 ? "+£" : "-£") + Math.abs(n).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  const fmtGbp0 = (v) => {
    const n = Math.round(Number(v || 0));
    return (n < 0 ? "-£" : "£") + Math.abs(n).toLocaleString("en-GB");
  };
  const fmtZ = (z) => `${z >= 0 ? "+" : ""}${Number(z || 0).toFixed(2)} SD`;
  const fmtPct = (v) => `${v >= 0 ? "+" : ""}${Number(v || 0).toFixed(2)}%`;
  const badgeChar = (id) => (id === "CSWG" ? "A" : "i");

  function zCls(z) {
    if (z <= 0.0) return "z-low";
    if (z < 1.0) return "z-mid";
    if (z < 1.5) return "z-warm";
    return "z-hot";
  }

  function getAssetSeries(asset) {
    if (asset.id === "IGL5" && state.bondMode === "spliced") {
      const key = state.tf + "_spliced";
      if (asset.series[key]) return asset.series[key];
    }
    return asset.series[state.tf];
  }

  function recomputeAll() {
    if (!state.data) return;
    const bpy = state.tf === "1D" ? 252 : 52.1775;
    const futBars = Math.round(bpy * 2.2);
    computed = {};
    state.data.order.forEach((id) => {
      const asset = state.data.assets[id];
      const raw = getAssetSeries(asset);
      const sliced = M.sliceByLookback(raw, state.lookback);
      const stats = M.welfordOLS(sliced.c, state.useLog, bpy);
      computed[id] = {
        asset,
        series: sliced,
        stats,
        barsPerYear: bpy,
        futureBars: futBars,
        useLog: state.useLog,
        lookback: state.lookback,
        bands: state.bands,
      };
    });
  }

  function renderTopMeta() {
    if (!state.data) return;
    const asof = state.data.assets[state.data.order[0]]?.asof || "";
    const gen = state.data.generated_at ? state.data.generated_at.slice(11, 16) + " UTC" : "";
    $("asofTag").textContent = asof ? `LSE ${asof}${gen ? " · Sync " + gen : ""}` : "";
    const lbTxt = state.lookback === "max" ? "Max" : `${state.lookback}D`;
    $("railScaleTag").textContent = `${lbTxt} ${state.useLog ? "Log" : "Lin"} ${state.tf === "1W" ? "W" : "D"}`;
    $("topSymLabel").textContent = state.focusedAsset || "5-ETF";
    $("btnLogToggle").classList.toggle("active", state.useLog);
  }

  function renderRightPanel() {
    const cd = M.computeCountdown(new Date());
    $("railNextDate").textContent = cd.first_trading_label;
    $("railDays").textContent = `${cd.days_to_first_trading}d`;
    $("railCalDays").textContent = `to 1st (${cd.first_calendar_day})`;

    const statsMap = {};
    M.EQUITIES.forEach((id) => { statsMap[id] = computed[id].stats; });
    const rec = M.computeRecommendation(statsMap, 1.5);
    const badge = $("railRecBadge");
    badge.className = `tv-signal ${rec.tone}`;
    badge.textContent = rec.action;
    $("railRecText").textContent = rec.headline;

    const wl = $("watchlistRows");
    wl.innerHTML = "";
    state.data.order.forEach((id) => {
      const item = computed[id];
      const a = item.asset;
      const chg = state.tf === "1W" ? a.wk_chg_pct : a.day_chg_pct;
      const row = document.createElement("div");
      row.className = "wl-row" + (state.selectedAsset === id ? " selected" : "");
      row.innerHTML = `
        <div class="wl-sym"><span class="ishares-dot" style="background:${a.color}">${badgeChar(a.id)}</span><span>${a.id}</span></div>
        <div class="num-r">${C.fmtPx(a.last, a.currency)}</div>
        <div class="num-r ${chg >= 0 ? "up" : "dn"}">${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%</div>
        <div class="num-r z-tag ${zCls(item.stats.z)}">${item.stats.z >= 0 ? "+" : ""}${item.stats.z.toFixed(2)}</div>
      `;
      row.addEventListener("click", () => {
        state.selectedAsset = id;
        renderRightPanel();
      });
      row.addEventListener("dblclick", () => {
        state.selectedAsset = id;
        switchView("quadrants");
        toggleFocus(id, true);
      });
      wl.appendChild(row);
    });

    // Selected symbol details inspector (TradingView bottom-right pane style)
    const sel = computed[state.selectedAsset] || computed.CSP1;
    const sa = sel.asset;
    const ss = sel.stats;
    const spanTxt = sel.series.t.length ? `${sel.series.t[0].slice(0, 4)} to ${sel.series.t[sel.series.t.length - 1].slice(0, 4)}` : "";
    $("selectedSymbolDetails").innerHTML = `
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:2px;">
        <span class="ishares-dot" style="background:${sa.color}">${badgeChar(sa.id)}</span>
        <strong style="color:#fff;font-size:13px;">${sa.id}</strong>
        <span style="color:var(--tv-dim);font-size:11px;">${sa.region} · ${sa.currency}</span>
      </div>
      <div class="tv-kv"><span>Z-Score</span><span class="${zCls(ss.z)}">${fmtZ(ss.z)}</span></div>
      <div class="tv-kv"><span>Pearson R</span><span>${ss.r.toFixed(3)} (${ss.n} bars, ${spanTxt})</span></div>
      <div class="tv-kv"><span>Trend / yr</span><span class="${ss.trendPct >= 0 ? "up" : "dn"}">${ss.trendPct >= 0 ? "+" : ""}${ss.trendPct.toFixed(1)}%/yr</span></div>
      <div class="tv-kv"><span>Mean Now / +1Y</span><span>${C.fmtPx(ss.meanNow, sa.currency)} / ${C.fmtPx(ss.mean1Y, sa.currency)}</span></div>
      <div class="tv-kv"><span>To +1Y Mean</span><span class="${ss.toMean1YPct >= 0 ? "up" : "dn"}">${ss.toMean1YPct >= 0 ? "+" : ""}${ss.toMean1YPct.toFixed(1)}%</span></div>
    `;
  }

  function renderQuadrants(preserveZoom) {
    state.data.order.forEach((id) => {
      const item = computed[id];
      const a = item.asset;
      const chg = state.tf === "1W" ? a.wk_chg_pct : a.day_chg_pct;
      const hdr = $("hdr-" + id);
      const extraNote = id === "IGL5" && state.bondMode === "spliced"
        ? " (2009+ IGLS)"
        : (id === "CSWG" ? " (2010+ EWL splice)" : "");
      hdr.innerHTML = `
        <div class="quad-title">
          <span class="ishares-dot" style="background:${a.color}">${badgeChar(a.id)}</span>
          <span class="quad-ticker">${a.id}</span>
          <span class="quad-name">${a.name}${extraNote}</span>
          <span class="quad-meta">${state.tf} · LSE</span>
          <span class="quad-price ${chg >= 0 ? "up" : "dn"}">${C.fmtPx(a.last, a.currency)} (${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%)</span>
        </div>
      `;
      if (quadCharts[id]) quadCharts[id].setData(item, preserveZoom);
    });
  }

  function renderNormalised(preserveZoom) {
    const box = $("normSeriesToggles");
    box.innerHTML = "";
    state.data.order.forEach((id) => {
      const a = state.data.assets[id];
      const chip = document.createElement("button");
      chip.className = "series-chip" + (state.normVisible[id] ? "" : " off");
      chip.innerHTML = `<span class="sym-dot" style="background:${a.color}"></span>${a.id}`;
      chip.addEventListener("click", () => {
        state.normVisible[id] = !state.normVisible[id];
        renderNormalised(true);
      });
      chip.addEventListener("mouseenter", () => normChart && normChart.setHighlight(id));
      chip.addEventListener("mouseleave", () => normChart && normChart.setHighlight(null));
      box.appendChild(chip);
    });

    const dateSet = new Set();
    const maps = {};
    state.data.order.forEach((id) => {
      const item = computed[id];
      const t = item.series.t;
      const zArr = state.normMode === "causal"
        ? M.causalExpandingZ(item.series.c, state.useLog)
        : item.stats.residuals;
      const mp = new Map();
      for (let i = 0; i < t.length; i++) {
        dateSet.add(t[i]);
        mp.set(t[i], zArr[i]);
      }
      maps[id] = mp;
    });
    const dates = Array.from(dateSet).sort();
    const series = state.data.order.map((id) => ({
      id,
      color: state.data.assets[id].color,
      visible: state.normVisible[id],
      values: dates.map((d) => (maps[id].has(d) ? maps[id].get(d) : null)),
    }));
    if (normChart) normChart.setData({ dates, series }, preserveZoom);

    const tbody = $("normTableBody");
    tbody.innerHTML = "";
    const sorted = state.data.order.slice().sort((a, b) => computed[a].stats.z - computed[b].stats.z);
    sorted.forEach((id) => {
      const item = computed[id];
      const a = item.asset;
      const st = item.stats;
      const tr = document.createElement("tr");
      tr.style.cursor = "pointer";
      tr.innerHTML = `
        <td><span class="sym-dot" style="margin-right:7px;background:${a.color}"></span><strong style="color:#fff">${a.id}</strong></td>
        <td style="color:var(--tv-muted)">${a.region}</td>
        <td class="num-r">${C.fmtPx(a.last, a.currency)} ${a.currency}</td>
        <td class="num-r z-tag ${zCls(st.z)}">${fmtZ(st.z)}</td>
        <td class="num-r">${st.r.toFixed(3)}</td>
        <td class="num-r">${st.n}</td>
        <td class="num-r ${st.trendPct >= 0 ? "up" : "dn"}">${st.trendPct >= 0 ? "+" : ""}${st.trendPct.toFixed(1)}%/yr</td>
        <td class="num-r">${C.fmtPx(st.meanNow, a.currency)}</td>
        <td class="num-r">${C.fmtPx(st.mean1Y, a.currency)}</td>
        <td class="num-r ${st.toMean1YPct >= 0 ? "up" : "dn"}">${st.toMean1YPct >= 0 ? "+" : ""}${st.toMean1YPct.toFixed(1)}%</td>
      `;
      tr.addEventListener("mouseenter", () => normChart && normChart.setHighlight(id));
      tr.addEventListener("mouseleave", () => normChart && normChart.setHighlight(null));
      tbody.appendChild(tr);
    });
  }

  function renderSolver() {
    const lumpSum = Math.max(0, Number($("inLumpSum").value) || 0);
    const model = $("inAlgModel").value;
    const beta = Number($("inBeta").value) || 0;
    const bondValve = $("inBondValve").value;
    const useExisting = $("chkUseExisting").checked;

    $("lumpFmt").textContent = fmtGbp0(lumpSum);
    $("betaVal").textContent = beta.toFixed(2);
    $("betaLbl").textContent = model === "exp" ? "SD Convexity (beta)" : "Algebraic Exponent (p)";
    $("existingHoldingsBox").style.display = useExisting ? "block" : "none";

    const zById = {};
    const toMeanById = {};
    const pricesGbpById = {};
    state.data.order.forEach((id) => {
      zById[id] = computed[id].stats.z;
      toMeanById[id] = computed[id].stats.toMean1YPct;
      pricesGbpById[id] = M.priceToGbp(state.data.assets[id].last, state.data.assets[id].currency);
    });
    const existingById = {};
    M.ALL_IDS.forEach((id) => {
      const el = $("ex-" + id);
      existingById[id] = el ? Number(el.value) || 0 : 0;
    });

    const res = M.solveLumpSum({ lumpSum, model, beta, bondValve, useExisting, zById, toMeanById, pricesGbpById, existingById });
    $("solverFormula").textContent = res.formulaText + (useExisting ? "  |  Zero-sell water-fill ON" : "");

    const strip = $("solverMultStrip");
    const bar = $("solverAllocBar");
    const tbody = $("solverTableBody");
    strip.innerHTML = "";
    bar.innerHTML = "";
    tbody.innerHTML = "";

    res.rows.forEach((row) => {
      const a = state.data.assets[row.id];
      const multTxt = row.relMult > 0 ? `${row.relMult.toFixed(2)}x` : "0.00x";
      const cell = document.createElement("div");
      cell.className = "mult-cell";
      cell.innerHTML = `
        <div class="k"><span class="sym-dot" style="background:${a.color}"></span><span>${row.id} (${fmtZ(row.z)})</span></div>
        <div class="v">${multTxt}</div>
        <div class="s">${fmtGbp0(row.buyGbp)} · ${row.targetPct.toFixed(1)}%</div>
      `;
      strip.appendChild(cell);

      if (row.buyGbp > 0 && lumpSum > 0) {
        const seg = document.createElement("div");
        seg.className = "alloc-seg";
        seg.style.width = `${(row.buyGbp / lumpSum) * 100}%`;
        seg.style.background = a.color;
        bar.appendChild(seg);
      }

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><span class="sym-dot" style="margin-right:7px;background:${a.color}"></span><strong style="color:#fff">${row.id}</strong></td>
        <td class="num-r z-tag ${zCls(row.z)}">${fmtZ(row.z)}</td>
        <td class="num-r">${multTxt}</td>
        <td class="num-r">${row.targetPct.toFixed(1)}%</td>
        <td class="num-r"><strong style="color:#fff">${fmtGbp(row.buyGbp)}</strong></td>
        <td class="num-r">${row.estShares.toFixed(2)}</td>
        <td class="num-r">${row.postPct.toFixed(1)}%</td>
      `;
      tbody.appendChild(tr);
    });

    const note = $("solverWrapperNote");
    if (lumpSum > 20000) {
      note.innerHTML = `<strong>UK Tax Wrapper Split (Modelling Only):</strong> First <strong>£20,000</strong> fits one annual Stocks &amp; Shares ISA. For the remaining <strong>${fmtGbp0(lumpSum - 20000)}</strong> in a taxable GIA, prefer a distributing global ETF (VWRL or IWRD) plus direct low-coupon UK gilts (e.g. TN28, 0% CGT under TCGA 1992 s.115) rather than IGL5. Not regulated financial advice.`;
    } else {
      note.innerHTML = `<strong>UK Tax Wrapper Note (Modelling Only):</strong> ${fmtGbp0(lumpSum)} fits within the £20,000 annual UK ISA allowance if unused this tax year. Not regulated financial advice.`;
    }
  }

  function updateT212Badge() {
    const pill = $("btnT212Pill");
    if (!pill) return;
    if (!IS_LOCAL) {
      pill.innerHTML = `<span class="sym-dot" style="background:var(--tv-amber)"></span>T212 Private`;
      pill.style.color = "var(--tv-muted)";
      return;
    }
    if (!state.t212) {
      pill.textContent = "T212 ...";
      pill.style.color = "var(--tv-dim)";
    } else if (state.t212.connected) {
      const legacy = state.t212.other_positions?.length || 0;
      const inStrategy = Object.values(state.t212.sleeves || {}).filter((s) => s.value_gbp > 0).length;
      pill.innerHTML = `<span class="sym-dot" style="background:var(--tv-green)"></span>T212 Live (${inStrategy} SD · ${legacy} Legacy)`;
      pill.style.color = "var(--tv-text)";
    } else {
      pill.innerHTML = `<span class="sym-dot" style="background:var(--tv-red)"></span>T212 Offline`;
      pill.style.color = "var(--tv-red)";
    }
  }

  async function syncT212(modeAfter) {
    if (!IS_LOCAL) {
      state.t212 = { connected: false, hosted_static: true, error: "Private Trading 212 balances are never published to GitHub Pages. Check your daily private email or run python3 server.py locally." };
      updateT212Badge();
      renderPortfolio();
      return;
    }
    if (state.t212Loading) return;
    state.t212Loading = true;
    const btn = $("btnSyncT212");
    if (btn) { btn.disabled = true; btn.textContent = "Syncing..."; }
    try {
      const resp = await fetch("/api/t212", { cache: "no-store" });
      state.t212 = await resp.json();
      updateT212Badge();
      renderPortfolio();
      if (modeAfter === "sleeves" && state.t212?.connected) loadT212IntoSolver();
      else if (modeAfter === "total" && state.t212?.connected) loadT212TotalAsLumpSum();
    } catch (err) {
      state.t212 = { connected: false, error: String(err) };
      updateT212Badge();
      renderPortfolio();
    } finally {
      state.t212Loading = false;
      if (btn) { btn.disabled = false; btn.textContent = "Sync T212"; }
    }
  }

  function loadT212IntoSolver() {
    if (!IS_LOCAL) {
      const hint = $("solverT212Hint");
      if (hint) {
        hint.style.color = "var(--tv-amber)";
        hint.textContent = "Trading 212 sync stays private on local host (127.0.0.1). Tick 'Account for existing holdings' below to enter balances manually.";
      }
      $("chkUseExisting").checked = true;
      renderSolver();
      return;
    }
    if (!state.t212 || !state.t212.connected) { syncT212("sleeves"); return; }
    $("chkUseExisting").checked = true;
    M.ALL_IDS.forEach((id) => { $("ex-" + id).value = Math.round(state.t212.sleeves?.[id]?.value_gbp || 0); });
    const legacyNames = (state.t212.other_positions || []).map((p) => p.short_name).join(", ");
    const hint = $("solverT212Hint");
    if (hint) {
      hint.style.color = "#22ab94";
      hint.textContent = state.t212.strategy_total_gbp > 0
        ? `Loaded live T212 sleeves (${fmtGbp0(state.t212.strategy_total_gbp)} across SD ETFs).`
        : `T212 synced live: £0 in CSP1/CUKX/SJPA/CSWG/IGL5 so far (currently holding ${legacyNames || "legacy positions"}). Click "Use T212 Total as Lump Sum" to model switching over.`;
    }
    switchView("lumpsum");
    renderSolver();
  }

  function loadT212TotalAsLumpSum() {
    if (!IS_LOCAL) {
      const hint = $("solverT212Hint");
      if (hint) {
        hint.style.color = "var(--tv-amber)";
        hint.textContent = "Trading 212 balances stay private off GitHub Pages. Type your balance in Lump Sum (£) or run locally on 127.0.0.1.";
      }
      return;
    }
    if (!state.t212 || !state.t212.connected) { syncT212("total"); return; }
    $("chkUseExisting").checked = false;
    $("inLumpSum").value = Math.round(state.t212.total_account_gbp || 0);
    const hint = $("solverT212Hint");
    if (hint) {
      hint.style.color = "#22ab94";
      hint.textContent = `Loaded live T212 total account value (${fmtGbp(state.t212.total_account_gbp)}) as switchover lump sum.`;
    }
    switchView("lumpsum");
    renderSolver();
  }

  function renderPortfolio() {
    const st = $("t212Status");
    const kpis = $("t212Kpis");
    const slBody = $("t212SleevesBody");
    const otBody = $("t212OtherBody");

    if (!state.t212) {
      st.textContent = "Click Sync T212 to load local read-only account balances.";
      kpis.innerHTML = "";
      slBody.innerHTML = `<tr><td colspan="8" style="color:var(--tv-muted)">Not synced yet.</td></tr>`;
      otBody.innerHTML = "";
      return;
    }
    if (!state.t212.connected) {
      const col = state.t212.hosted_static ? "var(--tv-amber)" : "var(--tv-red)";
      st.textContent = state.t212.hosted_static ? "GitHub Pages static host (T212 kept private)" : `Offline: ${state.t212.error || "Check local .env"}`;
      kpis.innerHTML = "";
      slBody.innerHTML = `<tr><td colspan="8" style="color:${col}">${state.t212.error || "Unable to connect."}</td></tr>`;
      otBody.innerHTML = "";
      return;
    }
    const d = state.t212;
    st.textContent = `Connected read-only on 127.0.0.1 · Synced ${d.synced_at.replace("T", " ").replace("Z", " UTC")} · ${d.position_count} positions`;

    const cards = [
      { k: "Total Account", v: fmtGbp(d.total_account_gbp), s: "Invested + cash" },
      { k: "Invested", v: fmtGbp(d.invested_gbp), s: `Cost ${fmtGbp(d.total_cost_gbp)}` },
      { k: "Free Cash", v: fmtGbp(d.free_cash_gbp), s: "Available" },
      { k: "Unrealised P&L", v: fmtSignedGbp(d.total_pnl_gbp), s: fmtPct(d.total_pnl_pct), cls: d.total_pnl_gbp >= 0 ? "up" : "dn" },
      { k: "SD Desk Sleeves", v: fmtGbp(d.strategy_total_gbp), s: d.total_account_gbp > 0 ? `${((d.strategy_total_gbp / d.total_account_gbp) * 100).toFixed(1)}% of total` : "0.0%" },
    ];
    kpis.innerHTML = cards.map((c) => `
      <div class="kpi-cell"><div class="k">${c.k}</div><div class="v ${c.cls || ""}">${c.v}</div><div class="s ${c.cls || ""}">${c.s}</div></div>
    `).join("");

    slBody.innerHTML = "";
    state.data.order.forEach((id) => {
      const a = state.data.assets[id];
      const sl = d.sleeves[id];
      const z = computed[id].stats.z;
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><span class="sym-dot" style="margin-right:7px;background:${a.color}"></span><strong style="color:#fff">${id}</strong> <span style="color:var(--tv-dim)">${a.region}</span></td>
        <td class="num-r z-tag ${zCls(z)}">${fmtZ(z)}</td>
        <td class="num-r">${sl.quantity.toFixed(4)}</td>
        <td class="num-r">${fmtGbp(sl.value_gbp)}</td>
        <td class="num-r">${fmtGbp(sl.cost_gbp)}</td>
        <td class="num-r ${sl.pnl_gbp >= 0 ? "up" : "dn"}">${fmtSignedGbp(sl.pnl_gbp)}</td>
        <td class="num-r ${sl.pnl_pct >= 0 ? "up" : "dn"}">${fmtPct(sl.pnl_pct)}</td>
        <td class="num-r">${sl.weight_total_pct.toFixed(1)}%</td>
      `;
      slBody.appendChild(tr);
    });

    otBody.innerHTML = d.other_positions.length ? "" : `<tr><td colspan="7" style="color:var(--tv-muted)">No non-strategy holdings.</td></tr>`;
    d.other_positions.forEach((p) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><strong style="color:#fff">${p.short_name}</strong></td>
        <td style="color:var(--tv-muted)">${p.name}</td>
        <td class="num-r">${p.quantity.toFixed(4)}</td>
        <td class="num-r">${fmtGbp(p.value_gbp)}</td>
        <td class="num-r">${fmtGbp(p.cost_gbp)}</td>
        <td class="num-r ${p.pnl_gbp >= 0 ? "up" : "dn"}">${fmtSignedGbp(p.pnl_gbp)}</td>
        <td class="num-r ${p.pnl_pct >= 0 ? "up" : "dn"}">${fmtPct(p.pnl_pct)}</td>
      `;
      otBody.appendChild(tr);
    });
  }

  function applyRange(code) {
    state.activeRange = code;
    document.querySelectorAll("[data-range]").forEach((b) => b.classList.toggle("active", b.dataset.range === code));
    if (state.view === "normalised" && normChart) {
      normChart.setRangePreset(code);
    } else {
      Object.values(quadCharts).forEach((ch) => ch.setRangePreset(code));
    }
  }

  const GLOBAL_VIEWS = ["countries", "macro", "scanner"];

  function switchView(viewName) {
    state.view = viewName;
    document.querySelectorAll(".tv-topbar [data-view]").forEach((b) => b.classList.toggle("nav-active", b.dataset.view === viewName));
    document.querySelectorAll(".tv-left-rail [data-view], .tv-far-right [data-view]").forEach((b) => b.classList.toggle("active", b.dataset.view === viewName));
    document.querySelectorAll(".view-panel").forEach((p) => p.classList.toggle("active", p.id === "view-" + viewName));
    document.body.classList.toggle("global-view", GLOBAL_VIEWS.indexOf(viewName) >= 0);
    requestAnimationFrame(() => {
      if (viewName === "quadrants") renderQuadrants(true);
      else if (viewName === "normalised") renderNormalised(true);
      else if (viewName === "lumpsum") renderSolver();
      else if (viewName === "portfolio") {
        if (!state.t212) syncT212(false);
        else renderPortfolio();
      } else if (GLOBAL_VIEWS.indexOf(viewName) >= 0 && window.SDGlobal) {
        window.SDGlobal.activate(viewName);
      }
    });
  }

  function toggleFocus(assetId, forceOn) {
    const grid = $("quadGrid");
    if (!forceOn && state.focusedAsset === assetId) {
      state.focusedAsset = null;
      grid.classList.remove("single-focus");
      document.querySelectorAll(".quad-cell").forEach((c) => c.classList.remove("focused"));
    } else {
      state.focusedAsset = assetId;
      state.selectedAsset = assetId;
      grid.classList.add("single-focus");
      document.querySelectorAll(".quad-cell").forEach((c) => c.classList.toggle("focused", c.dataset.asset === assetId));
    }
    renderTopMeta();
    renderRightPanel();
    requestAnimationFrame(() => renderQuadrants(true));
  }

  function renderAll(preserveZoom) {
    recomputeAll();
    renderTopMeta();
    renderRightPanel();
    renderQuadrants(preserveZoom);
    if (state.view === "normalised") renderNormalised(preserveZoom);
    if (state.view === "lumpsum") renderSolver();
    if (state.view === "portfolio" && state.t212) renderPortfolio();
  }

  function updateClock() {
    const now = new Date();
    const hh = String(now.getUTCHours()).padStart(2, "0");
    const mm = String(now.getUTCMinutes()).padStart(2, "0");
    const ss = String(now.getUTCSeconds()).padStart(2, "0");
    $("utcClock").textContent = `${hh}:${mm}:${ss} UTC`;
  }

  function bindUI() {
    document.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => switchView(b.dataset.view)));

    const bindCtrl = (attr, apply) => {
      document.querySelectorAll(`[data-${attr}]`).forEach((b) => {
        b.addEventListener("click", () => {
          document.querySelectorAll(`[data-${attr}]`).forEach((x) => x.classList.remove("active"));
          b.classList.add("active");
          apply(b.dataset[attr]);
          renderAll(false);
        });
      });
    };
    bindCtrl("tf", (v) => { state.tf = v; });
    bindCtrl("lb", (v) => { state.lookback = v; });
    bindCtrl("bands", (v) => { state.bands = v; });
    bindCtrl("bond", (v) => { state.bondMode = v; });

    document.querySelectorAll("[data-normmode]").forEach((b) => {
      b.addEventListener("click", () => {
        document.querySelectorAll("[data-normmode]").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        state.normMode = b.dataset.normmode;
        renderNormalised(true);
      });
    });

    document.querySelectorAll("[data-range]").forEach((b) => b.addEventListener("click", () => applyRange(b.dataset.range)));

    $("btnLogToggle").addEventListener("click", () => {
      state.useLog = !state.useLog;
      renderAll(true);
    });

    $("btnAutoY").addEventListener("click", () => {
      if (!normChart) return;
      normChart.setAutoY(!normChart.autoY);
      $("btnAutoY").classList.toggle("active", normChart.autoY);
    });

    $("btnNormReset").addEventListener("click", () => {
      if (normChart) normChart.resetZoom();
      $("btnAutoY").classList.add("active");
      document.querySelectorAll("[data-range]").forEach((b) => b.classList.toggle("active", b.dataset.range === "ALL"));
    });

    $("railResetZoom").addEventListener("click", () => applyRange("ALL"));
    $("railToggleFocus").addEventListener("click", () => {
      switchView("quadrants");
      toggleFocus(state.focusedAsset || state.selectedAsset, false);
    });
    $("btnActiveSym").addEventListener("click", () => {
      if (state.focusedAsset) toggleFocus(state.focusedAsset, false);
    });

    document.querySelectorAll("[data-reset]").forEach((b) => b.addEventListener("click", () => quadCharts[b.dataset.reset]?.resetZoom()));
    document.querySelectorAll("[data-focus]").forEach((b) => b.addEventListener("click", () => toggleFocus(b.dataset.focus, false)));

    document.querySelectorAll("[data-lump]").forEach((b) => b.addEventListener("click", () => { $("inLumpSum").value = b.dataset.lump; renderSolver(); }));
    ["inLumpSum", "inAlgModel", "inBeta", "inBondValve", "chkUseExisting", "ex-CSP1", "ex-CUKX", "ex-SJPA", "ex-CSWG", "ex-IGL5"].forEach((id) => {
      const el = $(id);
      if (el) { el.addEventListener("input", renderSolver); el.addEventListener("change", renderSolver); }
    });

    $("btnRefresh").addEventListener("click", async () => {
      const btn = $("btnRefresh");
      btn.disabled = true; btn.textContent = "Syncing...";
      try {
        if (IS_LOCAL) {
          const resp = await fetch("/api/refresh", { method: "POST" });
          const json = await resp.json();
          if (json.ok && json.data) { state.data = json.data; renderAll(false); }
        } else {
          const resp = await fetch("./data/market_data.json?t=" + Date.now(), { cache: "no-store" });
          if (resp.ok) { state.data = await resp.json(); renderAll(false); }
        }
      } finally { btn.disabled = false; btn.textContent = "Refresh"; }
    });

    $("btnSyncT212").addEventListener("click", () => syncT212(null));
    $("btnUseInSolver").addEventListener("click", loadT212IntoSolver);
    $("btnPullT212ToSolver").addEventListener("click", loadT212IntoSolver);
    $("btnUseT212Total").addEventListener("click", loadT212TotalAsLumpSum);

    const setRailCollapsed = (collapsed) => {
      document.body.classList.toggle("rail-collapsed", collapsed);
      $("btnToggleRail")?.classList.toggle("active", !collapsed);
      requestAnimationFrame(() => {
        if (state.view === "quadrants") renderQuadrants(true);
        else if (state.view === "normalised" && normChart) normChart.render();
      });
    };
    $("btnToggleRail")?.addEventListener("click", () => {
      setRailCollapsed(!document.body.classList.contains("rail-collapsed"));
    });
    $("btnCloseRail")?.addEventListener("click", () => setRailCollapsed(true));
    $("drawerBackdrop")?.addEventListener("click", () => setRailCollapsed(true));

    // Default watchlist collapsed on narrow/mobile screens so charts use 100% width
    setRailCollapsed(window.innerWidth <= 900);

    window.addEventListener("resize", () => {
      if (state.view === "quadrants") renderQuadrants(true);
      else if (state.view === "normalised" && normChart) normChart.render();
    });
  }

  async function boot() {
    if (!state.data) {
      const resp = await fetch(IS_LOCAL ? "/api/data" : "./data/market_data.json?t=" + Date.now(), { cache: "no-store" });
      state.data = await resp.json();
    }
    state.data.order.forEach((id) => { quadCharts[id] = new C.QuadrantChart($("cv-" + id), id); });
    normChart = new C.NormalisedChart($("cv-norm"));
    bindUI();
    if (window.SDGlobal) window.SDGlobal.bind();
    updateClock();
    setInterval(updateClock, 1000);
    renderAll(false);
    renderSolver();
    syncT212(null); // Auto-connect locally; safely shows private notice on GitHub Pages
    if (!IS_LOCAL) {
      // Auto-sync hourly GitHub Actions market_data.json updates every 15 minutes while open
      setInterval(async () => {
        try {
          const r = await fetch("./data/market_data.json?t=" + Date.now(), { cache: "no-store" });
          if (r.ok) {
            const fresh = await r.json();
            if (fresh && fresh.generated_at !== state.data?.generated_at) {
              state.data = fresh;
              renderAll(true);
            }
          }
        } catch (_) {}
      }, 900000);
    }
  }

  boot();
})();
