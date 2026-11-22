#!/usr/bin/env python3
"""SD Desk daily email briefing (GitHub Actions + local dry-run).

Sends a crisp HTML + plain-text summary of full-history SD channel standings,
next 1st-of-month payday action, zero-prior algebraic multipliers, and optional
private read-only Trading 212 snapshot (kept strictly in memory, never written to git).
"""
from __future__ import annotations

import argparse
import html
import json
import math
import os
import smtplib
import sys
import time
from datetime import date, datetime, timezone
from email.message import EmailMessage
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
DATA_JSON = ROOT / "public" / "data" / "market_data.json"
STATE_JSON = ROOT / "public" / "data" / "last_daily.json"
SITE_URL = "https://soylee22.github.io/sd-desk/"

sys.path.insert(0, str(ROOT))
import fetch_data  # noqa: E402
import server  # noqa: E402

GMAIL_USER = os.environ.get("GMAIL_USER", "leeslater1992@gmail.com")
MAIL_TO = os.environ.get("MAIL_TO", "leeslater1992@gmail.com")


def already_sent_today(today_iso: str | None = None) -> bool:
    ref = today_iso or date.today().isoformat()
    if not STATE_JSON.exists():
        return False
    try:
        st = json.loads(STATE_JSON.read_text(encoding="utf-8"))
        return st.get("last_sent_date") == ref
    except Exception:
        return False


def record_sent_today(today_iso: str | None = None) -> None:
    ref = today_iso or date.today().isoformat()
    STATE_JSON.parent.mkdir(parents=True, exist_ok=True)
    STATE_JSON.write_text(
        json.dumps(
            {
                "last_sent_date": ref,
                "sent_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def _fmt_px(val: float, currency: str) -> str:
    if str(currency).upper() == "GBP" or abs(val) < 100:
        return f"{val:.2f}"
    return f"{round(val):,}"


def _fmt_gbp(val: float, signed: bool = False) -> str:
    if signed:
        prefix = "+£" if val >= 0 else "-£"
    else:
        prefix = "-£" if val < 0 else "£"
    return f"{prefix}{abs(val):,.2f}"


def _zero_prior_multipliers(z_by_id: dict[str, float], beta: float = 0.65, gate_z: float = 1.5) -> dict[str, dict[str, float]]:
    eqs = ["CSP1", "CUKX", "SJPA"]
    all_hot = all(z_by_id[k] >= gate_z for k in eqs)
    if all_hot:
        return {
            "CSP1": {"mult": 0.0, "pct": 0.0},
            "CUKX": {"mult": 0.0, "pct": 0.0},
            "SJPA": {"mult": 0.0, "pct": 0.0},
            "IGL5": {"mult": 1.0, "pct": 100.0},
        }
    u = {k: math.exp(-beta * z_by_id[k]) for k in eqs}
    tot = sum(u.values())
    min_u = min(u.values()) if u else 1.0
    out = {k: {"mult": u[k] / min_u, "pct": (u[k] / tot) * 100.0} for k in eqs}
    out["IGL5"] = {"mult": 0.0, "pct": 0.0}
    return out


def build_report(data: dict[str, Any], t212: dict[str, Any] | None) -> tuple[str, str, str]:
    cd = fetch_data.next_month_countdown()
    stats_by_id: dict[str, dict[str, Any]] = {}
    for aid in data["order"]:
        a = data["assets"][aid]
        if aid == "IGL5" and "summary_spliced_log_1W" in a:
            stats_by_id[aid] = a["summary_spliced_log_1W"]
        else:
            stats_by_id[aid] = a["summary_max_log_1W"]

    rec = fetch_data.compute_recommendation(stats_by_id, gate_z=1.5)
    z_by_id = {aid: stats_by_id[aid]["z"] for aid in data["order"]}
    mults = _zero_prior_multipliers(z_by_id, beta=0.65, gate_z=1.5)

    asof = data["assets"]["CSP1"].get("asof", cd["today"])
    subject = (
        f"SD Desk: {cd['days_to_first_trading']}d to 1st · {rec['action']} "
        f"(CSP1 {z_by_id['CSP1']:+.2f} | SJPA {z_by_id['SJPA']:+.2f} | CUKX {z_by_id['CUKX']:+.2f})"
    )

    # Plain-text version
    plain_lines = [
        f"SD Desk Daily Briefing ({asof})",
        f"Next Payday: {cd['first_trading_label']} ({cd['days_to_first_trading']}d)",
        f"Current Action: {rec['action']}",
        rec["headline"],
        "",
        "Full-History Standings (Max Log 1W, IGL5 2009+ Spliced):",
    ]
    for aid in sorted(data["order"], key=lambda k: stats_by_id[k]["z"]):
        a = data["assets"][aid]
        s = stats_by_id[aid]
        m = mults[aid]
        plain_lines.append(
            f"  {aid:4s} | Last {_fmt_px(a['last'], a['currency'])} {a['currency']} | "
            f"Z {s['z']:+.2f} SD | R {s['r']:.3f} ({s['n']}w) | "
            f"Trend {s['trend_pct']:+.1f}%/yr | To +1Y Mean {s['to_mean_1y_pct']:+.1f}% | "
            f"Lump-Sum {m['mult']:.2f}x ({m['pct']:.1f}%)"
        )
    if t212 and t212.get("connected"):
        plain_lines += [
            "",
            "Private Trading 212 Snapshot (Read-Only):",
            f"  Total Account: {_fmt_gbp(t212['total_account_gbp'])} | Invested: {_fmt_gbp(t212['invested_gbp'])} | "
            f"Free Cash: {_fmt_gbp(t212['free_cash_gbp'])} | P&L: {_fmt_gbp(t212['total_pnl_gbp'], signed=True)} ({t212['total_pnl_pct']:+.2f}%)",
        ]
        for p in t212.get("other_positions", []):
            plain_lines.append(
                f"  Legacy {p['short_name']}: {_fmt_gbp(p['value_gbp'])} ({_fmt_gbp(p['pnl_gbp'], signed=True)}, {p['pnl_pct']:+.2f}%)"
            )
    plain_lines += ["", f"Dashboard: {SITE_URL}"]
    plain = "\n".join(plain_lines)

    # Clean TradingView-inspired HTML email
    tone_bg = {"deploy": "#05332a", "normal": "#0c224d", "park": "#3b2604"}.get(rec["tone"], "#131313")
    tone_fg = {"deploy": "#22ab94", "normal": "#5b9cf6", "park": "#f59e0b"}.get(rec["tone"], "#dbdbdb")

    rows_html = ""
    for aid in sorted(data["order"], key=lambda k: stats_by_id[k]["z"]):
        a = data["assets"][aid]
        s = stats_by_id[aid]
        m = mults[aid]
        z_col = "#22ab94" if s["z"] <= 0 else ("#f23645" if s["z"] >= 1.5 else "#5b9cf6")
        tm_col = "#22ab94" if s["to_mean_1y_pct"] >= 0 else "#f23645"
        rows_html += f"""
        <tr style="border-bottom:1px solid #222222;">
          <td style="padding:9px 8px;font-weight:700;color:#ffffff;">{html.escape(aid)}</td>
          <td style="padding:9px 8px;color:#8c8c8c;">{html.escape(a['region'])}</td>
          <td style="padding:9px 8px;text-align:right;color:#dbdbdb;">{_fmt_px(a['last'], a['currency'])} {html.escape(a['currency'])}</td>
          <td style="padding:9px 8px;text-align:right;font-weight:700;color:{z_col};">{s['z']:+.2f} SD</td>
          <td style="padding:9px 8px;text-align:right;color:#dbdbdb;">{s['r']:.3f}</td>
          <td style="padding:9px 8px;text-align:right;color:#dbdbdb;">{s['trend_pct']:+.1f}%/yr</td>
          <td style="padding:9px 8px;text-align:right;color:{tm_col};">{s['to_mean_1y_pct']:+.1f}%</td>
          <td style="padding:9px 8px;text-align:right;font-weight:600;color:#ffffff;">{m['mult']:.2f}x ({m['pct']:.1f}%)</td>
        </tr>"""

    t212_html = ""
    if t212 and t212.get("connected"):
        pnl_col = "#22ab94" if t212["total_pnl_gbp"] >= 0 else "#f23645"
        other_rows = ""
        for p in t212.get("other_positions", []):
            pc = "#22ab94" if p["pnl_gbp"] >= 0 else "#f23645"
            other_rows += f"""
            <tr style="border-bottom:1px solid #222222;">
              <td style="padding:7px 8px;color:#ffffff;font-weight:600;">{html.escape(p['short_name'])}</td>
              <td style="padding:7px 8px;color:#8c8c8c;">{html.escape(p['name'])}</td>
              <td style="padding:7px 8px;text-align:right;color:#dbdbdb;">{_fmt_gbp(p['value_gbp'])}</td>
              <td style="padding:7px 8px;text-align:right;color:{pc};">{_fmt_gbp(p['pnl_gbp'], signed=True)} ({p['pnl_pct']:+.2f}%)</td>
            </tr>"""
        t212_html = f"""
        <div style="margin-top:20px;border-top:2px solid #222222;padding-top:16px;">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#707070;margin-bottom:10px;">Private Trading 212 Snapshot (Not Published to Web)</div>
          <table style="width:100%;border-collapse:collapse;background:#0c0c0c;border:1px solid #222222;margin-bottom:10px;">
            <tr>
              <td style="padding:10px 12px;"><div style="font-size:10px;color:#707070;text-transform:uppercase;">Total Account</div><div style="font-size:17px;font-weight:700;color:#ffffff;">{_fmt_gbp(t212['total_account_gbp'])}</div></td>
              <td style="padding:10px 12px;"><div style="font-size:10px;color:#707070;text-transform:uppercase;">Invested</div><div style="font-size:17px;font-weight:700;color:#ffffff;">{_fmt_gbp(t212['invested_gbp'])}</div></td>
              <td style="padding:10px 12px;"><div style="font-size:10px;color:#707070;text-transform:uppercase;">Free Cash</div><div style="font-size:17px;font-weight:700;color:#ffffff;">{_fmt_gbp(t212['free_cash_gbp'])}</div></td>
              <td style="padding:10px 12px;"><div style="font-size:10px;color:#707070;text-transform:uppercase;">Unrealised P&amp;L</div><div style="font-size:17px;font-weight:700;color:{pnl_col};">{_fmt_gbp(t212['total_pnl_gbp'], signed=True)} ({t212['total_pnl_pct']:+.2f}%)</div></td>
            </tr>
          </table>
          {f'<table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr style="border-bottom:1px solid #303030;color:#707070;font-size:10.5px;text-transform:uppercase;"><th style="padding:6px 8px;text-align:left;">Holding</th><th style="padding:6px 8px;text-align:left;">Name</th><th style="padding:6px 8px;text-align:right;">Value</th><th style="padding:6px 8px;text-align:right;">P&amp;L</th></tr></thead><tbody>{other_rows}</tbody></table>' if other_rows else ''}
        </div>"""

    html_body = f"""<!DOCTYPE html>
<html><body style="margin:0;padding:20px;background:#0a0a0a;color:#dbdbdb;font-family:-apple-system,BlinkMacSystemFont,'Trebuchet MS',Roboto,Ubuntu,sans-serif;">
  <div style="max-width:680px;margin:0 auto;background:#000000;border:1px solid #222222;padding:22px 24px;">
    <div style="display:flex;justify-content:space-between;align-items:baseline;border-bottom:1px solid #222222;padding-bottom:12px;margin-bottom:16px;">
      <div style="font-size:16px;font-weight:700;color:#ffffff;">SD Desk · Daily Briefing</div>
      <div style="font-size:12px;color:#707070;">LSE close {html.escape(asof)}</div>
    </div>

    <div style="background:#0c0c0c;border:1px solid #222222;padding:14px 16px;margin-bottom:18px;">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#707070;">Next Monthly Payday · {html.escape(cd['first_trading_label'])}</div>
      <div style="margin:6px 0 8px;">
        <span style="font-size:26px;font-weight:700;color:#ffffff;margin-right:10px;">{cd['days_to_first_trading']}d</span>
        <span style="display:inline-block;padding:4px 9px;border-radius:3px;font-size:12px;font-weight:700;background:{tone_bg};color:{tone_fg};">{html.escape(rec['action'])}</span>
      </div>
      <div style="font-size:13px;color:#dbdbdb;line-height:1.45;">{html.escape(rec['headline'])}</div>
    </div>

    <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#707070;margin-bottom:8px;">Full-History Standings (Max Log 1W · Zero-Prior Lump-Sum Multipliers)</div>
    <table style="width:100%;border-collapse:collapse;font-size:12px;">
      <thead>
        <tr style="border-bottom:1px solid #303030;color:#707070;font-size:10.5px;text-transform:uppercase;">
          <th style="padding:7px 8px;text-align:left;">ETF</th>
          <th style="padding:7px 8px;text-align:left;">Region</th>
          <th style="padding:7px 8px;text-align:right;">Last</th>
          <th style="padding:7px 8px;text-align:right;">Live Z</th>
          <th style="padding:7px 8px;text-align:right;">R</th>
          <th style="padding:7px 8px;text-align:right;">Trend</th>
          <th style="padding:7px 8px;text-align:right;">To +1Y Mean</th>
          <th style="padding:7px 8px;text-align:right;">Lump-Sum</th>
        </tr>
      </thead>
      <tbody>{rows_html}</tbody>
    </table>

    {t212_html}

    <div style="margin-top:20px;padding-top:14px;border-top:1px solid #222222;text-align:center;">
      <a href="{SITE_URL}" style="display:inline-block;padding:9px 18px;background:#2962ff;color:#ffffff;text-decoration:none;border-radius:4px;font-weight:600;font-size:13px;">Open Live SD Desk Dashboard</a>
      <div style="font-size:11px;color:#707070;margin-top:8px;">Automated by GitHub Actions · Uncapped SD rules · Not regulated financial advice.</div>
    </div>
  </div>
</body></html>"""

    return subject, plain, html_body


def send_gmail(subject: str, plain: str, html_body: str) -> bool:
    pw = os.environ.get("GMAIL_APP_PASSWORD")
    if not pw:
        print("[daily_email] GMAIL_APP_PASSWORD not set; skipping send")
        return False
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = f"SD Desk <{GMAIL_USER}>"
    msg["To"] = MAIL_TO
    msg.set_content(plain)
    msg.add_alternative(html_body, subtype="html")
    for attempt in range(3):
        try:
            with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=30) as smtp:
                smtp.login(GMAIL_USER, pw.replace(" ", ""))
                rejected = smtp.send_message(msg)
            if not rejected:
                print("[daily_email] Gmail accepted the email")
                return True
        except Exception as exc:
            print("[daily_email] Email attempt failed:", type(exc).__name__)
        if attempt < 2:
            time.sleep(2)
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description="Send SD Desk daily email report")
    parser.add_argument("--once-today", action="store_true", help="Skip if already sent today")
    parser.add_argument("--dry-run", action="store_true", help="Build email and print subject without sending")
    args = parser.parse_args()

    if args.once_today and already_sent_today():
        print("[daily_email] Already sent today; skipping")
        return 0

    if not DATA_JSON.exists():
        data = fetch_data.build_dataset()
    else:
        data = json.loads(DATA_JSON.read_text(encoding="utf-8"))

    t212: dict[str, Any] | None = None
    if os.environ.get("T212_KEY_ID") and os.environ.get("T212_SECRET"):
        try:
            t212 = server.fetch_t212_snapshot()
        except Exception as exc:
            print("[daily_email] T212 private snapshot unavailable:", type(exc).__name__)

    subject, plain, html_body = build_report(data, t212)
    if args.dry_run:
        print("DRY-RUN SUBJECT:", subject)
        print("DRY-RUN HTML BYTES:", len(html_body), "T212_INCLUDED:", bool(t212 and t212.get("connected")))
        return 0

    ok = send_gmail(subject, plain, html_body)
    if ok:
        record_sent_today()
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
