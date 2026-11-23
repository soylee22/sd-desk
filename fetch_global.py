"""SD Desk Global Radar pipeline: world country indices, macro/bond curves and ~875 index constituents.

Runs on its own daily GitHub Actions schedule so the hourly 4-ETF refresh in fetch_data.py stays fast.
All market data comes from public Yahoo Finance. Welford OLS and spike cleaning are imported
directly from fetch_data.py so every channel in SD Desk uses one set of maths.
"""
from __future__ import annotations

import io
import json
import math
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import yfinance as yf

from fetch_data import _clean_spikes, _extract_ohlcv, welford_ols

ROOT = Path(__file__).resolve().parent
PUBLIC_DATA = ROOT / "public" / "data"
UNIVERSES = ROOT / "universes"
PUBLIC_DATA.mkdir(parents=True, exist_ok=True)

DAILY_BPY = 252.0
WEEKLY_BPY = 52.1775
WINDOW_2500_CAL_DAYS = round(2500 * 365.25 / 252)  # 3624 calendar days
MIN_DAILY_BARS = 250
MIN_WEEKLY_BARS = 104
MIN_WEEKLY_BARS_CRYPTO = 52
FALLBACK_WEEKLY_BARS = 150
CROSS_LEVELS = [-4.0, -3.0, 0.0, 1.0, 2.0]
SPARK_POINTS = 100
BATCH_SIZE = 80

COUNTRIES: list[dict[str, Any]] = [
    # Developed (20)
    {"id": "US", "iso2": "US", "country": "United States", "group": "Developed", "name": "S&P 500", "yf": "^GSPC", "fallback_yf": "SPY", "currency": "USD"},
    {"id": "GB", "iso2": "GB", "country": "United Kingdom", "group": "Developed", "name": "FTSE 100", "yf": "^FTSE", "fallback_yf": "ISF.L", "currency": "GBP"},
    {"id": "JP", "iso2": "JP", "country": "Japan", "group": "Developed", "name": "Nikkei 225", "yf": "^N225", "fallback_yf": "EWJ", "currency": "JPY"},
    {"id": "DE", "iso2": "DE", "country": "Germany", "group": "Developed", "name": "DAX", "yf": "^GDAXI", "fallback_yf": "EWG", "currency": "EUR"},
    {"id": "FR", "iso2": "FR", "country": "France", "group": "Developed", "name": "CAC 40", "yf": "^FCHI", "fallback_yf": "EWQ", "currency": "EUR"},
    {"id": "CH", "iso2": "CH", "country": "Switzerland", "group": "Developed", "name": "SMI", "yf": "^SSMI", "fallback_yf": "EWL", "currency": "CHF"},
    {"id": "CA", "iso2": "CA", "country": "Canada", "group": "Developed", "name": "S&P/TSX", "yf": "^GSPTSE", "fallback_yf": "EWC", "currency": "CAD"},
    {"id": "AU", "iso2": "AU", "country": "Australia", "group": "Developed", "name": "ASX 200", "yf": "^AXJO", "fallback_yf": "EWA", "currency": "AUD"},
    {"id": "NL", "iso2": "NL", "country": "Netherlands", "group": "Developed", "name": "AEX", "yf": "^AEX", "fallback_yf": "EWN", "currency": "EUR"},
    {"id": "ES", "iso2": "ES", "country": "Spain", "group": "Developed", "name": "IBEX 35", "yf": "^IBEX", "fallback_yf": "EWP", "currency": "EUR"},
    {"id": "IT", "iso2": "IT", "country": "Italy", "group": "Developed", "name": "FTSE MIB", "yf": "FTSEMIB.MI", "fallback_yf": "EWI", "currency": "EUR"},
    {"id": "SE", "iso2": "SE", "country": "Sweden", "group": "Developed", "name": "OMX Stockholm 30", "yf": "^OMX", "fallback_yf": "EWD", "currency": "SEK"},
    {"id": "DK", "iso2": "DK", "country": "Denmark", "group": "Developed", "name": "OMX Copenhagen 25", "yf": "^OMXC25", "fallback_yf": "EDEN", "currency": "DKK"},
    {"id": "NO", "iso2": "NO", "country": "Norway", "group": "Developed", "name": "OBX Norway", "yf": "OBX.OL", "fallback_yf": "ENOR", "currency": "NOK"},
    {"id": "FI", "iso2": "FI", "country": "Finland", "group": "Developed", "name": "OMX Helsinki 25", "yf": "^OMXH25", "fallback_yf": "EFNL", "currency": "EUR"},
    {"id": "BE", "iso2": "BE", "country": "Belgium", "group": "Developed", "name": "BEL 20", "yf": "^BFX", "fallback_yf": "EWK", "currency": "EUR"},
    {"id": "AT", "iso2": "AT", "country": "Austria", "group": "Developed", "name": "ATX", "yf": "^ATX", "fallback_yf": "EWO", "currency": "EUR"},
    {"id": "SG", "iso2": "SG", "country": "Singapore", "group": "Developed", "name": "Straits Times", "yf": "^STI", "fallback_yf": "EWS", "currency": "SGD"},
    {"id": "HK", "iso2": "HK", "country": "Hong Kong", "group": "Developed", "name": "Hang Seng", "yf": "^HSI", "fallback_yf": "EWH", "currency": "HKD"},
    {"id": "NZ", "iso2": "NZ", "country": "New Zealand", "group": "Developed", "name": "NZX 50", "yf": "^NZ50", "fallback_yf": "ENZL", "currency": "NZD"},
    # Major Emerging / Asia-LatAm (8)
    {"id": "KR", "iso2": "KR", "country": "South Korea", "group": "Emerging", "name": "KOSPI", "yf": "^KS11", "fallback_yf": "EWY", "currency": "KRW"},
    {"id": "TW", "iso2": "TW", "country": "Taiwan", "group": "Emerging", "name": "TAIEX", "yf": "^TWII", "fallback_yf": "EWT", "currency": "TWD"},
    {"id": "IN", "iso2": "IN", "country": "India", "group": "Emerging", "name": "Nifty 50", "yf": "^NSEI", "fallback_yf": "INDA", "currency": "INR"},
    {"id": "CN", "iso2": "CN", "country": "China", "group": "Emerging", "name": "CSI 300", "yf": "000300.SS", "fallback_yf": "MCHI", "currency": "CNY"},
    {"id": "BR", "iso2": "BR", "country": "Brazil", "group": "Emerging", "name": "Bovespa", "yf": "^BVSP", "fallback_yf": "EWZ", "currency": "BRL"},
    {"id": "MX", "iso2": "MX", "country": "Mexico", "group": "Emerging", "name": "IPC Mexico", "yf": "^MXX", "fallback_yf": "EWW", "currency": "MXN"},
    {"id": "ZA", "iso2": "ZA", "country": "South Africa", "group": "Emerging", "name": "South Africa (EZA)", "yf": "EZA", "fallback_yf": "^J203.JO", "currency": "USD"},
    {"id": "PL", "iso2": "PL", "country": "Poland", "group": "Emerging", "name": "Poland (EPOL)", "yf": "EPOL", "fallback_yf": "WIG20.WA", "currency": "USD"},
]

MACRO: list[dict[str, Any]] = [
    # Commodities
    {"id": "GOLD", "category": "commodity", "name": "Gold", "yf": "GC=F", "currency": "USD"},
    {"id": "SILVER", "category": "commodity", "name": "Silver", "yf": "SI=F", "currency": "USD"},
    {"id": "COPPER", "category": "commodity", "name": "Copper", "yf": "HG=F", "currency": "USD"},
    {"id": "WTI", "category": "commodity", "name": "WTI Crude", "yf": "CL=F", "currency": "USD"},
    {"id": "BRENT", "category": "commodity", "name": "Brent Crude", "yf": "BZ=F", "currency": "USD"},
    {"id": "NATGAS", "category": "commodity", "name": "Natural Gas", "yf": "NG=F", "currency": "USD"},
    {"id": "PLATINUM", "category": "commodity", "name": "Platinum", "yf": "PL=F", "currency": "USD"},
    {"id": "DBC", "category": "commodity", "name": "Broad Commodities", "yf": "DBC", "currency": "USD"},
    # Crypto
    {"id": "BTC", "category": "crypto", "name": "Bitcoin", "yf": "BTC-USD", "currency": "USD"},
    {"id": "ETH", "category": "crypto", "name": "Ethereum", "yf": "ETH-USD", "currency": "USD"},
    {"id": "SOL", "category": "crypto", "name": "Solana", "yf": "SOL-USD", "currency": "USD"},
    # UK gilt curve
    {"id": "IGLS", "category": "bond", "issuer": "UK", "tenor": "Short", "name": "UK Gilts 0-5y", "yf": "IGLS.L", "currency": "GBP"},
    {"id": "IGLT", "category": "bond", "issuer": "UK", "tenor": "Medium", "name": "UK Gilts All-Maturities", "yf": "IGLT.L", "currency": "GBP"},
    {"id": "GLTL", "category": "bond", "issuer": "UK", "tenor": "Long", "name": "UK Gilts 15y+", "yf": "GLTL.L", "currency": "GBP"},
    {"id": "INXG", "category": "bond", "issuer": "UK", "tenor": "Linker", "name": "UK Index-Linked Gilts", "yf": "INXG.L", "currency": "GBP"},
    # US treasury curve
    {"id": "SHY", "category": "bond", "issuer": "US", "tenor": "Short", "name": "US Treasuries 1-3y", "yf": "SHY", "currency": "USD"},
    {"id": "IEF", "category": "bond", "issuer": "US", "tenor": "Medium", "name": "US Treasuries 7-10y", "yf": "IEF", "currency": "USD"},
    {"id": "TLT", "category": "bond", "issuer": "US", "tenor": "Long", "name": "US Treasuries 20y+", "yf": "TLT", "currency": "USD"},
    {"id": "TIP", "category": "bond", "issuer": "US", "tenor": "Linker", "name": "US TIPS", "yf": "TIP", "currency": "USD"},
    # Euro government curve
    {"id": "IBGS", "category": "bond", "issuer": "Euro", "tenor": "Short", "name": "Euro Govt 1-3y", "yf": "IBGS.L", "currency": "EUR"},
    {"id": "IBGM", "category": "bond", "issuer": "Euro", "tenor": "Medium", "name": "Euro Govt 7-10y", "yf": "IBGM.L", "currency": "EUR"},
    {"id": "IBGL", "category": "bond", "issuer": "Euro", "tenor": "Long", "name": "Euro Govt 15-30y", "yf": "IBGL.L", "currency": "EUR"},
]

INDEXES = [
    {"code": "SP500", "label": "S&P 500", "file": "sp500.json", "currency": "USD",
     "wiki": "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"},
    {"code": "FTSE100", "label": "FTSE 100", "file": "ftse100.json", "currency": "GBX",
     "wiki": "https://en.wikipedia.org/wiki/FTSE_100_Index"},
    {"code": "SX50E", "label": "Euro Stoxx 50", "file": "eurostoxx50.json", "currency": "EUR",
     "wiki": "https://en.wikipedia.org/wiki/EURO_STOXX_50"},
    {"code": "N225", "label": "Nikkei 225", "file": "nikkei225.json", "currency": "JPY", "wiki": None},
]

STOCK_FIELDS = [
    "ticker", "name", "index", "sector", "currency", "close",
    "d2500_log", "d2500_lin", "max_log", "max_lin",
    "cross", "w0", "w1", "px",
]


# --------------------------------------------------------------------------------------
# Numeric helpers
# --------------------------------------------------------------------------------------

def sig(value: float, digits: int = 6) -> float | None:
    """Round to a fixed number of significant figures, dropping anything non-finite."""
    v = float(value)
    if not math.isfinite(v):
        return None
    if v == 0.0:
        return 0.0
    mag = math.floor(math.log10(abs(v)))
    return round(v, max(0, digits - 1 - mag))


def clean_number(value: Any, nd: int = 4) -> float | None:
    if value is None:
        return None
    v = float(value)
    if not math.isfinite(v):
        return None
    return round(v, nd)


def pack_series(df: pd.DataFrame) -> dict[str, Any]:
    """Delta-date compact series: t0 plus day gaps, so the frontend rebuilds exact ISO dates."""
    if df is None or df.empty:
        return {"t0": "", "dt": [], "c": []}
    idx = list(df.index)
    closes = [sig(float(x), 6) for x in df["close"].values]
    gaps: list[int] = []
    prev = idx[0]
    for i, ts in enumerate(idx):
        gaps.append(0 if i == 0 else int((ts - prev).days))
        prev = ts
    return {"t0": idx[0].strftime("%Y-%m-%d"), "dt": gaps, "c": closes}


def resample_weekly(df_daily: pd.DataFrame) -> pd.DataFrame:
    """ISO-week last close, matching the weekly grouping used by fetch_data.py."""
    if df_daily is None or df_daily.empty:
        return pd.DataFrame(columns=["close", "volume"])
    iso = df_daily.index.isocalendar()
    key = iso.year.astype(str) + "-" + iso.week.astype(str).str.zfill(2)
    grouped = df_daily.groupby(key.values, sort=False)
    out = grouped.agg({"close": "last", "volume": "sum"})
    out.index = pd.DatetimeIndex([g.index[-1] for _, g in grouped])
    return out.sort_index()


def window_2500(df_daily: pd.DataFrame) -> pd.DataFrame:
    """Exact calendar cutoff: last_date minus 3,624 days, about 2,500 trading bars."""
    if df_daily is None or df_daily.empty:
        return df_daily
    cutoff = df_daily.index[-1] - pd.Timedelta(days=WINDOW_2500_CAL_DAYS)
    return df_daily.loc[df_daily.index >= cutoff]


def stat_block(closes: np.ndarray, use_log: bool, bpy: float, with_dz: bool) -> dict[str, Any] | None:
    """Welford OLS stats plus the optional 1-bar delta Z against the previous bar's own fit."""
    if closes is None or len(closes) < 2:
        return None
    st = welford_ols(closes, use_log=use_log, bars_per_year=bpy)
    if not st:
        return None
    dz = None
    if with_dz and len(closes) >= 3:
        prev = welford_ols(closes[:-1], use_log=use_log, bars_per_year=bpy)
        if prev:
            dz = st["z"] - prev["z"]
    block = {
        "z": clean_number(st["z"], 4),
        "dz": clean_number(dz, 4) if dz is not None else None,
        "r": clean_number(st["r"], 4),
        "n": int(st["n"]),
        "trend_pct": clean_number(st["trend_pct"], 3),
        "mean_now": sig(st["mean_now"], 6),
        "mean_1y": sig(st["mean_1y"], 6),
        "to_mean_1y_pct": clean_number(st["to_mean_1y_pct"], 3),
        "sd": sig(st["sd"], 6),
        "slope": clean_number(st["slope"], 10),
        "start_space": clean_number(st["start_space"], 8),
    }
    return None if block["z"] is None or block["sd"] is None else block


STAT_TUPLE_FIELDS = ["z", "dz", "r", "n", "trend_pct", "mean_now", "mean_1y", "to_mean_1y_pct", "sd"]


def stat_tuple(block: dict[str, Any] | None) -> list[Any] | None:
    """Compact row form for the stock scanner. `sd` is carried so the chart modal can
    redraw the exact fitted channel without re-running the regression in the browser."""
    if not block:
        return None
    return [block[k] for k in STAT_TUPLE_FIELDS]


def downsample(df: pd.DataFrame, points: int) -> tuple[str, str, list[float]]:
    """Evenly spaced price sample across the full weekly series, for the stock chart modal."""
    if df is None or df.empty:
        return "", "", []
    closes = df["close"].values
    n = len(closes)
    if n <= points:
        picks = list(range(n))
    else:
        picks = [round(k * (n - 1) / (points - 1)) for k in range(points)]
    vals = [sig(float(closes[i]), 5) for i in picks]
    return df.index[0].strftime("%Y-%m-%d"), df.index[-1].strftime("%Y-%m-%d"), vals


# --------------------------------------------------------------------------------------
# Band crossings
# --------------------------------------------------------------------------------------

def level_label(level: float, going_up: bool) -> str:
    if level == 0.0:
        return "crossed Mean up" if going_up else "crossed Mean down"
    if level < 0:
        return f"back above {level:g} SD" if going_up else f"below {level:g} SD"
    return f"above +{level:g} SD" if going_up else f"back below +{level:g} SD"


def detect_cross(prev_z: float | None, now_z: float | None) -> str | None:
    """Report the band furthest from the mean that the Z-score crossed since the previous scan."""
    if prev_z is None or now_z is None:
        return None
    hits: list[tuple[float, str]] = []
    for lvl in CROSS_LEVELS:
        if prev_z > lvl >= now_z:
            hits.append((abs(lvl), level_label(lvl, False)))
        elif prev_z < lvl <= now_z:
            hits.append((abs(lvl), level_label(lvl, True)))
    if not hits:
        return None
    hits.sort(key=lambda h: -h[0])
    return hits[0][1]


def read_prior(path: Path) -> dict[str, Any] | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


# --------------------------------------------------------------------------------------
# Downloads
# --------------------------------------------------------------------------------------

def download_one(symbol: str, retries: int = 2) -> pd.DataFrame:
    for attempt in range(retries + 1):
        try:
            raw = yf.download(symbol, period="max", interval="1d", auto_adjust=True,
                              progress=False, threads=False)
            df = _extract_ohlcv(raw)
            if not df.empty:
                return _clean_spikes(df)
        except Exception as exc:
            print(f"    download error {symbol} (attempt {attempt + 1}): {exc}", file=sys.stderr)
        if attempt < retries:
            time.sleep(1.5)
    return pd.DataFrame(columns=["close", "volume"])


def download_batch(symbols: list[str], retries: int = 2) -> dict[str, pd.DataFrame]:
    out: dict[str, pd.DataFrame] = {}
    raw = None
    for attempt in range(retries + 1):
        try:
            raw = yf.download(symbols, period="max", interval="1d", auto_adjust=True,
                              group_by="ticker", threads=True, progress=False)
            break
        except Exception as exc:
            print(f"    batch error (attempt {attempt + 1}): {exc}", file=sys.stderr)
            if attempt < retries:
                time.sleep(3.0)
    if raw is None or raw.empty:
        return out
    for sym in symbols:
        try:
            sub = raw[sym] if isinstance(raw.columns, pd.MultiIndex) else raw
            df = _extract_ohlcv(sub)
            if not df.empty:
                out[sym] = _clean_spikes(df)
        except Exception:
            continue
    return out


# --------------------------------------------------------------------------------------
# Instrument builder (countries, commodities, crypto, bonds)
# --------------------------------------------------------------------------------------

def build_instrument(meta: dict[str, Any], min_weekly: int) -> dict[str, Any] | None:
    symbol = meta["yf"]
    df_d = download_one(symbol)
    df_w = resample_weekly(df_d)
    used_fallback = False
    if meta.get("fallback_yf") and len(df_w) < FALLBACK_WEEKLY_BARS:
        alt_d = download_one(meta["fallback_yf"])
        alt_w = resample_weekly(alt_d)
        if len(alt_w) > len(df_w):
            symbol, df_d, df_w, used_fallback = meta["fallback_yf"], alt_d, alt_w, True

    if df_w.empty or len(df_w) < min_weekly:
        print(f"    skip {meta['id']} ({symbol}): {len(df_w)} weekly bars, need {min_weekly}")
        return None

    stats: dict[str, Any] = {}
    w_closes = df_w["close"].values
    stats["max_log"] = stat_block(w_closes, True, WEEKLY_BPY, True)
    stats["max_lin"] = stat_block(w_closes, False, WEEKLY_BPY, True)

    df_d2500 = window_2500(df_d)
    if len(df_d2500) >= MIN_DAILY_BARS:
        d_closes = df_d2500["close"].values
        stats["d2500_log"] = stat_block(d_closes, True, DAILY_BPY, True)
        stats["d2500_lin"] = stat_block(d_closes, False, DAILY_BPY, True)
    else:
        stats["d2500_log"] = None
        stats["d2500_lin"] = None

    if not stats["max_log"]:
        print(f"    skip {meta['id']} ({symbol}): weekly fit failed")
        return None

    entry = {k: v for k, v in meta.items()}
    entry["yf_used"] = symbol
    entry["used_fallback"] = used_fallback
    entry["close"] = sig(float(df_d["close"].iloc[-1]), 6)
    entry["asof"] = df_d.index[-1].strftime("%Y-%m-%d")
    entry["start_year"] = int(df_w.index[0].year)
    entry["weekly"] = pack_series(df_w)
    entry["daily_2500"] = pack_series(df_d2500) if len(df_d2500) >= MIN_DAILY_BARS else {"t0": "", "dt": [], "c": []}
    entry["stats"] = stats
    return entry


# --------------------------------------------------------------------------------------
# Universe loading
# --------------------------------------------------------------------------------------

def load_fallback(file_name: str) -> list[dict[str, str]]:
    rows = json.loads((UNIVERSES / file_name).read_text(encoding="utf-8"))
    return [r for r in rows if r.get("ticker")]


def wiki_refresh(index_code: str, url: str) -> list[dict[str, str]] | None:
    """Optional constituent refresh. Any scraping drift falls straight back to the committed list."""
    try:
        import re

        import requests

        headers = {"User-Agent": "Mozilla/5.0 (compatible; sd-desk-global-radar/1.0)"}
        html = requests.get(url, headers=headers, timeout=45).text
        tables = pd.read_html(io.StringIO(html))

        def clean(value: Any) -> str:
            return re.sub(r"\s+", " ", re.sub(r"\[[^\]]*\]", "", str(value))).strip()

        if index_code == "SP500":
            tbl = next(t for t in tables if "Symbol" in t.columns and "GICS Sector" in t.columns)
            rows = [{"ticker": clean(r["Symbol"]).replace(".", "-").upper(),
                     "name": clean(r["Security"]),
                     "sector": clean(r["GICS Sector"])} for _, r in tbl.iterrows()]
            return rows if len(rows) >= 450 else None
        if index_code == "FTSE100":
            tbl = next(t for t in tables if "Ticker" in t.columns and "Company" in t.columns and len(t) > 80)
            sec_col = next(c for c in tbl.columns if "sector" in str(c).lower())
            rows = [{"ticker": clean(r["Ticker"]).upper().replace(".", "") + ".L",
                     "name": clean(r["Company"]),
                     "sector": clean(r[sec_col])} for _, r in tbl.iterrows()]
            return rows if len(rows) >= 90 else None
        if index_code == "SX50E":
            tbl = next(t for t in tables if "Ticker" in t.columns and "Sector" in t.columns and 40 <= len(t) <= 60)
            rows = [{"ticker": clean(r["Ticker"]).upper().replace(" ", "-"),
                     "name": clean(r["Name"]),
                     "sector": clean(r["Sector"])} for _, r in tbl.iterrows()]
            return rows if len(rows) >= 45 else None
    except Exception as exc:
        print(f"  wiki refresh for {index_code} failed ({exc}); using committed universe")
    return None


def load_universe(spec: dict[str, Any]) -> list[dict[str, str]]:
    rows = None
    if spec.get("wiki"):
        rows = wiki_refresh(spec["code"], spec["wiki"])
    if not rows:
        rows = load_fallback(spec["file"])
        source = "committed"
    else:
        source = "wikipedia"
    seen, out = set(), []
    for r in rows:
        tk = (r.get("ticker") or "").strip()
        if not tk or tk in seen:
            continue
        seen.add(tk)
        out.append({"ticker": tk, "name": r.get("name", tk), "sector": r.get("sector", "")})
    print(f"  {spec['code']}: {len(out)} constituents ({source})")
    return out


# --------------------------------------------------------------------------------------
# Build steps
# --------------------------------------------------------------------------------------

def build_macro() -> dict[str, Any]:
    prior = read_prior(PUBLIC_DATA / "global_macro.json")
    prior_z: dict[str, float] = {}
    if prior:
        for bucket in ("countries", "macro"):
            for row in prior.get(bucket, []):
                block = (row.get("stats") or {}).get("max_log")
                if block and block.get("z") is not None:
                    prior_z[row["id"]] = block["z"]

    countries: list[dict[str, Any]] = []
    print("Countries:")
    for meta in COUNTRIES:
        entry = build_instrument(meta, MIN_WEEKLY_BARS)
        if entry:
            countries.append(entry)
            s = entry["stats"]["max_log"]
            print(f"  {entry['id']:3s} {entry['name'][:22]:22s} {entry['yf_used']:11s} "
                  f"Z={s['z']:+.2f} R={s['r']:.3f} n={s['n']} since {entry['start_year']}")

    macro: list[dict[str, Any]] = []
    print("Macro, commodities, crypto and bond curves:")
    for meta in MACRO:
        floor = MIN_WEEKLY_BARS_CRYPTO if meta.get("category") == "crypto" else MIN_WEEKLY_BARS
        entry = build_instrument(meta, floor)
        if entry:
            macro.append(entry)
            s = entry["stats"]["max_log"]
            print(f"  {entry['id']:9s} {entry['name'][:24]:24s} {entry['yf_used']:9s} "
                  f"Z={s['z']:+.2f} R={s['r']:.3f} n={s['n']} since {entry['start_year']}")

    crossings = []
    for row in countries + macro:
        block = row["stats"]["max_log"]
        label = detect_cross(prior_z.get(row["id"]), block["z"] if block else None)
        row["cross"] = label
        if label:
            crossings.append({
                "id": row["id"], "name": row["name"], "kind": row.get("category", "country"),
                "z": block["z"], "label": label,
            })

    asof_dates = [r["asof"] for r in countries + macro if r.get("asof")]
    payload = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "asof": max(asof_dates) if asof_dates else "",
        "window_2500_calendar_days": WINDOW_2500_CAL_DAYS,
        "counts": {"countries": len(countries), "macro": len(macro)},
        "crossings": crossings,
        "countries": countries,
        "macro": macro,
    }
    return payload


def build_stocks() -> dict[str, Any]:
    prior = read_prior(PUBLIC_DATA / "global_stocks.json")
    prior_z: dict[str, float] = {}
    if prior:
        fields = prior.get("fields", STOCK_FIELDS)
        try:
            ti, si = fields.index("ticker"), fields.index("d2500_log")
            for row in prior.get("rows", []):
                blk = row[si]
                if blk and blk[0] is not None:
                    prior_z[row[ti]] = blk[0]
        except ValueError:
            pass

    universe: list[dict[str, Any]] = []
    print("Stock universes:")
    for spec in INDEXES:
        for row in load_universe(spec):
            universe.append({**row, "index": spec["code"], "currency": spec["currency"]})

    by_ticker = {u["ticker"]: u for u in universe}
    symbols = list(by_ticker.keys())
    print(f"  total tickers: {len(symbols)}")

    frames: dict[str, pd.DataFrame] = {}
    for i in range(0, len(symbols), BATCH_SIZE):
        batch = symbols[i:i + BATCH_SIZE]
        got = download_batch(batch)
        frames.update(got)
        print(f"  batch {i // BATCH_SIZE + 1}/{math.ceil(len(symbols) / BATCH_SIZE)}: "
              f"{len(got)}/{len(batch)} tickers returned bars")

    rows: list[list[Any]] = []
    crossings: list[dict[str, Any]] = []
    counts: dict[str, int] = {spec["code"]: 0 for spec in INDEXES}
    asof_dates: list[str] = []

    for ticker in symbols:
        df_d = frames.get(ticker)
        if df_d is None or df_d.empty:
            continue
        meta = by_ticker[ticker]
        df_w = resample_weekly(df_d)
        if len(df_w) < MIN_WEEKLY_BARS:
            continue

        d2500 = window_2500(df_d)
        if len(d2500) >= MIN_DAILY_BARS:
            dc = d2500["close"].values
            b_dlog = stat_block(dc, True, DAILY_BPY, True)
            b_dlin = stat_block(dc, False, DAILY_BPY, True)
        else:
            b_dlog = b_dlin = None
        wc = df_w["close"].values
        b_mlog = stat_block(wc, True, WEEKLY_BPY, True)
        b_mlin = stat_block(wc, False, WEEKLY_BPY, True)
        if not b_dlog and not b_mlog:
            continue

        ref_z = b_dlog["z"] if b_dlog else None
        cross = detect_cross(prior_z.get(ticker), ref_z)
        w0, w1, px = downsample(df_w, SPARK_POINTS)
        close = sig(float(df_d["close"].iloc[-1]), 6)
        asof_dates.append(df_d.index[-1].strftime("%Y-%m-%d"))
        counts[meta["index"]] = counts.get(meta["index"], 0) + 1

        rows.append([
            ticker, meta["name"], meta["index"], meta["sector"], meta["currency"], close,
            stat_tuple(b_dlog), stat_tuple(b_dlin), stat_tuple(b_mlog), stat_tuple(b_mlin),
            cross, w0, w1, px,
        ])
        if cross:
            crossings.append({
                "ticker": ticker, "name": meta["name"], "index": meta["index"],
                "z": ref_z, "label": cross,
            })

    payload = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "asof": max(asof_dates) if asof_dates else "",
        "window_2500_calendar_days": WINDOW_2500_CAL_DAYS,
        "counts": counts,
        "total": len(rows),
        "crossings": crossings,
        "fields": STOCK_FIELDS,
        "stat_fields": STAT_TUPLE_FIELDS,
        "rows": rows,
    }
    return payload


# --------------------------------------------------------------------------------------
# Output validation
# --------------------------------------------------------------------------------------

def assert_json_clean(text: str, label: str) -> None:
    for token in ("NaN", "Infinity", "-Infinity"):
        if token in text:
            raise SystemExit(f"{label} contains {token}; refusing to write a broken dataset")


def write_json(path: Path, payload: dict[str, Any]) -> int:
    text = json.dumps(payload, separators=(",", ":"), allow_nan=False)
    assert_json_clean(text, path.name)
    path.write_text(text, encoding="utf-8")
    return path.stat().st_size


def main() -> int:
    started = time.time()
    macro_payload = build_macro()
    macro_bytes = write_json(PUBLIC_DATA / "global_macro.json", macro_payload)

    stocks_payload = build_stocks()
    stock_bytes = write_json(PUBLIC_DATA / "global_stocks.json", stocks_payload)

    n_countries = macro_payload["counts"]["countries"]
    n_macro = macro_payload["counts"]["macro"]
    n_stocks = stocks_payload["total"]
    per_index = stocks_payload["counts"]

    print("")
    print(f"countries={n_countries} macro={n_macro} stocks={n_stocks} "
          f"({' '.join(f'{k}={v}' for k, v in per_index.items())})")
    print(f"global_macro.json={macro_bytes / 1024:.1f} KB  global_stocks.json={stock_bytes / 1024:.1f} KB")
    print(f"crossings: macro={len(macro_payload['crossings'])} stocks={len(stocks_payload['crossings'])}")
    print(f"elapsed {time.time() - started:.1f}s")

    failures = []
    if n_countries < 24:
        failures.append(f"countries {n_countries} < 24")
    if n_macro < 18:
        failures.append(f"macro {n_macro} < 18")
    if n_stocks < 750:
        failures.append(f"stocks {n_stocks} < 750")
    if failures:
        print("VALIDATION FAILED: " + "; ".join(failures), file=sys.stderr)
        return 1
    print("validation OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
