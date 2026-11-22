/* SD Desk QuadrantChart: TradingView OLED-black HiDPI canvas engine with full-history SD channel & viewport zoom/pan. */
(function (root) {
  "use strict";

  const TV_FONT = '-apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif';

  function fmtPx(v, currency) {
    if (!Number.isFinite(v)) return "--";
    if (String(currency).toUpperCase() === "GBP" || Math.abs(v) < 100) return v.toFixed(2);
    return Math.round(v).toLocaleString("en-GB");
  }

  function niceLogTicks(minV, maxV, count) {
    const out = [];
    if (!(minV > 0 && maxV > minV)) return out;
    const steps = count || 8;
    const lMin = Math.log(minV);
    const lMax = Math.log(maxV);
    for (let i = 0; i <= steps; i++) {
      const raw = Math.exp(lMin + ((lMax - lMin) * i) / steps);
      const mag = Math.pow(10, Math.floor(Math.log10(raw)) - 1);
      const rounded = Math.round(raw / mag) * mag;
      if (!out.length || Math.abs(rounded - out[out.length - 1]) > mag * 0.5) out.push(rounded);
    }
    return out;
  }

  function niceLinTicks(minV, maxV, count) {
    const out = [];
    if (!(maxV > minV)) return out;
    const span = maxV - minV;
    const rough = span / (count || 7);
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    const norm = rough / mag;
    const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    const start = Math.ceil(minV / step) * step;
    for (let v = start; v <= maxV; v += step) out.push(v);
    return out;
  }

  function setupCanvas(canvas) {
    const rect = canvas.parentElement.getBoundingClientRect();
    const w = Math.max(100, Math.floor(rect.width));
    const h = Math.max(100, Math.floor(rect.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  class QuadrantChart {
    constructor(canvas, assetId) {
      this.canvas = canvas;
      this.assetId = assetId;
      this.payload = null;
      this.viewStart = 0;
      this.viewEnd = 0;
      this.hover = null;
      this.dragging = false;
      this.dragStartX = 0;
      this.dragStartView = [0, 0];
      this._bindEvents();
    }

    _bindEvents() {
      const c = this.canvas;
      c.addEventListener("mousemove", (e) => {
        const r = c.getBoundingClientRect();
        const x = e.clientX - r.left;
        const y = e.clientY - r.top;
        if (this.dragging && this.payload) {
          const plotW = Math.max(1, r.width - 70);
          const span = this.dragStartView[1] - this.dragStartView[0];
          const delta = -((x - this.dragStartX) / plotW) * span;
          this._setView(this.dragStartView[0] + delta, this.dragStartView[1] + delta);
        }
        this.hover = { x, y };
        this.render();
      });
      c.addEventListener("mouseleave", () => {
        this.hover = null;
        this.dragging = false;
        this.render();
      });
      c.addEventListener("mousedown", (e) => {
        if (!this.payload) return;
        this.dragging = true;
        this.dragStartX = e.clientX - c.getBoundingClientRect().left;
        this.dragStartView = [this.viewStart, this.viewEnd];
      });
      window.addEventListener("mouseup", () => { this.dragging = false; });
      c.addEventListener("wheel", (e) => {
        if (!this.payload) return;
        e.preventDefault();
        const r = c.getBoundingClientRect();
        const plotW = Math.max(1, r.width - 70);
        const frac = Math.max(0, Math.min(1, (e.clientX - r.left - 6) / plotW));
        const span = this.viewEnd - this.viewStart;
        const factor = e.deltaY > 0 ? 1.14 : 0.88;
        const newSpan = Math.max(20, Math.min(this.maxTotalBars(), span * factor));
        const anchor = this.viewStart + frac * span;
        this._setView(anchor - frac * newSpan, anchor + (1 - frac) * newSpan);
        this.render();
      }, { passive: false });
      c.addEventListener("dblclick", () => this.resetZoom());
    }

    maxTotalBars() {
      return this.payload ? this.payload.series.t.length + this.payload.futureBars : 100;
    }

    _setView(s, e) {
      const total = this.maxTotalBars();
      const span = Math.max(20, Math.min(total, e - s));
      let ns = s;
      let ne = s + span;
      if (ns < 0) { ns = 0; ne = span; }
      if (ne > total) { ne = total; ns = Math.max(0, total - span); }
      this.viewStart = ns;
      this.viewEnd = ne;
    }

    setRangePreset(code) {
      if (!this.payload) return;
      const t = this.payload.series.t;
      const n = t.length;
      if (!n || code === "ALL") {
        this.resetZoom();
        return;
      }
      const lastMs = window.SDMath.parseIsoDate(t[n - 1]).getTime();
      let cutoffMs = 0;
      if (code === "YTD") {
        const yr = Number(t[n - 1].slice(0, 4));
        cutoffMs = Date.UTC(yr, 0, 1);
      } else {
        const daysMap = { "1M": 31, "3M": 92, "6M": 183, "1Y": 366, "3Y": 1096, "5Y": 1827, "10Y": 3653 };
        const d = daysMap[code] || 36500;
        cutoffMs = lastMs - d * 86400000;
      }
      let idx = 0;
      for (let i = 0; i < n; i++) {
        if (window.SDMath.parseIsoDate(t[i]).getTime() >= cutoffMs) { idx = i; break; }
      }
      const futPad = Math.max(6, Math.round((n - idx) * 0.12));
      this._setView(idx, Math.min(this.maxTotalBars(), n + futPad));
      this.render();
    }

    setData(payload, preserveZoom) {
      this.payload = payload;
      if (!preserveZoom || this.viewEnd <= this.viewStart) this.resetZoom(false);
      else this._setView(this.viewStart, this.viewEnd);
      this.render();
    }

    resetZoom(redraw) {
      if (!this.payload) return;
      this.viewStart = 0;
      this.viewEnd = this.payload.series.t.length + this.payload.futureBars;
      if (redraw !== false) this.render();
    }

    render() {
      const { ctx, w, h } = setupCanvas(this.canvas);
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, w, h);

      const p = this.payload;
      if (!p || !p.stats || !p.series.t.length) return;

      const padL = 6;
      const padR = 64;
      const padT = 30;
      const padB = 22;
      const plotW = Math.max(40, w - padL - padR);
      const plotH = Math.max(40, h - padT - padB);

      const { t, c, v } = p.series;
      const n = t.length;
      const st = p.stats;
      const useLog = p.useLog;
      const lowBands = p.bands === "12" ? [-1, -2] : [-3, -4];

      const vStart = Math.max(0, Math.floor(this.viewStart));
      const vEnd = Math.min(n + p.futureBars, Math.ceil(this.viewEnd));
      const span = Math.max(1, this.viewEnd - this.viewStart);
      const xOf = (idx) => padL + ((idx - this.viewStart) / span) * plotW;

      const valFromSpace = (sp) => (useLog ? Math.exp(sp) : sp);
      const bandVal = (idx, mult) => valFromSpace(st.startSpace + st.slope * idx + mult * st.sd);

      let minV = Infinity;
      let maxV = -Infinity;
      const i0 = Math.max(0, vStart);
      const i1 = Math.min(n - 1, vEnd);
      for (let i = i0; i <= i1; i++) {
        if (c[i] < minV) minV = c[i];
        if (c[i] > maxV) maxV = c[i];
      }
      const chStart = Math.max(0, vStart);
      const chEnd = Math.min(n - 1 + p.futureBars, vEnd);
      [chStart, chEnd].forEach((idx) => {
        const hi = bandVal(idx, 2.0);
        const lo = bandVal(idx, lowBands[1]);
        if (hi > maxV) maxV = hi;
        if (lo < minV && lo > 0) minV = lo;
      });
      if (!Number.isFinite(minV) || !Number.isFinite(maxV) || maxV <= minV) {
        minV = c[n - 1] * 0.5;
        maxV = c[n - 1] * 1.5;
      }
      const yMinSp = useLog ? Math.log(Math.max(1e-6, minV)) : minV;
      const yMaxSp = useLog ? Math.log(Math.max(1e-6, maxV)) : maxV;
      const yPad = (yMaxSp - yMinSp) * 0.06;
      const loSp = yMinSp - yPad;
      const hiSp = yMaxSp + yPad;
      const yOf = (val) => {
        const sp = useLog ? Math.log(Math.max(1e-6, val)) : val;
        return padT + ((hiSp - sp) / (hiSp - loSp)) * plotH;
      };
      const valOfY = (py) => {
        const sp = hiSp - ((py - padT) / plotH) * (hiSp - loSp);
        return useLog ? Math.exp(sp) : sp;
      };

      // Subtle TradingView grid
      const ticks = useLog
        ? niceLogTicks(Math.exp(loSp), Math.exp(hiSp), Math.max(5, Math.floor(plotH / 44)))
        : niceLinTicks(loSp, hiSp, Math.max(5, Math.floor(plotH / 44)));
      ctx.font = `11px ${TV_FONT}`;
      ctx.textBaseline = "middle";
      ticks.forEach((tv) => {
        const y = yOf(tv);
        if (y < padT || y > padT + plotH) return;
        ctx.strokeStyle = "#121212";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(padL + plotW, y);
        ctx.stroke();
        ctx.fillStyle = "#8c8c8c";
        ctx.textAlign = "left";
        ctx.fillText(fmtPx(tv, p.asset.currency), padL + plotW + 6, y);
      });

      const yearsDrawn = new Set();
      let lastYearX = -999;
      for (let i = i0; i <= i1; i++) {
        const yr = t[i].slice(0, 4);
        if (!yearsDrawn.has(yr) && (i === i0 || t[i - 1].slice(0, 4) !== yr)) {
          yearsDrawn.add(yr);
          const x = xOf(i);
          if (x > padL + 16 && x < padL + plotW - 24 && x - lastYearX >= 48) {
            lastYearX = x;
            ctx.strokeStyle = "#121212";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x, padT);
            ctx.lineTo(x, padT + plotH);
            ctx.stroke();
            ctx.fillStyle = "#8c8c8c";
            ctx.textAlign = "center";
            ctx.textBaseline = "top";
            ctx.fillText(yr, x, padT + plotH + 5);
          }
        }
      }

      // Clip plot
      ctx.save();
      ctx.beginPath();
      ctx.rect(padL, padT, plotW, plotH);
      ctx.clip();

      // Volume histogram
      let maxVol = 0;
      for (let i = i0; i <= i1; i++) if (v[i] > maxVol) maxVol = v[i];
      if (maxVol > 0) {
        const volH = plotH * 0.14;
        const barW = Math.max(1, (plotW / span) * 0.7);
        ctx.fillStyle = "rgba(140, 140, 140, 0.16)";
        for (let i = i0; i <= i1; i++) {
          const vh = (v[i] / maxVol) * volH;
          if (vh > 0.5) ctx.fillRect(xOf(i) - barW / 2, padT + plotH - vh, barW, vh);
        }
      }

      // SD channel bands
      const cStart = 0;
      const cEnd = n - 1 + p.futureBars;
      const x0 = xOf(cStart);
      const x1 = xOf(cEnd);

      const fillQuad = (mTop, mBot, color) => {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(x0, yOf(bandVal(cStart, mTop)));
        ctx.lineTo(x1, yOf(bandVal(cEnd, mTop)));
        ctx.lineTo(x1, yOf(bandVal(cEnd, mBot)));
        ctx.lineTo(x0, yOf(bandVal(cStart, mBot)));
        ctx.closePath();
        ctx.fill();
      };
      fillQuad(2, 1, "rgba(41, 98, 255, 0.06)");
      fillQuad(1, 0, "rgba(0, 180, 216, 0.08)");
      fillQuad(0, lowBands[0], "rgba(242, 54, 69, 0.065)");
      fillQuad(lowBands[0], lowBands[1], "rgba(204, 47, 60, 0.045)");

      const drawBand = (mult, color, width, dash) => {
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.setLineDash(dash || []);
        ctx.beginPath();
        ctx.moveTo(x0, yOf(bandVal(cStart, mult)));
        ctx.lineTo(x1, yOf(bandVal(cEnd, mult)));
        ctx.stroke();
        ctx.restore();
      };
      drawBand(2, "rgba(59, 130, 246, 0.55)", 1, [2, 4]);
      drawBand(1, "rgba(0, 180, 216, 0.72)", 1.1, [5, 4]);
      drawBand(0, "#F59E0B", 1.7, []);
      drawBand(lowBands[0], "rgba(242, 54, 69, 0.68)", 1.1, [5, 4]);
      drawBand(lowBands[1], "rgba(204, 47, 60, 0.52)", 1, [2, 4]);

      // Electric blue -> violet TradingView curve
      const grad = ctx.createLinearGradient(xOf(i0), 0, xOf(i1), 0);
      grad.addColorStop(0, "#3b82f6");
      grad.addColorStop(0.55, "#6366f1");
      grad.addColorStop(1, "#8b5cf6");
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.75;
      ctx.lineJoin = "round";
      ctx.beginPath();
      for (let i = i0; i <= i1; i++) {
        const px = xOf(i);
        const py = yOf(c[i]);
        if (i === i0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();

      // Current price line
      const lastPx = c[n - 1];
      const lastY = yOf(lastPx);
      ctx.save();
      ctx.strokeStyle = "rgba(139, 92, 246, 0.42)";
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(padL, lastY);
      ctx.lineTo(padL + plotW, lastY);
      ctx.stroke();
      ctx.restore();

      // Future-margin band labels
      const lblIdx = Math.min(cEnd - 2, n - 1 + Math.round(p.futureBars * 0.16));
      const lblX = Math.max(xOf(n - 1) + 6, Math.min(padL + plotW - 72, xOf(lblIdx)));
      ctx.font = `600 10px ${TV_FONT}`;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      [
        { m: 2, txt: "+2 SD", col: "#5b9cf6" },
        { m: 1, txt: "+1 SD", col: "#22d3ee" },
        { m: 0, txt: `Mean ${st.trendPct >= 0 ? "+" : ""}${st.trendPct.toFixed(1)}%`, col: "#f59e0b" },
        { m: lowBands[0], txt: `${lowBands[0]} SD`, col: "#f7525f" },
        { m: lowBands[1], txt: `${lowBands[1]} SD`, col: "#f23645" },
      ].forEach((bl) => {
        const ly = yOf(bandVal(lblIdx, bl.m));
        if (ly > padT + 10 && ly < padT + plotH - 10) {
          const tw = ctx.measureText(bl.txt).width;
          const cx = Math.min(lblX, padL + plotW - tw - 4);
          ctx.fillStyle = "rgba(0, 0, 0, 0.72)";
          ctx.fillRect(cx - 2, ly - 13, tw + 4, 12);
          ctx.fillStyle = bl.col;
          ctx.fillText(bl.txt, cx, ly - 7);
        }
      });

      // Crosshair inside plot
      let hoverIdx = null;
      const inPlot = this.hover && this.hover.x >= padL && this.hover.x <= padL + plotW && this.hover.y >= padT && this.hover.y <= padT + plotH;
      if (inPlot) {
        const rawIdx = Math.round(this.viewStart + ((this.hover.x - padL) / plotW) * span);
        hoverIdx = Math.max(0, Math.min(n - 1, rawIdx));
        const hx = xOf(hoverIdx);
        ctx.save();
        ctx.strokeStyle = "rgba(140, 140, 140, 0.45)";
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(hx, padT);
        ctx.lineTo(hx, padT + plotH);
        ctx.moveTo(padL, this.hover.y);
        ctx.lineTo(padL + plotW, this.hover.y);
        ctx.stroke();
        ctx.restore();
      }
      ctx.restore();

      // Crisp TV axes borders
      ctx.strokeStyle = "#222222";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL + plotW, padT);
      ctx.lineTo(padL + plotW, padT + plotH);
      ctx.moveTo(padL, padT + plotH);
      ctx.lineTo(padL + plotW, padT + plotH);
      ctx.stroke();

      // Purple right-axis live price pill
      if (lastY >= padT && lastY <= padT + plotH) {
        ctx.fillStyle = "#7c3aed";
        roundRect(ctx, padL + plotW + 1, lastY - 9, padR - 3, 18, 2);
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.font = `600 11px ${TV_FONT}`;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(fmtPx(lastPx, p.asset.currency), padL + plotW + 6, lastY);
      }

      // Authentic TradingView dark #303030 crosshair axis pills on BOTH Y and X axes
      if (inPlot && hoverIdx !== null) {
        const cyVal = valOfY(this.hover.y);
        ctx.fillStyle = "#303030";
        roundRect(ctx, padL + plotW + 1, this.hover.y - 9, padR - 3, 18, 2);
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.font = `600 10.5px ${TV_FONT}`;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(fmtPx(cyVal, p.asset.currency), padL + plotW + 6, this.hover.y);

        const hx = xOf(hoverIdx);
        const dtLbl = t[hoverIdx];
        const dw = ctx.measureText(dtLbl).width + 12;
        const dx = Math.max(padL, Math.min(padL + plotW - dw, hx - dw / 2));
        ctx.fillStyle = "#303030";
        roundRect(ctx, dx, padT + plotH + 2, dw, 18, 2);
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "center";
        ctx.fillText(dtLbl, dx + dw / 2, padT + plotH + 11);

        // Top-left bar readout
        const zAt = st.residuals[hoverIdx];
        const txt = `${dtLbl}  ${fmtPx(c[hoverIdx], p.asset.currency)} ${p.asset.currency}  Z ${zAt >= 0 ? "+" : ""}${zAt.toFixed(2)} SD`;
        ctx.fillStyle = "rgba(19, 19, 19, 0.92)";
        ctx.strokeStyle = "#303030";
        const tw = ctx.measureText(txt).width + 12;
        roundRect(ctx, padL + 6, padT + 4, tw, 19, 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = "#dbdbdb";
        ctx.textAlign = "left";
        ctx.fillText(txt, padL + 12, padT + 13.5);
      }

      // Bottom-left TradingView stats badge
      const lbLabel = p.lookback === "max" ? "Max" : `${p.lookback}D`;
      const scLabel = useLog ? "Log" : "Lin";
      const line1 = `Z = ${st.z >= 0 ? "+" : ""}${st.z.toFixed(2)} SD | R = ${st.r.toFixed(3)} (${st.n} bars, ${lbLabel} ${scLabel})`;
      const line2 = `Trend = ${st.trendPct >= 0 ? "+" : ""}${st.trendPct.toFixed(1)}%/yr | +1Y Mean = ${fmtPx(st.mean1Y, p.asset.currency)} | To Mean = ${st.toMean1YPct >= 0 ? "+" : ""}${st.toMean1YPct.toFixed(1)}%/yr`;
      ctx.font = `500 10.5px ${TV_FONT}`;
      const bw = Math.min(plotW - 14, Math.max(ctx.measureText(line1).width, ctx.measureText(line2).width) + 16);
      const bh = 35;
      const bx = padL + 8;
      const by = padT + plotH - bh - 8;
      ctx.fillStyle = "rgba(19, 23, 34, 0.86)";
      ctx.strokeStyle = "#303030";
      ctx.lineWidth = 1;
      roundRect(ctx, bx, by, bw, bh, 3);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#dbdbdb";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(line1, bx + 8, by + 5);
      ctx.fillStyle = "#a8a8a8";
      ctx.fillText(line2, bx + 8, by + 19);
    }
  }

  root.SDCharts = root.SDCharts || {};
  root.SDCharts.QuadrantChart = QuadrantChart;
  root.SDCharts.fmtPx = fmtPx;
  root.SDCharts.setupCanvas = setupCanvas;
  root.SDCharts.roundRect = roundRect;
  root.SDCharts.TV_FONT = TV_FONT;
})(window);
