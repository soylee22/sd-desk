"""SD Desk data pipeline: fetches LSE GBP history via yfinance and computes exact Welford OLS channels.

All market data comes from public Yahoo Finance (sanctioned, zero scraping of TradingView).
"""
from __future__ import annotations

import json
import math
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import yfinance as yf

ROOT = Path(__file__).resolve().parent
PUBLIC_DATA = ROOT / "public" / "data"
PUBLIC_DATA.mkdir(parents=True, exist_ok=True)

ASSETS = [
    {
        "id": "CSP1",
        "yf": "CSP1.L",
        "min_date": "2010-09-13",
        "name": "iShares Core S&P 500 UCITS ETF",
        "region": "US Large Cap",
        "isin": "IE00B5BMR087",
        "ocf": 0.07,
        "currency": "GBX",
        "role": "equity",
        "color": "#38BDF8",
        "t212_tickers": ["CSP1l_EQ", "CSP1_L_EQ", "VUAGl_EQ", "VUSAl_EQ"],
    },
    {
        "id": "CUKX",
        "yf": "CUKX.L",
        "min_date": "2010-09-13",
        "name": "iShares Core FTSE 100 UCITS ETF",
        "region": "UK Large Cap",
        "isin": "IE00B53HP851",
        "ocf": 0.07,
        "currency": "GBX",
        "role": "equity",
        "color": "#34D399",
        "t212_tickers": ["CUKXl_EQ", "CUKX_L_EQ", "VUKGl_EQ", "ISFl_EQ"],
    },
    {
        "id": "SJPA",
        "yf": "SJPA.L",
        "min_date": "2009-12-28",
        "name": "iShares Core MSCI Japan IMI UCITS ETF",
        "region": "Japan",
        "isin": "IE00B4L5YX21",
        "ocf": 0.12,
        "currency": "GBX",
        "role": "equity",
        "color": "#C084FC",
        "t212_tickers": ["SJPAl_EQ", "SJPA_L_EQ", "VJPBl_EQ"],
    },
    {
        "id": "CSWG",
        "yf": "CSWG.L",
        "min_date": "2022-10-03",
        "splice_proxy_yf": "EWL",
        "splice_fx_yf": "GBP=X",
        "splice_min_date": "2010-09-13",
        "name": "Amundi MSCI Switzerland UCITS ETF (Acc)",
        "region": "Switzerland",
        "isin": "LU1681044993",
        "ocf": 0.25,
        "currency": "GBX",
        "role": "equity",
        "color": "#F59E0B",
        "t212_tickers": ["CSWGl_EQ", "CSWG_L_EQ", "CSWUl_EQ", "18MNd_EQ", "540Jd_EQ"],
    },
    {
        "id": "IGL5",
        "yf": "IGL5.L",
        "splice_yf": "IGLS.L",
        "name": "iShares UK Gilts 0-5yr UCITS ETF (Acc)",
        "region": "UK Gilts 0-5y",
        "isin": "IE000RCMNFR9",
        "ocf": 0.07,
        "currency": "GBP",
        "role": "bond",
        "color": "#FB7185",
        "t212_tickers": ["IGL5l_EQ", "IGL5_L_EQ", "IGLSl_EQ", "CSH2l_EQ"],
    },
]


def _extract_ohlcv(raw: pd.DataFrame) -> pd.DataFrame:
    if raw is None or raw.empty:
        return pd.DataFrame(columns=["close", "volume"])
    if isinstance(raw.columns, pd.MultiIndex):
        close = raw["Close"].iloc[:, 0]
        vol = raw["Volume"].iloc[:, 0] if "Volume" in raw.columns.get_level_values(0) else pd.Series(0, index=close.index)
    else:
        close = raw["Close"]
        vol = raw["Volume"] if "Volume" in raw.columns else pd.Series(0, index=close.index)
    df = pd.DataFrame({"close": pd.to_numeric(close, errors="coerce"), "volume": pd.to_numeric(vol, errors="coerce").fillna(0.0)})
    df.index = pd.to_datetime(df.index).tz_localize(None)
    df = df[df["close"].notna() & (df["close"] > 0)].sort_index()
    df = df[~df.index.duplicated(keep="last")]
    return df


def _clean_spikes(df: pd.DataFrame) -> pd.DataFrame:
    """Drop isolated Yahoo GBX/GBP 100x or single-bar currency flip glitches that immediately revert."""
    if len(df) < 3:
        return df
    c = df["close"].values
    keep = np.ones(len(df), dtype=bool)
    for i in range(1, len(df) - 1):
        prev_c, cur_c, next_c = c[i - 1], c[i], c[i + 1]
        if prev_c > 0 and next_c > 0:
            r_in = cur_c / prev_c
            r_out = next_c / cur_c
            r_span = next_c / prev_c
            # Single-bar >22% currency-flip spike that immediately reverts next bar
            if ((r_in > 1.22 and r_out < 0.82) or (r_in < 0.82 and r_out > 1.22)) and (0.88 < r_span < 1.14):
                keep[i] = False
    return df.iloc[keep]


def _fetch_bars(symbol: str, interval: str, min_date: str | None = None) -> pd.DataFrame:
    raw = yf.download(symbol, period="max", interval=interval, auto_adjust=True, progress=False)
    df = _extract_ohlcv(raw)
    if min_date and not df.empty:
        df = df.loc[df.index >= pd.Timestamp(min_date)]
    df = _clean_spikes(df)
    if interval == "1wk" and not df.empty:
        # Ensure clean weekly bars (drop any partial duplicate week at the end if yahoo duplicates last bar)
        df["yw"] = df.index.isocalendar().year.astype(str) + "-" + df.index.isocalendar().week.astype(str).str.zfill(2)
        df = df.groupby("yw", sort=False).agg({"close": "last", "volume": "sum"}).set_index(
            df.groupby("yw", sort=False).apply(lambda g: g.index[-1], include_groups=False)
        )
    return df


def _to_weekly_iso(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        return df
    iso = df.index.isocalendar()
    yw = iso.year.astype(str) + "-" + iso.week.astype(str).str.zfill(2)
    grouped = df.groupby(yw.values, sort=False)
    out = grouped.agg({"close": "last", "volume": "sum"})
    # Stamp each ISO week to its Monday to match Yahoo Finance 1wk bar timestamps across all sleeves
    out.index = pd.DatetimeIndex([g.index[-1] - pd.Timedelta(days=g.index[-1].weekday()) for _, g in grouped])
    return out.sort_index()


def _fetch_fx_proxy(symbol: str, fx_symbol: str, min_date: str | None = None) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Fetch a USD/foreign total-return ETF and convert daily closes to GBP via fx_symbol, returning (weekly, daily)."""
    px_d = _fetch_bars(symbol, "1d", min_date=min_date)
    fx_d = _fetch_bars(fx_symbol, "1d", min_date=None)
    if px_d.empty or fx_d.empty:
        return pd.DataFrame(columns=["close", "volume"]), pd.DataFrame(columns=["close", "volume"])
    al = px_d.join(fx_d["close"].rename("fx"), how="left")
    al["fx"] = al["fx"].ffill().bfill()
    conv_d = pd.DataFrame({"close": al["close"] * al["fx"], "volume": al["volume"]}, index=al.index)
    conv_d = conv_d[conv_d["close"].notna() & (conv_d["close"] > 0)]
    return _to_weekly_iso(conv_d), conv_d


def _splice_bond(native_df: pd.DataFrame, proxy_df: pd.DataFrame) -> pd.DataFrame:
    """Back-splice a newer or split-corrupted native series with a clean proxy scaled smoothly at first overlap."""
    if native_df.empty or proxy_df.empty:
        return native_df
    first_dt = native_df.index[0]
    pre = proxy_df.loc[proxy_df.index < first_dt].copy()
    if pre.empty:
        return native_df
    # Find nearest proxy close at or before first_dt for seamless scaling
    overlap = proxy_df.loc[proxy_df.index <= first_dt]
    if overlap.empty:
        return native_df
    scale = float(native_df["close"].iloc[0]) / float(overlap["close"].iloc[-1])
    pre["close"] = pre["close"] * scale
    combined = pd.concat([pre, native_df]).sort_index()
    combined = combined[~combined.index.duplicated(keep="last")]
    return combined


def welford_ols(values: np.ndarray, use_log: bool = True, bars_per_year: float = 52.1775) -> dict[str, Any]:
    """Exact replica of the Pine Script Max-History / Fixed-Window Welford OLS regression."""
    vals = np.asarray(values, dtype=np.float64)
    n = len(vals)
    if n < 2:
        return {}
    y = np.log(vals) if use_log else vals
    x = np.arange(1.0, n + 1.0, dtype=np.float64)
    mean_x = x.mean()
    mean_y = y.mean()
    dx = x - mean_x
    dy = y - mean_y
    cxx = float(np.sum(dx * dx))
    cyy = float(np.sum(dy * dy))
    cxy = float(np.sum(dx * dy))
    slope = cxy / cxx if cxx != 0.0 else 0.0
    start_space = mean_y + slope * (1.0 - mean_x)
    end_space = mean_y + slope * (n - mean_x)
    sse = max(cyy - slope * cxy, 0.0)
    sd = math.sqrt(sse / (n - 1.0))
    pearson_r = 0.0 if (cxx == 0.0 or cyy == 0.0) else cxy / math.sqrt(cxx * cyy)
    z = (float(y[-1]) - end_space) / sd if sd > 0 else 0.0

    # Annualised trend & 1-year mean projection (matches Lee's TradingView badge!)
    if use_log:
        trend_pct = (math.exp(slope * bars_per_year) - 1.0) * 100.0
        mean_1y = math.exp(end_space + slope * bars_per_year)
        end_mean_px = math.exp(end_space)
    else:
        end_mean_px = end_space
        mean_1y = end_space + slope * bars_per_year
        trend_pct = ((mean_1y / end_mean_px) - 1.0) * 100.0 if end_mean_px > 0 else 0.0
    to_mean_1y_pct = ((mean_1y / float(vals[-1])) - 1.0) * 100.0 if vals[-1] > 0 else 0.0
    dist_now_pct = ((end_mean_px / float(vals[-1])) - 1.0) * 100.0 if vals[-1] > 0 else 0.0

    return {
        "n": int(n),
        "slope": float(slope),
        "start_space": float(start_space),
        "end_space": float(end_space),
        "sd": float(sd),
        "r": float(pearson_r),
        "z": float(z),
        "trend_pct": float(trend_pct),
        "mean_now": float(end_mean_px),
        "mean_1y": float(mean_1y),
        "to_mean_1y_pct": float(to_mean_1y_pct),
        "dist_now_pct": float(dist_now_pct),
    }


def next_month_countdown(today: date | None = None) -> dict[str, Any]:
    ref = today or date.today()
    # First calendar day of next month
    if ref.month == 12:
        first_cal = date(ref.year + 1, 1, 1)
    else:
        first_cal = date(ref.year, ref.month + 1, 1)
    # First weekday (trading day proxy; shift Sat/Sun -> Mon)
    first_tr = first_cal
    while first_tr.weekday() >= 5:
        first_tr += timedelta(days=1)
    # Handle UK New Year's Day (1 Jan) if weekday
    if first_tr.month == 1 and first_tr.day == 1:
        first_tr += timedelta(days=1)
        while first_tr.weekday() >= 5:
            first_tr += timedelta(days=1)
    days_cal = (first_cal - ref).days
    days_tr = (first_tr - ref).days
    return {
        "today": ref.isoformat(),
        "first_calendar_day": first_cal.isoformat(),
        "first_trading_day": first_tr.isoformat(),
        "first_trading_label": first_tr.strftime("%a %-d %b %Y"),
        "days_to_first_cal": int(days_cal),
        "days_to_first_trading": int(days_tr),
    }


def compute_recommendation(summary_by_id: dict[str, dict[str, Any]], gate_z: float = 1.5) -> dict[str, Any]:
    equities = [a["id"] for a in ASSETS if a["role"] == "equity" and a["id"] in summary_by_id]
    ranked = sorted(equities, key=lambda k: summary_by_id[k]["z"])
    best_id = ranked[0]
    best_z = summary_by_id[best_id]["z"]

    if best_z <= 0.0:
        action = f"BUY {best_id} + SWEEP IGL5"
        tone = "deploy"
        headline = f"{best_id} sits at {best_z:+.2f} SD (at or below Mean). Invest 100% of this month's contribution and sweep 100% of any parked IGL5 into {best_id}."
    elif best_z < gate_z:
        action = f"BUY {best_id}"
        tone = "normal"
        headline = f"{best_id} is the lowest equity at {best_z:+.2f} SD (below the +{gate_z:.1f} SD gilt gate). Invest 100% of new monthly cash into {best_id}; leave any prior IGL5 reserve parked until an equity hits 0.0 SD."
    else:
        action = "PARK IN IGL5"
        tone = "park"
        headline = f"All four equity sleeves sit at or above +{gate_z:.1f} SD (lowest is {best_id} at {best_z:+.2f} SD). Put 100% of this month's contribution into IGL5 until one equity cools to 0.0 SD."

    return {
        "action": action,
        "tone": tone,
        "pick": best_id if best_z < gate_z else "IGL5",
        "lowest_equity": best_id,
        "lowest_z": round(best_z, 3),
        "gate_z": gate_z,
        "ranked_equities": [
            {"id": k, "z": round(summary_by_id[k]["z"], 3), "r": round(summary_by_id[k]["r"], 4)}
            for k in ranked
        ],
        "headline": headline,
    }


def build_dataset() -> dict[str, Any]:
    assets_out: dict[str, Any] = {}
    weekly_summary: dict[str, dict[str, Any]] = {}

    for meta in ASSETS:
        aid = meta["id"]
        min_dt = meta.get("min_date")
        df_w = _fetch_bars(meta["yf"], "1wk", min_date=min_dt)
        df_d = _fetch_bars(meta["yf"], "1d", min_date=min_dt)

        # Back-splice equity sleeves whose pre-merger LSE history is broken on Yahoo (e.g. CSWG via EWL*GBP)
        if meta.get("splice_proxy_yf") and meta.get("splice_fx_yf"):
            pw, pd_ = _fetch_fx_proxy(
                meta["splice_proxy_yf"],
                meta["splice_fx_yf"],
                min_date=meta.get("splice_min_date"),
            )
            df_w = _splice_bond(df_w, pw)
            df_d = _splice_bond(df_d, pd_)

        spliced_w = None
        spliced_d = None
        if meta.get("splice_yf"):
            pw = _fetch_bars(meta["splice_yf"], "1wk", min_date=None)
            pd_ = _fetch_bars(meta["splice_yf"], "1d", min_date=None)
            spliced_w = _splice_bond(df_w, pw)
            spliced_d = _splice_bond(df_d, pd_)

        def pack_series(df: pd.DataFrame) -> dict[str, Any]:
            if df.empty:
                return {"t": [], "c": [], "v": []}
            return {
                "t": [d.strftime("%Y-%m-%d") for d in df.index],
                "c": [round(float(x), 4) for x in df["close"].values],
                "v": [round(float(x), 0) for x in df["volume"].values],
            }

        w_packed = pack_series(df_w)
        d_packed = pack_series(df_d)
        last_px = float(df_d["close"].iloc[-1]) if not df_d.empty else float(df_w["close"].iloc[-1])
        prev_d_px = float(df_d["close"].iloc[-2]) if len(df_d) >= 2 else last_px
        prev_w_px = float(df_w["close"].iloc[-2]) if len(df_w) >= 2 else last_px
        day_chg_abs = last_px - prev_d_px
        wk_chg_abs = last_px - prev_w_px
        day_chg_pct = ((last_px / prev_d_px) - 1.0) * 100.0 if prev_d_px else 0.0
        wk_chg_pct = ((last_px / prev_w_px) - 1.0) * 100.0 if prev_w_px else 0.0

        w_stats = welford_ols(df_w["close"].values, use_log=True, bars_per_year=52.1775)
        weekly_summary[aid] = w_stats

        entry = {
            **meta,
            "last": round(last_px, 4),
            "asof": df_d.index[-1].strftime("%Y-%m-%d") if not df_d.empty else (df_w.index[-1].strftime("%Y-%m-%d") if not df_w.empty else ""),
            "day_chg_abs": round(day_chg_abs, 3),
            "wk_chg_abs": round(wk_chg_abs, 3),
            "day_chg_pct": round(day_chg_pct, 2),
            "wk_chg_pct": round(wk_chg_pct, 2),
            "series": {
                "1W": w_packed,
                "1D": d_packed,
            },
            "summary_max_log_1W": w_stats,
        }
        if spliced_w is not None and spliced_d is not None:
            entry["series"]["1W_spliced"] = pack_series(spliced_w)
            entry["series"]["1D_spliced"] = pack_series(spliced_d)
            entry["summary_spliced_log_1W"] = welford_ols(spliced_w["close"].values, use_log=True, bars_per_year=52.1775)
        assets_out[aid] = entry

    payload = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "order": [a["id"] for a in ASSETS],
        "countdown": next_month_countdown(),
        "recommendation": compute_recommendation(weekly_summary, gate_z=1.5),
        "assets": assets_out,
    }

    (PUBLIC_DATA / "market_data.json").write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    (PUBLIC_DATA / "market_data.js").write_text(
        "window.SD_DESK_DATA = " + json.dumps(payload, separators=(",", ":")) + ";\n",
        encoding="utf-8",
    )
    return payload


if __name__ == "__main__":
    data = build_dataset()
    print(f"Built SD Desk dataset at {data['generated_at']} (Next 1st trading day: {data['countdown']['first_trading_label']}, in {data['countdown']['days_to_first_trading']}d)")
    for aid in data["order"]:
        a = data["assets"][aid]
        s = a["summary_max_log_1W"]
        print(
            f"  {aid:5s}: last={a['last']:8.2f} ({a['currency']}) | 1W Max Log: Z={s['z']:+.2f} SD | R={s['r']:.3f} ({s['n']} bars) | Trend={s['trend_pct']:+.1f}%/yr | +1Y Mean={s['mean_1y']:.1f} | ToMean={s['to_mean_1y_pct']:+.1f}%/yr"
        )
    print("Recommendation:", data["recommendation"]["action"], "->", data["recommendation"]["headline"])
