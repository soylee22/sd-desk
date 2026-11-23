# SD Desk

TradingView-styled 5-ETF standard deviation channel dashboard, normalised regression overlay, zero-prior algebraic lump-sum allocator, and daily email briefing for `CSP1`, `CUKX`, `SJPA`, `CSWG` (spliced with `EWL` × `GBP=X` back to September 2010), and `IGL5` (spliced with `IGLS.L` back to April 2009).

The Global Radar adds three more views on the same Welford OLS maths:

- **Countries** draws a world choropleth coloured by each benchmark index's live Z-score, with a sortable channel table for 28 developed and major emerging markets.
- **Macro** carries the UK, US and Euro government bond duration curves as a matrix, plus commodities and crypto channels.
- **Scanner** ranks every FTSE 100, S&P 500, Euro Stoxx 50 and Nikkei 225 constituent by SD position, with band-crossing alerts, zone chips, a Pearson R filter and CSV export.

Any row, map country or matrix cell opens the same OLED SD channel chart modal.

Live dashboard: https://soylee22.github.io/sd-desk/

## Automation (GitHub Actions)

- **Hourly market refresh & Pages deploy** (`.github/workflows/site-refresh.yml`): fetches LSE GBP bars via `yfinance`, recomputes exact Welford Log/Linear OLS channels, updates `public/data/market_data.{json,js}`, and deploys `public/` to GitHub Pages.
- **Daily global radar scan** (`.github/workflows/global-radar.yml`): runs `fetch_global.py` at 22:15 UTC on weekdays, after the US close. It scans 28 country benchmarks, 22 macro and bond instruments and about 875 index constituents into `public/data/global_macro.json` and `public/data/global_stocks.json`, validates the counts and the JSON, then deploys Pages. It shares the `sd-desk-main` concurrency group with the hourly refresh so the two never deploy at once.
- **Weekday morning email briefing** (`.github/workflows/daily-email.yml`): sends a private HTML and plain-text report with payday countdown, live Z-scores, zero-prior algebraic multipliers, and an optional in-memory read-only Trading 212 summary via GitHub Actions Secrets (`GMAIL_APP_PASSWORD`, `T212_KEY_ID`, `T212_SECRET`). Private account balances are never committed or published to GitHub Pages.

## Local Usage (with Live Browser T212 Sync)

```bash
python3 fetch_data.py
python3 server.py
```

Open `http://127.0.0.1:8765`.

## Data layout

| File | Built by | Contents |
|---|---|---|
| `public/data/market_data.{json,js}` | `fetch_data.py` | The four core LSE ETFs, full daily and weekly series |
| `public/data/global_macro.json` | `fetch_global.py` | 28 country benchmarks and 22 macro instruments: full weekly series, the 2,500-trading-day daily window, and four stat blocks each |
| `public/data/global_stocks.json` | `fetch_global.py` | About 875 constituents in compact array rows, four stat blocks each plus a 100-point weekly price sample for the chart modal |
| `public/data/world_map.json` | vendored, static | Natural Earth 110m country outlines, pre-projected to a 1000x500 equirectangular viewBox and keyed by ISO-3166 alpha-2 |
| `universes/*.json` | committed fallback | Constituent lists used when the optional Wikipedia refresh fails |
