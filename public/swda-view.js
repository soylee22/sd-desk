/* SD Desk SWDA Signals View: Unlevered Single-Global-ETF Valuation Zone, Optional Gilt Caution (>= +1.5 SD), and 50/50 Hot Lump-Sum Planner. */
(function (root) {
  "use strict";

  const M = root.SDMath;
  const C = root.SDCharts;

  const ui = {
    windowKey: "2500",   // "2500" (10Y Roll, recommended) | "1250" (5Y Roll) | "max" (Max)
    calcMode: "dca",     // "dca" (Monthly Payday + Reserve) | "lumpsum" (Fresh Lump Sum 100% vs 50/50 12m)
    hysteresis: "dual",  // "dual" (anti-whipsaw monthly state) | "live" (live Z preview)
    chart: null,
    bound: false,
  };

  const $ = (id) => document.getElementById(id);
  const fmtGbp0 = (v) => {
    const n = Math.round(Number(v || 0));
    return (n < 0 ? "-£" : "£") + Math.abs(n).toLocaleString("en-GB");
  };
  const fmtZ = (z) => `${z >= 0 ? "+" : ""}${Number(z || 0).toFixed(2)} SD`;
  const fmtPx = (v) => (Number.isFinite(v) ? `${Math.round(v).toLocaleString("en-GB")}p` : "--");
  const fmtPct = (v) => `${v >= 0 ? "+" : ""}${Number(v || 0).toFixed(1)}%`;

  function zCls(z) {
    if (z <= 0.0) return "z-low";
    if (z < 1.0) return "z-mid";
    if (z < 1.5) return "z-warm";
    return "z-hot";
  }

  function resolveSignal(swdaData) {
    const win = swdaData.windows[ui.windowKey] || swdaData.windows["2500"];
    const sma = swdaData.sma40 || { value: swdaData.asset.last, above: true, dist_pct: 0 };
    const zLive = Number(win.live_z || 0);

    let stateCode = win.state || "NEUTRAL";
    if (ui.hysteresis === "live") {
      if (zLive <= 0.0) stateCode = "BELOW";
      else if (zLive >= 1.5) stateCode = "CAUTION";
      else stateCode = "NEUTRAL";
    }

    // Preview upcoming 1st-of-month transition under Dual Hysteresis
    let pendingSwitch = "";
    if (ui.hysteresis === "dual") {
      let nextState = stateCode;
      if (stateCode === "CAUTION") {
        if (zLive <= 0.0) nextState = "BELOW";
        else if (zLive <= 0.5) nextState = "NEUTRAL";
      } else {
        if (zLive >= 1.5) nextState = "CAUTION";
        else if (zLive <= 0.0) nextState = "BELOW";
        else nextState = "NEUTRAL";
      }
      if (nextState !== stateCode) {
        const desc = nextState === "BELOW"
          ? "BELOW LINE (Buy 100% + Sweep Reserve)"
          : (nextState === "CAUTION" ? "CAUTION >= +1.5 SD (Optional Gilts / 50-50 Lump Sum)" : "NEUTRAL (Buy 100% New Cash)");
        pendingSwitch = `Pending 1st-of-month shift: live Z (${fmtZ(zLive)}) moves ${stateCode} to ${desc} on next payday check.`;
      }
    }

    let badgeText = "NEUTRAL: BUY 100% SWDA";
    let tone = "normal";
    let actionCopy = "";
    let belowTrigger = { label: "At/Below Mean (Sweep Line)", z: 0.0, px: win.levels.z00 };
    let cautionTrigger = { label: "Caution Gate (Optional Gilts)", z: 1.5, px: win.levels.p15 };

    if (stateCode === "BELOW") {
      badgeText = "BELOW LINE: BUY 100% + SWEEP";
      tone = "deploy";
      actionCopy = "SWDA sits at or below its trend line (higher 1 to 5Y expected return and stronger worst-case floor). Deploy 100% of monthly cash, sweep any parked IGL5/CSH2 reserve, and invest fresh lump sums 100% immediately.";
      belowTrigger = { label: "Deep Value (-1.0 SD)", z: -1.0, px: win.levels.m10 };
      cautionTrigger = { label: "Caution Gate (+1.5 SD)", z: 1.5, px: win.levels.p15 };
    } else if (stateCode === "CAUTION") {
      badgeText = "STRETCHED: OPTIONAL GILTS / 50-50 LS";
      tone = "park";
      actionCopy = "Caution state active (entered >= +1.50 SD). Equities still carry positive expected return, so 100% buying remains valid for max long-run wealth. For caution: park new monthly cash in IGL5/CSH2 until Z <= +0.50 SD, and stage fresh lump sums 50% now + 50% over 12m (sweeping early if Z <= 0.0 SD).";
      belowTrigger = { label: "Exit Caution (Cool <= +0.5 SD)", z: 0.5, px: win.levels.p05 };
      cautionTrigger = { label: "Sweep Reserve Line (0.0 SD)", z: 0.0, px: win.levels.z00 };
    } else {
      badgeText = "NEUTRAL: BUY 100% NEW CASH";
      tone = "normal";
      actionCopy = "Inside the normal band (0.00 to +1.50 SD). Invest 100% of new monthly cash into SWDA / VWRP / VALL and deploy fresh lump sums 100% immediately. Leave any prior gilt reserve parked until Z <= 0.00 SD.";
      belowTrigger = { label: "Below-Line Sweep (0.0 SD)", z: 0.0, px: win.levels.z00 };
      cautionTrigger = { label: "Caution Gate (+1.5 SD)", z: 1.5, px: win.levels.p15 };
    }

    return {
      win,
      sma,
      zLive,
      stateCode,
      badgeText,
      tone,
      actionCopy,
      pendingSwitch,
      belowTrigger,
      cautionTrigger,
    };
  }

  function renderChart(swdaData, preserveZoom) {
    if (!ui.chart) {
      const cv = $("cv-swda");
      if (cv) ui.chart = new C.QuadrantChart(cv, "SWDA");
    }
    if (!ui.chart) return;
    const a = swdaData.asset;
    const raw = a.series["1W"];
    const sliced = M.sliceByLookback(raw, ui.windowKey);
    const stats = M.welfordOLS(sliced.c, true, 52.1775);
    const lbLabel = ui.windowKey === "2500" ? "10Y Roll (2500D)" : (ui.windowKey === "1250" ? "5Y Roll (1250D)" : "Max Log");

    const hdr = $("hdr-SWDA");
    if (hdr) {
      const chg = Number(a.wk_chg_pct || 0);
      hdr.innerHTML = `
        <div class="quad-title">
          <span class="ishares-dot" style="background:${a.color}">i</span>
          <span class="quad-ticker">SWDA</span>
          <span class="quad-name">${a.name} · ${lbLabel}</span>
          <span class="quad-meta">1W · LSE</span>
          <span class="quad-price ${chg >= 0 ? "up" : "dn"}">${fmtPx(a.last)} (${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%)</span>
        </div>
      `;
    }

    ui.chart.setData({
      asset: a,
      series: sliced,
      stats,
      barsPerYear: 52.1775,
      futureBars: Math.round(52.1775 * 2.0),
      useLog: true,
      lookback: ui.windowKey,
      bands: "12",
    }, preserveZoom);
  }

  function renderCalculator(sig) {
    const isLs = ui.calcMode === "lumpsum";
    const dcaBox = $("swdaDcaInputs");
    const lsBox = $("swdaLsInputs");
    if (dcaBox) dcaBox.style.display = isLs ? "none" : "block";
    if (lsBox) lsBox.style.display = isLs ? "block" : "none";

    let eqNow = 0;
    let parkNow = 0;
    let total = 0;
    let summaryTxt = "";
    let eqNote = "";
    let parkNote = "";

    if (!isLs) {
      const monthly = Math.max(0, Number($("swdaMonthly")?.value) || 0);
      const reserve = Math.max(0, Number($("swdaReserve")?.value) || 0);
      const useCaution = Boolean($("swdaUseCaution")?.checked);
      if ($("swdaMonthlyFmt")) $("swdaMonthlyFmt").textContent = fmtGbp0(monthly);
      total = monthly + reserve;

      if (sig.stateCode === "BELOW") {
        eqNow = monthly + reserve;
        parkNow = 0;
        summaryTxt = `Below-line deploy: 100% into SWDA/VWRP (${fmtGbp0(eqNow)}) · Sweep entire gilt reserve`;
        eqNote = reserve > 0 ? `New cash ${fmtGbp0(monthly)} + swept reserve ${fmtGbp0(reserve)}` : "100% of new monthly cash";
        parkNote = "Sweep £0 remaining";
      } else if (sig.stateCode === "CAUTION" && useCaution) {
        eqNow = 0;
        parkNow = monthly + reserve;
        summaryTxt = `Caution gate active: park ${fmtGbp0(monthly)} new cash in IGL5/CSH2 · Hold reserve until Z <= 0.0 SD`;
        eqNote = "Paused while Z >= +1.5 SD (caution mode)";
        parkNote = `Add ${fmtGbp0(monthly)} new cash (total parked ${fmtGbp0(parkNow)})`;
      } else {
        eqNow = monthly;
        parkNow = reserve;
        summaryTxt = `Normal monthly buy: ${fmtGbp0(monthly)} into SWDA/VWRP · Keep ${fmtGbp0(reserve)} reserve parked until Z <= 0.0 SD`;
        eqNote = "100% of new monthly cash";
        parkNote = reserve > 0 ? "Keep existing reserve parked until Z <= 0.0 SD" : "No reserve parked";
      }
    } else {
      const lump = Math.max(0, Number($("swdaLump")?.value) || 0);
      if ($("swdaLumpFmt")) $("swdaLumpFmt").textContent = fmtGbp0(lump);
      total = lump;

      if (sig.stateCode === "CAUTION") {
        eqNow = lump * 0.5;
        parkNow = lump * 0.5;
        const drip = Math.round(parkNow / 12);
        summaryTxt = `Stretched entry (>= +1.5 SD): 50% immediate (${fmtGbp0(eqNow)}) + 50% dripped ~${fmtGbp0(drip)}/mo over 12m`;
        eqNote = "50% immediate core (avoids stranded-cash trap)";
        parkNote = `Drip ${fmtGbp0(drip)}/mo over 12m, or sweep 100% early if Z <= 0.0 SD`;
      } else {
        eqNow = lump;
        parkNow = 0;
        summaryTxt = sig.stateCode === "BELOW"
          ? `Below-line lump sum: 100% immediate (${fmtGbp0(eqNow)}) · Discount + time in market`
          : `Neutral lump sum: 100% immediate (${fmtGbp0(eqNow)}) · No staging needed below +1.5 SD`;
        eqNote = "Deploy 100% immediately";
        parkNote = "No cash holdback needed";
      }
    }

    const eqPct = total > 0 ? (eqNow / total) * 100 : 100;
    const pkPct = total > 0 ? (parkNow / total) * 100 : 0;

    if ($("swdaEffTag")) $("swdaEffTag").textContent = summaryTxt;
    if ($("swdaAllocBar")) {
      const segs = [];
      if (eqPct > 0.1) segs.push(`<div class="alloc-seg" style="width:${eqPct.toFixed(1)}%;background:#38BDF8;" title="SWDA/VWRP/VALL: ${eqPct.toFixed(1)}%"></div>`);
      if (pkPct > 0.1) segs.push(`<div class="alloc-seg" style="width:${pkPct.toFixed(1)}%;background:#089981;" title="IGL5/CSH2: ${pkPct.toFixed(1)}%"></div>`);
      $("swdaAllocBar").innerHTML = segs.join("");
    }

    if ($("swdaCalcBody")) {
      $("swdaCalcBody").innerHTML = `
        <tr>
          <td><span class="sym-dot" style="margin-right:7px;background:#38BDF8"></span><strong style="color:#fff">SWDA / VWRP / VALL</strong><div style="font-size:11px;color:var(--tv-dim);margin-left:15px;">${eqNote}</div></td>
          <td class="num-r" style="font-weight:700;color:#fff;">${eqPct.toFixed(1)}%</td>
          <td class="num-r up" style="font-weight:700;">${fmtGbp0(eqNow)}</td>
        </tr>
        <tr>
          <td><span class="sym-dot" style="margin-right:7px;background:#089981"></span><strong style="color:#fff">IGL5 / CSH2</strong><div style="font-size:11px;color:var(--tv-dim);margin-left:15px;">${parkNote}</div></td>
          <td class="num-r" style="font-weight:700;color:#fff;">${pkPct.toFixed(1)}%</td>
          <td class="num-r" style="font-weight:700;color:var(--tv-text);">${fmtGbp0(parkNow)}</td>
        </tr>
      `;
    }
  }

  function render(preserveZoom) {
    const data = root.SD_DESK_DATA_LIVE ? root.SD_DESK_DATA_LIVE() : root.SD_DESK_DATA;
    const swdaData = data && data.swda_signals;
    if (!swdaData) return;

    const sig = resolveSignal(swdaData);
    const a = swdaData.asset;
    const win = sig.win;
    const cd = M.computeCountdown(new Date());

    const belowDist = a.last > 0 ? ((sig.belowTrigger.px / a.last) - 1) * 100 : 0;
    const cautDist = a.last > 0 ? ((sig.cautionTrigger.px / a.last) - 1) * 100 : 0;
    const smaBadge = sig.sma.above
      ? `<span class="up">Above 40W SMA (${fmtPx(sig.sma.value)}, ${fmtPct(sig.sma.dist_pct)})</span>`
      : `<span class="dn">Below 40W SMA (${fmtPx(sig.sma.value)}, ${fmtPct(sig.sma.dist_pct)})</span>`;

    const kpiBox = $("swdaKpis");
    if (kpiBox) {
      kpiBox.innerHTML = `
        <div class="kpi-card">
          <div class="k">Valuation Zone (${ui.windowKey === "2500" ? "10Y Roll" : (ui.windowKey === "1250" ? "5Y Roll" : "Max")})</div>
          <div style="margin:5px 0 4px;"><span class="tv-signal ${sig.tone}">${sig.badgeText}</span></div>
          <div class="s">Live Z: <strong class="${zCls(sig.zLive)}">${fmtZ(sig.zLive)}</strong> · Last 1st check ${win.last_check_date || "--"} (${fmtZ(win.last_check_z)})</div>
          <div class="s">${smaBadge}</div>
        </div>
        <div class="kpi-card">
          <div class="k">${sig.belowTrigger.label}</div>
          <div class="v">${fmtPx(sig.belowTrigger.px)}</div>
          <div class="s">Level ${fmtZ(sig.belowTrigger.z)} · ${fmtPct(belowDist)} from current ${fmtPx(a.last)}</div>
        </div>
        <div class="kpi-card">
          <div class="k">${sig.cautionTrigger.label}</div>
          <div class="v">${fmtPx(sig.cautionTrigger.px)}</div>
          <div class="s">Level ${fmtZ(sig.cautionTrigger.z)} · ${fmtPct(cautDist)} from current ${fmtPx(a.last)}</div>
        </div>
        <div class="kpi-card">
          <div class="k">Monthly Check Cadence</div>
          <div class="v">${cd.days_to_first_trading}d <span style="font-size:12px;color:var(--tv-muted);font-weight:500;">to ${cd.first_trading_label}</span></div>
          <div class="s">${win.switches_count} zone shifts over ${win.span_yrs}y (${win.switches_per_yr.toFixed(2)}/yr) · Dual Hysteresis</div>
        </div>
      `;
    }

    const actionBanner = $("swdaActionBanner");
    if (actionBanner) {
      const pendHtml = sig.pendingSwitch
        ? `<div style="margin-top:4px;color:#34d399;font-weight:600;">${sig.pendingSwitch}</div>`
        : "";
      actionBanner.innerHTML = `<strong style="color:#fff;">Guidance:</strong> ${sig.actionCopy}${pendHtml}`;
    }

    const swBody = $("swdaSwitchBody");
    if (swBody) {
      const list = win.switches || [];
      if (!list.length) {
        swBody.innerHTML = `<tr><td colspan="5" style="color:var(--tv-muted);">No monthly zone switches recorded in this window.</td></tr>`;
      } else {
        swBody.innerHTML = list.map((s) => {
          const toCls = s.to === "BELOW" ? "z-low" : (s.to === "CAUTION" ? "z-hot" : "z-mid");
          return `
            <tr>
              <td style="color:#fff;">${s.date}</td>
              <td class="num-r z-tag ${zCls(s.z)}">${fmtZ(s.z)}</td>
              <td class="num-r">${fmtPx(s.px)}</td>
              <td><span style="color:var(--tv-dim);">${s.from}</span> → <strong class="${toCls}">${s.to}</strong></td>
              <td class="num-r" style="color:var(--tv-text);">${s.action || "--"}</td>
            </tr>
          `;
        }).join("");
      }
    }

    renderChart(swdaData, preserveZoom);
    renderCalculator(sig);
  }

  function bind() {
    if (ui.bound) return;
    ui.bound = true;

    document.querySelectorAll("[data-swda-win]").forEach((b) => {
      b.addEventListener("click", () => {
        document.querySelectorAll("[data-swda-win]").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        ui.windowKey = b.dataset.swdaWin;
        render(false);
      });
    });

    document.querySelectorAll("[data-swda-calc]").forEach((b) => {
      b.addEventListener("click", () => {
        document.querySelectorAll("[data-swda-calc]").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        ui.calcMode = b.dataset.swdaCalc;
        render(true);
      });
    });

    document.querySelectorAll("[data-swda-hyst]").forEach((b) => {
      b.addEventListener("click", () => {
        document.querySelectorAll("[data-swda-hyst]").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        ui.hysteresis = b.dataset.swdaHyst;
        render(true);
      });
    });

    document.querySelectorAll("[data-swda-lump]").forEach((b) => {
      b.addEventListener("click", () => {
        if ($("swdaLump")) $("swdaLump").value = b.dataset.swdaLump;
        render(true);
      });
    });

    ["swdaMonthly", "swdaReserve", "swdaUseCaution", "swdaLump"].forEach((id) => {
      const el = $(id);
      if (el) {
        el.addEventListener("input", () => render(true));
        el.addEventListener("change", () => render(true));
      }
    });

    const resetBtn = $("btnSwdaReset");
    if (resetBtn) {
      resetBtn.addEventListener("click", () => ui.chart && ui.chart.resetZoom());
    }
  }

  root.SDSwda = {
    bind,
    render,
    setRangePreset(code) {
      if (ui.chart) ui.chart.setRangePreset(code);
    },
    resize() {
      if (ui.chart) ui.chart.render();
    },
  };
})(typeof window !== "undefined" ? window : globalThis);
