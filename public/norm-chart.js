/* SD Desk NormalisedChart: full TradingView-grade zoom, pan, auto-Y, range presets, and series spotlight. */
(function (root) {
  "use strict";

  const C = root.SDCharts;

  class NormalisedChart {
    constructor(canvas) {
      this.canvas = canvas;
      this.payload = null;
      this.viewStart = 0;
      this.viewEnd = 0;
      this.autoY = true;
      this.yMin = -4.2;
      this.yMax = 2.6;
      this.highlightId = null;
      this.hover = null;
      this.dragMode = null; // "pan" | "yscale"
      this.dragStart = null;
      this._bindEvents();
    }

    _bindEvents() {
      const c = this.canvas;
      c.addEventListener("mousemove", (e) => {
        const r = c.getBoundingClientRect();
        const x = e.clientX - r.left;
        const y = e.clientY - r.top;
        const plotW = Math.max(40, r.width - 80);
        const plotH = Math.max(40, r.height - 46);

        if (this.dragMode === "pan" && this.payload && this.dragStart) {
          const spanX = this.dragStart.vEnd - this.dragStart.vStart;
          const dxBars = -((x - this.dragStart.x) / plotW) * spanX;
          this._setViewX(this.dragStart.vStart + dxBars, this.dragStart.vEnd + dxBars);
          if (!this.autoY) {
            const spanY = this.dragStart.yMax - this.dragStart.yMin;
            const dyZ = ((y - this.dragStart.y) / plotH) * spanY;
            this.yMin = this.dragStart.yMin + dyZ;
            this.yMax = this.dragStart.yMax + dyZ;
          }
        } else if (this.dragMode === "yscale" && this.dragStart) {
          this.autoY = false;
          const factor = Math.exp((y - this.dragStart.y) * 0.008);
          const mid = (this.dragStart.yMin + this.dragStart.yMax) / 2;
          const half = Math.max(0.4, Math.min(8, ((this.dragStart.yMax - this.dragStart.yMin) / 2) * factor));
          this.yMin = mid - half;
          this.yMax = mid + half;
        }
        this.hover = { x, y };
        c.style.cursor = x > r.width - 74 ? "ns-resize" : (this.dragMode ? "grabbing" : "crosshair");
        this.render();
      });

      c.addEventListener("mouseleave", () => {
        this.hover = null;
        this.dragMode = null;
        this.render();
      });

      c.addEventListener("mousedown", (e) => {
        if (!this.payload) return;
        const r = c.getBoundingClientRect();
        const x = e.clientX - r.left;
        const y = e.clientY - r.top;
        this.dragMode = x > r.width - 74 ? "yscale" : "pan";
        this.dragStart = { x, y, vStart: this.viewStart, vEnd: this.viewEnd, yMin: this.yMin, yMax: this.yMax };
      });

      window.addEventListener("mouseup", () => { this.dragMode = null; });

      c.addEventListener("wheel", (e) => {
        if (!this.payload) return;
        e.preventDefault();
        const r = c.getBoundingClientRect();
        const plotW = Math.max(40, r.width - 80);
        const frac = Math.max(0, Math.min(1, (e.clientX - r.left - 8) / plotW));
        const n = this.payload.dates.length;
        const span = this.viewEnd - this.viewStart;
        const factor = e.deltaY > 0 ? 1.15 : 0.87;
        const newSpan = Math.max(18, Math.min(n, span * factor));
        const anchor = this.viewStart + frac * span;
        this._setViewX(anchor - frac * newSpan, anchor + (1 - frac) * newSpan);
        this.render();
      }, { passive: false });

      c.addEventListener("dblclick", () => this.resetZoom());
    }

    _setViewX(s, e) {
      const n = this.payload ? this.payload.dates.length : 100;
      const span = Math.max(18, Math.min(n, e - s));
      let ns = s;
      let ne = s + span;
      if (ns < 0) { ns = 0; ne = span; }
      if (ne > n - 1) { ne = n - 1; ns = Math.max(0, ne - span); }
      this.viewStart = ns;
      this.viewEnd = ne;
    }

    setHighlight(id) {
      this.highlightId = id || null;
      this.render();
    }

    setAutoY(flag) {
      this.autoY = Boolean(flag);
      this.render();
    }

    setRangePreset(code) {
      if (!this.payload || !this.payload.dates.length) return;
      const dates = this.payload.dates;
      const n = dates.length;
      if (code === "ALL") {
        this.resetZoom();
        return;
      }
      const lastMs = window.SDMath.parseIsoDate(dates[n - 1]).getTime();
      let cutoffMs = 0;
      if (code === "YTD") {
        cutoffMs = Date.UTC(Number(dates[n - 1].slice(0, 4)), 0, 1);
      } else {
        const daysMap = { "1M": 31, "3M": 92, "6M": 183, "1Y": 366, "3Y": 1096, "5Y": 1827, "10Y": 3653 };
        cutoffMs = lastMs - (daysMap[code] || 36500) * 86400000;
      }
      let idx = 0;
      for (let i = 0; i < n; i++) {
        if (window.SDMath.parseIsoDate(dates[i]).getTime() >= cutoffMs) { idx = i; break; }
      }
      this._setViewX(idx, n - 1);
      this.render();
    }

    resetZoom(redraw) {
      if (!this.payload) return;
      this.viewStart = 0;
      this.viewEnd = Math.max(1, this.payload.dates.length - 1);
      this.autoY = true;
      if (redraw !== false) this.render();
    }

    setData(payload, preserveZoom) {
      this.payload = payload;
      if (!preserveZoom || this.viewEnd <= this.viewStart || this.viewEnd > payload.dates.length - 1) {
        this.resetZoom(false);
      } else {
        this._setViewX(this.viewStart, this.viewEnd);
      }
      this.render();
    }

    render() {
      const { ctx, w, h } = C.setupCanvas(this.canvas);
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, w, h);
      const p = this.payload;
      if (!p || !p.dates || !p.dates.length) return;

      const padL = 8;
      const padR = 74;
      const padT = 22;
      const padB = 24;
      const plotW = Math.max(60, w - padL - padR);
      const plotH = Math.max(60, h - padT - padB);

      const n = p.dates.length;
      const i0 = Math.max(0, Math.floor(this.viewStart));
      const i1 = Math.min(n - 1, Math.ceil(this.viewEnd));
      const span = Math.max(1, this.viewEnd - this.viewStart);

      // Compute Auto-Y from visible data window (always includes 0.0 and +1.5 gate for context)
      if (this.autoY) {
        let lo = -1.8;
        let hi = 1.9;
        p.series.forEach((s) => {
          if (!s.visible) return;
          for (let i = i0; i <= i1; i++) {
            const v = s.values[i];
            if (v != null && Number.isFinite(v)) {
              if (v < lo) lo = v;
              if (v > hi) hi = v;
            }
          }
        });
        const pad = Math.max(0.35, (hi - lo) * 0.1);
        this.yMin = Math.max(-5.0, lo - pad);
        this.yMax = Math.min(4.5, hi + pad);
      }

      const xOf = (i) => padL + ((i - this.viewStart) / span) * plotW;
      const yOf = (z) => padT + ((this.yMax - z) / (this.yMax - this.yMin)) * plotH;
      const zOfY = (py) => this.yMax - ((py - padT) / plotH) * (this.yMax - this.yMin);

      // Clip inside plot
      ctx.save();
      ctx.beginPath();
      ctx.rect(padL, padT, plotW, plotH);
      ctx.clip();

      const shade = (hi, lo, col) => {
        const y1 = yOf(hi);
        const y2 = yOf(lo);
        ctx.fillStyle = col;
        ctx.fillRect(padL, y1, plotW, y2 - y1);
      };
      shade(2.0, 1.0, "rgba(41, 98, 255, 0.055)");
      shade(1.0, 0.0, "rgba(0, 180, 216, 0.07)");
      shade(0.0, -3.0, "rgba(242, 54, 69, 0.05)");
      shade(-3.0, -4.0, "rgba(204, 47, 60, 0.04)");

      // Vertical time gridlines (adaptive monthly/yearly spacing)
      let lastLblX = -999;
      const showMonths = span < 120;
      let prevKey = "";
      for (let i = i0; i <= i1; i++) {
        const key = showMonths ? p.dates[i].slice(0, 7) : p.dates[i].slice(0, 4);
        if (key !== prevKey) {
          prevKey = key;
          const x = xOf(i);
          if (x > padL + 14 && x < padL + plotW - 20 && x - lastLblX >= 54) {
            lastLblX = x;
            ctx.strokeStyle = "#121212";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x, padT);
            ctx.lineTo(x, padT + plotH);
            ctx.stroke();
          }
        }
      }

      // Horizontal reference lines
      const refs = [
        { z: 2.0, col: "rgba(91,156,246,0.5)", dash: [2, 4], lbl: "+2.0 SD" },
        { z: 1.5, col: "rgba(245,158,11,0.75)", dash: [6, 4], lbl: "+1.5 Gate" },
        { z: 1.0, col: "rgba(0,180,216,0.6)", dash: [5, 4], lbl: "+1.0 SD" },
        { z: 0.0, col: "#f59e0b", dash: [], lbl: "0.0 Mean" },
        { z: -1.0, col: "rgba(242,54,69,0.35)", dash: [3, 4], lbl: "-1.0 SD" },
        { z: -2.0, col: "rgba(242,54,69,0.45)", dash: [3, 4], lbl: "-2.0 SD" },
        { z: -3.0, col: "rgba(242,54,69,0.65)", dash: [5, 4], lbl: "-3.0 SD" },
        { z: -4.0, col: "rgba(204,47,60,0.5)", dash: [2, 4], lbl: "-4.0 SD" },
      ];
      refs.forEach((rl) => {
        const y = yOf(rl.z);
        if (y < padT - 2 || y > padT + plotH + 2) return;
        ctx.save();
        ctx.strokeStyle = rl.col;
        ctx.lineWidth = rl.z === 0 ? 1.8 : 1;
        ctx.setLineDash(rl.dash);
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(padL + plotW, y);
        ctx.stroke();
        ctx.restore();
      });

      // Draw each enabled series (draw non-highlighted first, highlighted on top)
      const ordered = p.series.slice().sort((a, b) => (a.id === this.highlightId ? 1 : b.id === this.highlightId ? -1 : 0));
      const endTags = [];
      ordered.forEach((s) => {
        if (!s.visible) return;
        const dimmed = this.highlightId && this.highlightId !== s.id;
        ctx.save();
        ctx.globalAlpha = dimmed ? 0.18 : 1.0;
        ctx.strokeStyle = s.color;
        ctx.lineWidth = this.highlightId === s.id ? 2.6 : (s.id === "IGL5" ? 1.5 : 1.9);
        ctx.lineJoin = "round";
        ctx.beginPath();
        let started = false;
        let lastVal = null;
        for (let i = i0; i <= i1; i++) {
          const v = s.values[i];
          if (v == null || !Number.isFinite(v)) { started = false; continue; }
          const px = xOf(i);
          const py = yOf(v);
          if (!started) { ctx.moveTo(px, py); started = true; }
          else ctx.lineTo(px, py);
          lastVal = v;
        }
        ctx.stroke();
        ctx.restore();
        if (lastVal != null) {
          endTags.push({ id: s.id, color: s.color, z: lastVal, y: Math.max(padT + 10, Math.min(padT + plotH - 10, yOf(lastVal))) });
        }
      });

      // Hover crosshair inside plot
      const inPlot = this.hover && this.hover.x >= padL && this.hover.x <= padL + plotW && this.hover.y >= padT && this.hover.y <= padT + plotH;
      let hoverIdx = null;
      if (inPlot) {
        hoverIdx = Math.max(i0, Math.min(i1, Math.round(this.viewStart + ((this.hover.x - padL) / plotW) * span)));
        const hx = xOf(hoverIdx);
        ctx.save();
        ctx.strokeStyle = "rgba(140, 140, 140, 0.45)";
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(hx, padT);
        ctx.lineTo(hx, padT + plotH);
        ctx.moveTo(padL, this.hover.y);
        ctx.lineTo(padL + plotW, this.hover.y);
        ctx.stroke();
        ctx.restore();

        p.series.forEach((s) => {
          if (!s.visible) return;
          const v = s.values[hoverIdx];
          if (v != null && Number.isFinite(v)) {
            ctx.fillStyle = s.color;
            ctx.beginPath();
            ctx.arc(hx, yOf(v), 3.5, 0, Math.PI * 2);
            ctx.fill();
          }
        });
      }

      ctx.restore(); // end plot clip

      // Axes borders
      ctx.strokeStyle = "#222222";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL + plotW, padT);
      ctx.lineTo(padL + plotW, padT + plotH);
      ctx.moveTo(padL, padT + plotH);
      ctx.lineTo(padL + plotW, padT + plotH);
      ctx.stroke();

      // Right axis SD labels
      ctx.font = `11px ${C.TV_FONT}`;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      refs.forEach((rl) => {
        const y = yOf(rl.z);
        if (y < padT + 6 || y > padT + plotH - 6) return;
        ctx.fillStyle = rl.z === 0 ? "#f59e0b" : rl.z === 1.5 ? "#fbbf24" : "#8c8c8c";
        ctx.fillText(rl.lbl, padL + plotW + 6, y);
      });

      // Bottom date labels
      lastLblX = -999;
      prevKey = "";
      ctx.fillStyle = "#8c8c8c";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      for (let i = i0; i <= i1; i++) {
        const key = showMonths ? p.dates[i].slice(0, 7) : p.dates[i].slice(0, 4);
        if (key !== prevKey) {
          prevKey = key;
          const x = xOf(i);
          if (x > padL + 18 && x < padL + plotW - 22 && x - lastLblX >= 54) {
            lastLblX = x;
            ctx.fillText(key, x, padT + plotH + 6);
          }
        }
      }

      // De-overlapped right-edge live Z pills (clickable/readable)
      endTags.sort((a, b) => a.y - b.y);
      for (let i = 1; i < endTags.length; i++) {
        if (endTags[i].y - endTags[i - 1].y < 19) endTags[i].y = endTags[i - 1].y + 19;
      }
      ctx.font = `600 10.5px ${C.TV_FONT}`;
      ctx.textBaseline = "middle";
      endTags.forEach((tg) => {
        const lbl = `${tg.id} ${tg.z >= 0 ? "+" : ""}${tg.z.toFixed(2)}`;
        const tw = ctx.measureText(lbl).width + 10;
        const tx = padL + plotW - tw - 6;
        ctx.fillStyle = "rgba(0, 0, 0, 0.88)";
        ctx.strokeStyle = tg.color;
        ctx.lineWidth = 1;
        C.roundRect(ctx, tx, tg.y - 8, tw, 16, 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = tg.color;
        ctx.textAlign = "left";
        ctx.fillText(lbl, tx + 5, tg.y);
      });

      // TradingView dark crosshair axis pills + top-left live readout
      if (inPlot && hoverIdx !== null) {
        const zCur = zOfY(this.hover.y);
        ctx.fillStyle = "#303030";
        C.roundRect(ctx, padL + plotW + 1, this.hover.y - 9, padR - 3, 18, 2);
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "left";
        ctx.fillText(`${zCur >= 0 ? "+" : ""}${zCur.toFixed(2)} SD`, padL + plotW + 6, this.hover.y);

        const hx = xOf(hoverIdx);
        const dtLbl = p.dates[hoverIdx];
        const dw = ctx.measureText(dtLbl).width + 12;
        const dx = Math.max(padL, Math.min(padL + plotW - dw, hx - dw / 2));
        ctx.fillStyle = "#303030";
        C.roundRect(ctx, dx, padT + plotH + 2, dw, 18, 2);
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "center";
        ctx.fillText(dtLbl, dx + dw / 2, padT + plotH + 11);

        const parts = [dtLbl];
        p.series.forEach((s) => {
          if (!s.visible) return;
          const v = s.values[hoverIdx];
          if (v != null && Number.isFinite(v)) parts.push(`${s.id} ${v >= 0 ? "+" : ""}${v.toFixed(2)}`);
        });
        const txt = parts.join("   ");
        const tw = ctx.measureText(txt).width + 14;
        ctx.fillStyle = "rgba(19, 19, 19, 0.92)";
        ctx.strokeStyle = "#303030";
        C.roundRect(ctx, padL + 8, padT + 4, tw, 20, 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = "#dbdbdb";
        ctx.textAlign = "left";
        ctx.fillText(txt, padL + 15, padT + 14);
      }
    }
  }

  root.SDCharts.NormalisedChart = NormalisedChart;
})(window);
