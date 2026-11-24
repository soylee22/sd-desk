/* SD Desk mathematical engine: full-history Welford OLS, O(n) causal expanding Z, payday rules, and zero-prior algebraic lump-sum solver. */
(function (root) {
  "use strict";

  const EQUITIES = ["CNX1", "CUKX", "IUSU", "IHCU", "SJPA"];
  const ALL_IDS = ["CNX1", "CUKX", "IUSU", "IHCU", "SJPA", "IGL5"];

  function parseIsoDate(s) {
    const parts = String(s).split("-");
    return new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
  }

  function formatIsoDate(d) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function sliceByLookback(series, lookback) {
    if (!series || !series.t || !series.t.length) {
      return { t: [], c: [], v: [] };
    }
    if (!lookback || lookback === "max") {
      return { t: series.t.slice(), c: series.c.slice(), v: series.v.slice() };
    }
    const tradingDays = Number(lookback);
    if (!Number.isFinite(tradingDays) || tradingDays <= 0) {
      return { t: series.t.slice(), c: series.c.slice(), v: series.v.slice() };
    }
    const calDays = Math.round((tradingDays * 365.25) / 252);
    const lastMs = parseIsoDate(series.t[series.t.length - 1]).getTime();
    const cutoffMs = lastMs - calDays * 86400000;
    let startIdx = 0;
    for (let i = 0; i < series.t.length; i++) {
      if (parseIsoDate(series.t[i]).getTime() >= cutoffMs) {
        startIdx = i;
        break;
      }
    }
    if (series.t.length - startIdx < 10) {
      startIdx = Math.max(0, series.t.length - 10);
    }
    return {
      t: series.t.slice(startIdx),
      c: series.c.slice(startIdx),
      v: series.v.slice(startIdx),
    };
  }

  function welfordOLS(values, useLog, barsPerYear) {
    const n = values ? values.length : 0;
    if (n < 2) return null;
    const bpy = barsPerYear || 52.1775;
    const y = new Float64Array(n);
    let meanX = 0;
    let meanY = 0;
    let cxx = 0;
    let cyy = 0;
    let cxy = 0;

    for (let i = 0; i < n; i++) {
      const val = Number(values[i]);
      const yi = useLog ? Math.log(val) : val;
      y[i] = yi;
      const x = i + 1;
      const dx = x - meanX;
      const dy = yi - meanY;
      meanX += dx / x;
      meanY += dy / x;
      const dx2 = x - meanX;
      const dy2 = yi - meanY;
      cxx += dx * dx2;
      cyy += dy * dy2;
      cxy += dx * dy2;
    }

    const slope = cxx !== 0 ? cxy / cxx : 0;
    const startSpace = meanY + slope * (1 - meanX);
    const endSpace = meanY + slope * (n - meanX);
    const sse = Math.max(cyy - slope * cxy, 0);
    const sd = Math.sqrt(sse / (n - 1));
    const r = cxx === 0 || cyy === 0 ? 0 : cxy / Math.sqrt(cxx * cyy);
    const z = sd > 0 ? (y[n - 1] - endSpace) / sd : 0;

    const lastPx = Number(values[n - 1]);
    let trendPct;
    let meanNow;
    let mean1Y;
    if (useLog) {
      trendPct = (Math.exp(slope * bpy) - 1) * 100;
      meanNow = Math.exp(endSpace);
      mean1Y = Math.exp(endSpace + slope * bpy);
    } else {
      meanNow = endSpace;
      mean1Y = endSpace + slope * bpy;
      trendPct = meanNow > 0 ? (mean1Y / meanNow - 1) * 100 : 0;
    }
    const toMean1YPct = lastPx > 0 ? (mean1Y / lastPx - 1) * 100 : 0;
    const distNowPct = lastPx > 0 ? (meanNow / lastPx - 1) * 100 : 0;

    const residuals = new Array(n);
    for (let i = 0; i < n; i++) {
      const fit = startSpace + slope * i;
      residuals[i] = sd > 0 ? (y[i] - fit) / sd : 0;
    }

    return {
      n,
      slope,
      startSpace,
      endSpace,
      sd,
      r,
      z,
      trendPct,
      meanNow,
      mean1Y,
      toMean1YPct,
      distNowPct,
      residuals,
    };
  }

  /* O(n) strictly causal expanding full-history Z-score: at bar i, uses ONLY bars 0..i (zero look-ahead). */
  function causalExpandingZ(values, useLog, minBars) {
    const n = values ? values.length : 0;
    const out = new Array(n).fill(null);
    const warmup = minBars || (n > 1500 ? 252 : 52);
    if (n < 3) return out;

    let meanX = 0;
    let meanY = 0;
    let cxx = 0;
    let cyy = 0;
    let cxy = 0;

    for (let i = 0; i < n; i++) {
      const val = Number(values[i]);
      const yi = useLog ? Math.log(val) : val;
      const x = i + 1;
      const dx = x - meanX;
      const dy = yi - meanY;
      meanX += dx / x;
      meanY += dy / x;
      const dx2 = x - meanX;
      const dy2 = yi - meanY;
      cxx += dx * dx2;
      cyy += dy * dy2;
      cxy += dx * dy2;

      if (x >= warmup) {
        const slope = cxx !== 0 ? cxy / cxx : 0;
        const endSpace = meanY + slope * (x - meanX);
        const sse = Math.max(cyy - slope * cxy, 0);
        const sd = Math.sqrt(sse / (x - 1));
        out[i] = sd > 0 ? (yi - endSpace) / sd : 0;
      }
    }
    return out;
  }

  function computeCountdown(nowDate) {
    const now = nowDate ? new Date(nowDate.getTime()) : new Date();
    const ref = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const nextMonth = ref.getUTCMonth() === 11
      ? new Date(Date.UTC(ref.getUTCFullYear() + 1, 0, 1))
      : new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + 1, 1));

    const firstTr = new Date(nextMonth.getTime());
    while (firstTr.getUTCDay() === 0 || firstTr.getUTCDay() === 6) {
      firstTr.setUTCDate(firstTr.getUTCDate() + 1);
    }
    if (firstTr.getUTCMonth() === 0 && firstTr.getUTCDate() === 1) {
      firstTr.setUTCDate(firstTr.getUTCDate() + 1);
      while (firstTr.getUTCDay() === 0 || firstTr.getUTCDay() === 6) {
        firstTr.setUTCDate(firstTr.getUTCDate() + 1);
      }
    }

    const daysCal = Math.round((nextMonth.getTime() - ref.getTime()) / 86400000);
    const daysTr = Math.round((firstTr.getTime() - ref.getTime()) / 86400000);
    const wdNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const moNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const label = `${wdNames[firstTr.getUTCDay()]} ${firstTr.getUTCDate()} ${moNames[firstTr.getUTCMonth()]} ${firstTr.getUTCFullYear()}`;
    return {
      today: formatIsoDate(ref),
      first_calendar_day: formatIsoDate(nextMonth),
      first_trading_day: formatIsoDate(firstTr),
      first_trading_label: label,
      days_to_first_cal: daysCal,
      days_to_first_trading: daysTr,
    };
  }

  function computeRecommendation(statsById, gateZ) {
    const gate = gateZ == null ? 1.5 : gateZ;
    const ranked = EQUITIES.slice().sort((a, b) => statsById[a].z - statsById[b].z);
    const bestId = ranked[0];
    const bestZ = statsById[bestId].z;
    const zStr = `${bestZ >= 0 ? "+" : ""}${bestZ.toFixed(2)} SD`;

    let action;
    let tone;
    let headline;
    if (bestZ <= 0.0) {
      action = `BUY ${bestId} + SWEEP IGL5`;
      tone = "deploy";
      headline = `${bestId} sits at ${zStr} (at or below Mean). Deploy 100% of this month's contribution and sweep 100% of parked IGL5 into ${bestId}.`;
    } else if (bestZ < gate) {
      action = `BUY ${bestId}`;
      tone = "normal";
      headline = `${bestId} is the lowest equity at ${zStr} (below +${gate.toFixed(1)} SD gate). Deploy 100% of new monthly cash into ${bestId} and keep prior IGL5 parked.`;
    } else {
      action = "PARK IN IGL5";
      tone = "park";
      headline = `All five equity sleeves sit at or above +${gate.toFixed(1)} SD (lowest is ${bestId} at ${zStr}). Park 100% in IGL5 until one resets to 0.0 SD.`;
    }

    return {
      action,
      tone,
      pick: bestZ < gate ? bestId : "IGL5",
      lowest_equity: bestId,
      lowest_z: bestZ,
      gate_z: gate,
      ranked_equities: ranked.map((id) => ({ id, z: statsById[id].z, r: statsById[id].r })),
      headline,
    };
  }

  function priceToGbp(price, currency) {
    if (!Number.isFinite(price) || price <= 0) return 0;
    return String(currency || "GBP").toUpperCase() === "GBX" ? price / 100 : price;
  }

  function waterFillBuy(lumpSum, targetWeights, existing) {
    const buys = {};
    ALL_IDS.forEach((id) => { buys[id] = 0; });
    if (!(lumpSum > 0)) return buys;

    let active = ALL_IDS.filter((id) => (targetWeights[id] || 0) > 1e-12);
    if (!active.length) return buys;

    for (let iter = 0; iter < ALL_IDS.length + 1; iter++) {
      let sumW = 0;
      let sumEx = 0;
      active.forEach((id) => {
        sumW += targetWeights[id];
        sumEx += Math.max(0, Number(existing[id]) || 0);
      });
      const pool = sumEx + lumpSum;
      let anyNeg = false;
      const nextActive = [];
      active.forEach((id) => {
        const desired = pool * (targetWeights[id] / sumW);
        const need = desired - Math.max(0, Number(existing[id]) || 0);
        if (need < -1e-9) anyNeg = true;
        else nextActive.push(id);
      });
      if (!anyNeg) {
        active.forEach((id) => {
          const desired = pool * (targetWeights[id] / sumW);
          buys[id] = Math.max(0, desired - Math.max(0, Number(existing[id]) || 0));
        });
        break;
      }
      if (!nextActive.length) {
        let twSum = 0;
        ALL_IDS.forEach((id) => { twSum += targetWeights[id] || 0; });
        ALL_IDS.forEach((id) => {
          buys[id] = twSum > 0 ? lumpSum * ((targetWeights[id] || 0) / twSum) : 0;
        });
        break;
      }
      active = nextActive;
    }

    const sumB = ALL_IDS.reduce((acc, id) => acc + buys[id], 0);
    if (sumB > 0 && Math.abs(sumB - lumpSum) > 1e-9) {
      const k = lumpSum / sumB;
      ALL_IDS.forEach((id) => { buys[id] *= k; });
    }
    return buys;
  }

  /* Pure zero-prior algebraic lump-sum solver: NO hardcoded country weights.
     All weights are derived strictly from live SD positions (z_i) or channel edge. */
  function solveLumpSum(opts) {
    const lumpSum = Math.max(0, Number(opts.lumpSum) || 0);
    const model = opts.model || "exp"; // "exp" | "headroom" | "reversion"
    const beta = Math.max(0, Number(opts.beta != null ? opts.beta : 0.65));
    const bondValve = opts.bondValve || "per_asset";
    const useExisting = Boolean(opts.useExisting);
    const zById = opts.zById || {};
    const toMeanById = opts.toMeanById || {};
    const pricesGbpById = opts.pricesGbpById || {};

    // Pure symmetric scores u_i derived strictly from SD geometry (zero arbitrary country prior)
    const u = {};
    let sumU = 0;
    let formulaText = "";

    if (model === "headroom") {
      // Pure channel headroom below +2.0 SD upper channel edge, raised to power beta
      const capZ = 2.0;
      const p = Math.max(0.25, beta);
      EQUITIES.forEach((id) => {
        const zi = Number(zById[id]) || 0;
        const h = Math.max(0, capZ - zi);
        u[id] = Math.pow(h, p);
        sumU += u[id];
      });
      formulaText = `u_i = max(0, 2.0 - z_i)^${p.toFixed(2)}  (zero default weights; pure channel headroom)`;
    } else if (model === "reversion") {
      // Pure 1Y mean-reversion upside implied by each ETF's own full-history channel
      const p = Math.max(0.25, beta);
      EQUITIES.forEach((id) => {
        const tm = Math.max(0, Number(toMeanById[id]) || 0);
        u[id] = Math.pow(tm, p);
        sumU += u[id];
      });
      formulaText = `u_i = max(0, ToMean1Y_i)^${p.toFixed(2)}  (zero default weights; pure channel pull)`;
    } else {
      // Pure symmetric Boltzmann / exponential softmax: u_i = exp(-beta * z_i)
      EQUITIES.forEach((id) => {
        const zi = Number(zById[id]) || 0;
        u[id] = Math.exp(-beta * zi);
        sumU += u[id];
      });
      formulaText = `u_i = exp(-${beta.toFixed(2)} * z_i)  (zero default weights; identical Z => 1.00x equal split)`;
    }

    const targetW = {};
    ALL_IDS.forEach((id) => { targetW[id] = 0; });
    if (sumU <= 1e-12) {
      targetW.IGL5 = 1;
    } else if (bondValve === "all_gate") {
      const allHot = EQUITIES.every((id) => (Number(zById[id]) || 0) >= 1.5);
      if (allHot) {
        targetW.IGL5 = 1;
      } else {
        EQUITIES.forEach((id) => { targetW[id] = u[id] / sumU; });
      }
    } else if (bondValve === "per_asset") {
      let bondShare = 0;
      EQUITIES.forEach((id) => {
        const baseShare = u[id] / sumU;
        const zi = Number(zById[id]) || 0;
        let keep = 1;
        if (zi > 1.5) {
          keep = Math.max(0, Math.min(1, (2.0 - zi) / 0.5));
        }
        targetW[id] = baseShare * keep;
        bondShare += baseShare * (1 - keep);
      });
      targetW.IGL5 = bondShare;
    } else {
      EQUITIES.forEach((id) => { targetW[id] = u[id] / sumU; });
    }

    // Relative multipliers normalized so the smallest positive equity target is 1.00x
    const positiveEq = EQUITIES.map((id) => targetW[id]).filter((v) => v > 1e-9);
    const minPos = positiveEq.length ? Math.min.apply(null, positiveEq) : 1;
    const relMult = {};
    ALL_IDS.forEach((id) => {
      relMult[id] = targetW[id] > 1e-9 && minPos > 0 ? targetW[id] / minPos : 0;
    });

    const existing = {};
    ALL_IDS.forEach((id) => {
      existing[id] = useExisting ? Math.max(0, Number((opts.existingById || {})[id]) || 0) : 0;
    });

    let buys;
    if (useExisting) {
      buys = waterFillBuy(lumpSum, targetW, existing);
    } else {
      buys = {};
      ALL_IDS.forEach((id) => { buys[id] = lumpSum * targetW[id]; });
    }

    const totalExisting = ALL_IDS.reduce((a, id) => a + existing[id], 0);
    const totalAfter = totalExisting + lumpSum;

    const rows = ALL_IDS.map((id) => {
      const pxGbp = Number(pricesGbpById[id]) || 0;
      const buyGbp = buys[id] || 0;
      const postVal = existing[id] + buyGbp;
      return {
        id,
        z: Number(zById[id]) || 0,
        u: id === "IGL5" ? 0 : u[id],
        relMult: relMult[id],
        targetPct: targetW[id] * 100,
        buyGbp,
        estShares: pxGbp > 0 ? buyGbp / pxGbp : 0,
        existingGbp: existing[id],
        postGbp: postVal,
        postPct: totalAfter > 0 ? (postVal / totalAfter) * 100 : 0,
      };
    });

    return {
      lumpSum,
      model,
      beta,
      bondValve,
      useExisting,
      formulaText,
      totalExisting,
      totalAfter,
      rows,
    };
  }

  const api = {
    EQUITIES,
    ALL_IDS,
    parseIsoDate,
    sliceByLookback,
    welfordOLS,
    causalExpandingZ,
    computeCountdown,
    computeRecommendation,
    priceToGbp,
    waterFillBuy,
    solveLumpSum,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.SDMath = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
