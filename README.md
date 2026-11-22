# SD Desk

TradingView-styled 4-ETF standard deviation channel dashboard, normalised regression overlay, zero-prior algebraic lump-sum allocator, and daily email briefing for `CSP1`, `CUKX`, `SJPA`, and `IGL5` (spliced with `IGLS.L` back to April 2009).

Live dashboard: https://soylee22.github.io/sd-desk/

## Automation (GitHub Actions)

- **Hourly market refresh & Pages deploy** (`.github/workflows/site-refresh.yml`): fetches LSE GBP bars via `yfinance`, recomputes exact Welford Log/Linear OLS channels, updates `public/data/market_data.{json,js}`, and deploys `public/` to GitHub Pages.
- **Weekday morning email briefing** (`.github/workflows/daily-email.yml`): sends a private HTML and plain-text report with payday countdown, live Z-scores, zero-prior algebraic multipliers, and an optional in-memory read-only Trading 212 summary via GitHub Actions Secrets (`GMAIL_APP_PASSWORD`, `T212_KEY_ID`, `T212_SECRET`). Private account balances are never committed or published to GitHub Pages.

## Local Usage (with Live Browser T212 Sync)

```bash
python3 fetch_data.py
python3 server.py
```

Open `http://127.0.0.1:8765`.
