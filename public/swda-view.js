/* SD Desk SWDA Signals View: Single-Global-ETF Step DeepDip (80/100/130% Dual Hysteresis), ReboundBoost, and Unlevered Z-Tilt. */
(function (root) {
  "use strict";

  const M = root.SDMath;
  const C = root.SDCharts;

  const ui = {
    windowKey: "2500",      // "2500" (10Y Roll, recommended) | "1250" (5Y Roll) | "max" (Expanding)
    mode: "deepdip",        // "deepdip" | "rebound" | "unlev"
    hysteresis: "dual",     // "dual" (anti-whipsaw) | "strict" (preview live Z directly)
    chart: null,
    bound: false,
  };

  const $ = (id) => document.getElementById(id);
  const fmtGbp0 = (v) => {
    const n = Math.round(Number(v || 0));
    return (n < 0 ? "-£" : "£") + Math.abs(n).toLocaleString("en-GB");
  };
  const fmtSignedGbp0 = (v) => {
    const n = Math.round(Number(v || 0));
    return (n >= 0 ? "+£" : "-£") + Math.abs(n).toLocaleString("en-GB");
  };
  const fmtZ = (z) => `${z >= 0 ? "+" : ""}${Number(z || 0).toFixed(2)} SD`;
  const fmtPx = (v) => (Number.isFinite(v) ? `${Math.round(v).toLocaleString("en-GB")}p` : "--");
  const fmtPct = (v) => `${v >= 0 ? "+" : ""}${Number(v || 0).toFixed(1)}%`;

  function zCls(z) {
    if (z <= -1.0) return "z-low";
    if (z <= 0.0) return "z-mid";
    if (z < 1.5) return "z-warm";
    return "z-hot";
  }

  function targetSleevesFromEff(wEff) {
    const w = Math.max(0, Math.min(2, wEff));
    if (w <= 1.0) {
      return { w1x: w, w2x: 0, wCash: 1.0 - w, eff: w };
    }
    return { w1x: 2.0 - w, w2x: w - 1.0, wCash: 0, eff: w };
  }

  function resolveSignal(swdaData) {
    const win = swdaData.windows[ui.windowKey] || swdaData.windows["2500"];
    const a = swdaData.asset;
    const sma = swdaData.sma10 || { value: a.last, above: true, dist_pct: 0 };
    const zLive = Number(win.live_z || 0);

    // Determine active state & target exposure based on strategy mode + hysteresis setting
    let stateCode = win.state || "NORMAL";
    if (ui.hysteresis === "strict") {
      if (zLive >= 1.5) stateCode = "HOT";
      else if (zLive <= -1.0) stateCode = "DIP";
      else stateCode = "NORMAL";
    }

    let effW = 1.0;
    let badgeText = "HOLD 100% SWDA";
    let tone = "normal";
    let actionCopy = "";
    let pendingSwitch = "";
    let downTrigger = { label: "Boost to 130% (Dip)", z: -1.0, px: win.levels.m10 };
    let upTrigger = { label: "Trim to 80/20 (Hot)", z: 1.5, px: win.levels.p15 };

    if (ui.mode === "deepdip") {
      // Compute what the NEXT 1st-of-month check would transition to if today's live Z holds
      if (ui.hysteresis === "dual") {
        let nextState = stateCode;
        if (stateCode === "NORMAL") {
          if (zLive >= 1.5) nextState = "HOT";
          else if (zLive <= -1.0) nextState = "DIP";
        } else if (stateCode === "HOT") {
          if (zLive <= -1.0) nextState = "DIP";
          else if (zLive <= 0.5) nextState = "NORMAL";
        } else if (stateCode === "DIP") {
          if (zLive >= 1.5) nextState = "HOT";
          else if (zLive >= 0.0) nextState = "NORMAL";
        }
        if (nextState !== stateCode) {
          const nextDesc = nextState === "HOT" ? "HOT (80% SWDA / 20% CSH2)" : (nextState === "DIP" ? "DIP (70% SWDA / 30% 2x)" : "NORMAL (100% 1x SWDA)");
          pendingSwitch = `Pending 1st-of-month switch: live Z (${fmtZ(zLive)}) crossed exit band -> queued to move ${stateCode} to ${nextDesc} on next payday check.`;
        }
      }

      if (stateCode === "HOT") {
        effW = 0.80;
        badgeText = "HOT: 80% SWDA · 20% CSH2";
        tone = "park";
        actionCopy = `Overheated state active (entered >= +1.50 SD). Hold 80% 1x SWDA and 20% CSH2 cash until a monthly 1st-of-month close cools to <= +0.50 SD.`;
        downTrigger = { label: "Cool back to 100% (Exit Hot)", z: 0.5, px: win.levels.p05 };
        upTrigger = { label: "Already trimmed (Stay 80/20)", z: 1.5, px: win.levels.p15 };
      } else if (stateCode === "DIP") {
        effW = 1.30;
        badgeText = "DEEP DIP: 70% SWDA · 30% 2X";
        tone = "deploy";
        actionCopy = `Deep-dip booster active (entered <= -1.00 SD). Hold 70% 1x SWDA + 30% 2x World (130% exposure) until a monthly 1st-of-month close recovers to >= 0.00 SD.`;
        downTrigger = { label: "Booster already ON (130%)", z: -1.0, px: win.levels.m10 };
        upTrigger = { label: "Reset to 100% (Exit Dip)", z: 0.0, px: win.levels.z00 };
      } else {
        effW = 1.00;
        badgeText = "NORMAL: 100% 1X SWDA";
        tone = "normal";
        actionCopy = `Inside the neutral band (-1.00 to +1.50 SD). Hold 100% 1x SWDA / VWRP / VALL with 0% cash and 0% leverage. No rebalance trade needed.`;
        downTrigger = { label: "Enter 130% Dip Boost", z: -1.0, px: win.levels.m10 };
        upTrigger = { label: "Enter 80/20 Hot Trim", z: 1.5, px: win.levels.p15 };
      }
    } else if (ui.mode === "rebound") {
      if (zLive >= 1.5 || (ui.hysteresis === "dual" && stateCode === "HOT")) {
        effW = 0.75;
        badgeText = "HOT: 75% SWDA · 25% CSH2";
        tone = "park";
        actionCopy = `Overheated >= +1.50 SD. Trim to 75% 1x SWDA + 25% CSH2 cash until Z cools back below +0.50 SD on a monthly check.`;
        downTrigger = { label: "Cool back to 100%", z: 0.5, px: win.levels.p05 };
        upTrigger = { label: "Already trimmed (75/25)", z: 1.5, px: win.levels.p15 };
      } else if (zLive <= -0.5 && sma.above) {
        effW = 1.35;
        badgeText = "REBOUND BOOST: 65% SWDA · 35% 2X";
        tone = "deploy";
        actionCopy = `Below -0.50 SD AND price is above its 10-week SMA (${fmtPx(sma.value)}). Trend confirmed: deploy 35% into 2x World (135% exposure).`;
        downTrigger = { label: "10W SMA Brake", z: -0.5, px: sma.value };
        upTrigger = { label: "Reset to 100%", z: 0.0, px: win.levels.z00 };
      } else if (zLive <= -0.5 && !sma.above) {
        effW = 1.00;
        badgeText = "FALLING KNIFE BRAKE: 100% 1X";
        tone = "normal";
        actionCopy = `Z is below -0.50 SD (${fmtZ(zLive)}), but SWDA sits below its 10W SMA (${fmtPx(sma.value)}). Hold 100% unlevered until price reclaims ${fmtPx(sma.value)}.`;
        downTrigger = { label: "Armed (Waiting > 10W SMA)", z: -0.5, px: sma.value };
        upTrigger = { label: "Hot Trim Trigger", z: 1.5, px: win.levels.p15 };
      } else {
        effW = 1.00;
        badgeText = "NORMAL: 100% 1X SWDA";
        tone = "normal";
        actionCopy = `Neutral band. Hold 100% 1x SWDA. Boosts to 135% only when Z <= -0.50 SD AND price > 10W SMA (${fmtPx(sma.value)}).`;
        downTrigger = { label: "Arm Rebound Boost (<= -0.5)", z: -0.5, px: win.levels.m05 };
        upTrigger = { label: "Enter 75/25 Hot Trim", z: 1.5, px: win.levels.p15 };
      }
    } else {
      // Unlevered Balanced Z-Tilt: 85% at Z=0, 100% at Z <= -1.0, down to 55% at Z >= +2.0
      effW = Math.min(1.0, Math.max(0.55, 0.85 - 0.15 * zLive));
      const eqPct = Math.round(effW * 100);
      const caPct = 100 - eqPct;
      badgeText = `UNLEV Z-TILT: ${eqPct}% SWDA · ${caPct}% CSH2`;
      tone = effW >= 0.95 ? "deploy" : (effW <= 0.70 ? "park" : "normal");
      actionCopy = `Zero leverage. Target weight = clip(85% - 15% * Z, 55%, 100%). Only rebalance on the 1st of the month if actual weight drifts >= 5% from target.`;
      downTrigger = { label: "Full 100% Equity", z: -1.0, px: win.levels.m10 };
      upTrigger = { label: "Floor 55% Equity", z: 2.0, px: win.levels.p15 };
    }

    return {
      win,
      sma,
      zLive,
      stateCode,
      sleeves: targetSleevesFromEff(effW),
      badgeText,
      tone,
      actionCopy,
      pendingSwitch,
      downTrigger,
      upTrigger,
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

  function renderCalculator(swdaData, sig) {
    const pot = Math.max(0, Number($("swdaPot")?.value) || 0);
    const addCash = Math.max(0, Number($("swdaAddCash")?.value) || 0);
    const useCur = Boolean($("swdaUseCur")?.checked);
    const curBox = $("swdaCurBox");
    if (curBox) curBox.style.display = useCur ? "block" : "none";

    const cur1x = useCur ? Math.max(0, Number($("swdaCur1x")?.value) || 0) : 0;
    const cur2x = useCur ? Math.max(0, Number($("swdaCur2x")?.value) || 0) : 0;
    const curCash = useCur ? Math.max(0, Number($("swdaCurCash")?.value) || 0) : 0;

    const totalVal = useCur ? (cur1x + cur2x + curCash + addCash) : (pot + addCash);
    if ($("swdaPotFmt")) $("swdaPotFmt").textContent = fmtGbp0(totalVal);

    const { w1x, w2x, wCash, eff } = sig.sleeves;
    const tgt1x = totalVal * w1x;
    const tgt2x = totalVal * w2x;
    const tgtCash = totalVal * wCash;

    const rows = [
      {
        id: "SWDA / VWRP / VALL",
        role: "1x Global Core",
        color: "#38BDF8",
        tgtPct: w1x * 100,
        tgtGbp: tgt1x,
        curGbp: cur1x,
        delta: useCur ? (tgt1x - cur1x) : tgt1x,
      },
      {
        id: "LWLD / XS2D / CL2",
        role: "2x Dip Booster",
        color: "#C084FC",
        tgtPct: w2x * 100,
        tgtGbp: tgt2x,
        curGbp: cur2x,
        delta: useCur ? (tgt2x - cur2x) : tgt2x,
      },
      {
        id: "CSH2",
        role: "GBP Overnight Cash",
        color: "#089981",
        tgtPct: wCash * 100,
        tgtGbp: tgtCash,
        curGbp: curCash,
        delta: useCur ? (tgtCash - curCash) : tgtCash,
      },
    ];

    const bar = $("swdaAllocBar");
    if (bar) {
      bar.innerHTML = rows
        .filter((r) => r.tgtPct > 0.1)
        .map((r) => `<div class="alloc-seg" style="width:${r.tgtPct.toFixed(1)}%;background:${r.color};" title="${r.id}: ${r.tgtPct.toFixed(1)}%"></div>`)
        .join("");
    }

    const effTag = $("swdaEffTag");
    if (effTag) {
      effTag.textContent = `Effective Equity Exposure: ${Math.round(eff * 100)}%  ·  Total Portfolio: ${fmtGbp0(totalVal)}`;
    }

    const tbody = $("swdaCalcBody");
    if (tbody) {
      tbody.innerHTML = rows.map((r) => {
        const dCls = Math.abs(r.delta) < 10 ? "" : (r.delta > 0 ? "up" : "dn");
        const actTxt = useCur
          ? (Math.abs(r.delta) < 10 ? "Hold" : (r.delta > 0 ? `Buy ${fmtGbp0(r.delta)}` : `Sell ${fmtGbp0(Math.abs(r.delta))}`))
          : fmtGbp0(r.tgtGbp);
        return `
          <tr>
            <td><span class="sym-dot" style="margin-right:7px;background:${r.color}"></span><strong style="color:#fff">${r.id}</strong><div style="font-size:11px;color:var(--tv-dim);margin-left:15px;">${r.role}</div></td>
            <td class="num-r" style="font-weight:700;color:#fff;">${r.tgtPct.toFixed(1)}%</td>
            <td class="num-r">${fmtGbp0(r.tgtGbp)}</td>
            <td class="num-r ${dCls}" style="font-weight:700;">${actTxt}</td>
          </tr>
        `;
      }).join("");
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

    // KPI Cards
    const downDist = a.last > 0 ? ((sig.downTrigger.px / a.last) - 1) * 100 : 0;
    const upDist = a.last > 0 ? ((sig.upTrigger.px / a.last) - 1) * 100 : 0;
    const smaBadge = sig.sma.above
      ? `<span class="up">Above 10W SMA (${fmtPx(sig.sma.value)}, ${fmtPct(sig.sma.dist_pct)})</span>`
      : `<span class="dn">Below 10W SMA (${fmtPx(sig.sma.value)}, ${fmtPct(sig.sma.dist_pct)})</span>`;

    const kpiBox = $("swdaKpis");
    if (kpiBox) {
      kpiBox.innerHTML = `
        <div class="kpi-card">
          <div class="k">Live Monthly Signal (${ui.windowKey === "2500" ? "10Y Roll" : (ui.windowKey === "1250" ? "5Y Roll" : "Max")})</div>
          <div style="margin:5px 0 4px;"><span class="tv-signal ${sig.tone}">${sig.badgeText}</span></div>
          <div class="s">Live Z: <strong class="${zCls(sig.zLive)}">${fmtZ(sig.zLive)}</strong> · Last check ${win.last_check_date || "--"} (${fmtZ(win.last_check_z)})</div>
          <div class="s">${smaBadge}</div>
        </div>
        <div class="kpi-card">
          <div class="k">${sig.downTrigger.label}</div>
          <div class="v">${fmtPx(sig.downTrigger.px)}</div>
          <div class="s">Target ${fmtZ(sig.downTrigger.z)} · ${fmtPct(downDist)} from current ${fmtPx(a.last)}</div>
        </div>
        <div class="kpi-card">
          <div class="k">${sig.upTrigger.label}</div>
          <div class="v">${fmtPx(sig.upTrigger.px)}</div>
          <div class="s">Target ${fmtZ(sig.upTrigger.z)} · ${fmtPct(upDist)} from current ${fmtPx(a.last)}</div>
        </div>
        <div class="kpi-card">
          <div class="k">Anti-Whipsaw Cadence</div>
          <div class="v">${win.switches_per_yr.toFixed(2)} <span style="font-size:12px;color:var(--tv-muted);font-weight:500;">switches / yr</span></div>
          <div class="s">${win.switches_count} trades over ${win.span_yrs}y · Next check ${cd.first_trading_label} (${cd.days_to_first_trading}d)</div>
        </div>
      `;
    }

    const actionBanner = $("swdaActionBanner");
    if (actionBanner) {
      const pendHtml = sig.pendingSwitch
        ? `<div style="margin-top:4px;color:#34d399;font-weight:600;">${sig.pendingSwitch}</div>`
        : "";
      actionBanner.innerHTML = `<strong style="color:#fff;">Action:</strong> ${sig.actionCopy}${pendHtml}`;
    }

    // Historical Monthly Switch Log
    const swBody = $("swdaSwitchBody");
    if (swBody) {
      const list = win.switches || [];
      if (!list.length) {
        swBody.innerHTML = `<tr><td colspan="5" style="color:var(--tv-muted);">No historical state switches recorded in this window.</td></tr>`;
      } else {
        swBody.innerHTML = list.map((s) => {
          const toCls = s.to === "DIP" ? "z-low" : (s.to === "HOT" ? "z-hot" : "z-mid");
          return `
            <tr>
              <td style="color:#fff;">${s.date}</td>
              <td class="num-r z-tag ${zCls(s.z)}">${fmtZ(s.z)}</td>
              <td class="num-r">${fmtPx(s.px)}</td>
              <td><span style="color:var(--tv-dim);">${s.from}</span> → <strong class="${toCls}">${s.to}</strong></td>
              <td class="num-r" style="font-weight:600;color:#fff;">${s.target_eq}%</td>
            </tr>
          `;
        }).join("");
      }
    }

    renderChart(swdaData, preserveZoom);
    renderCalculator(swdaData, sig);
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

    document.querySelectorAll("[data-swda-mode]").forEach((b) => {
      b.addEventListener("click", () => {
        document.querySelectorAll("[data-swda-mode]").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        ui.mode = b.dataset.swdaMode;
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

    document.querySelectorAll("[data-swda-pot]").forEach((b) => {
      b.addEventListener("click", () => {
        if ($("swdaPot")) $("swdaPot").value = b.dataset.swdaPot;
        render(true);
      });
    });

    ["swdaPot", "swdaAddCash", "swdaUseCur", "swdaCur1x", "swdaCur2x", "swdaCurCash"].forEach((id) => {
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
