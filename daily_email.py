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

    # Bulletproof email HTML: pure table layout (zero flex/grid), crisp light card that survives Gmail/Apple Mail
    tone_map = {
        "deploy": ("#dcfce7", "#166534", "#86efac"),
        "normal": ("#dbeafe", "#1e40af", "#93c5fd"),
        "park": ("#fef3c7", "#92400e", "#fcd34d"),
    }
    tone_bg, tone_fg, tone_bd = tone_map.get(rec["tone"], ("#f3f4f6", "#111827", "#d1d5db"))

    rows_html = ""
    for aid in sorted(data["order"], key=lambda k: stats_by_id[k]["z"]):
        a = data["assets"][aid]
        s = stats_by_id[aid]
        m = mults[aid]
        z_col = "#15803d" if s["z"] <= 0 else ("#dc2626" if s["z"] >= 1.5 else "#1d4ed8")
        tm_col = "#15803d" if s["to_mean_1y_pct"] >= 0 else "#dc2626"
        mult_str = f"{m['mult']:.2f}x" if m["mult"] > 0 else "0.00x"
        rows_html += f"""
        <tr>
          <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;vertical-align:top;">
            <div style="font-weight:700;color:#111827;font-size:13px;">{html.escape(aid)}</div>
            <div style="font-size:11px;color:#6b7280;">{html.escape(a['region'])} · R {s['r']:.3f} ({s['n']}w)</div>
          </td>
          <td style="padding:10px 6px;border-bottom:1px solid #e5e7eb;text-align:right;white-space:nowrap;vertical-align:top;color:#111827;font-size:13px;">
            {_fmt_px(a['last'], a['currency'])}<br><span style="font-size:10px;color:#6b7280;">{html.escape(a['currency'])}</span>
          </td>
          <td style="padding:10px 6px;border-bottom:1px solid #e5e7eb;text-align:right;white-space:nowrap;vertical-align:top;font-weight:700;color:{z_col};font-size:13px;">
            {s['z']:+.2f} SD
          </td>
          <td style="padding:10px 6px;border-bottom:1px solid #e5e7eb;text-align:right;white-space:nowrap;vertical-align:top;font-size:12px;">
            <span style="color:#374151;">{s['trend_pct']:+.1f}%/yr</span><br>
            <span style="color:{tm_col};font-weight:600;">{s['to_mean_1y_pct']:+.1f}% to mean</span>
          </td>
          <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;text-align:right;white-space:nowrap;vertical-align:top;font-size:12px;">
            <strong style="color:#111827;">{mult_str}</strong><br>
            <span style="color:#6b7280;">{m['pct']:.1f}%</span>
          </td>
        </tr>"""

    t212_html = ""
    if t212 and t212.get("connected"):
        pnl_col = "#15803d" if t212["total_pnl_gbp"] >= 0 else "#dc2626"
        other_rows = ""
        for p in t212.get("other_positions", []):
            pc = "#15803d" if p["pnl_gbp"] >= 0 else "#dc2626"
            other_rows += f"""
            <tr>
              <td style="padding:8px;border-bottom:1px solid #e5e7eb;color:#111827;font-weight:600;font-size:12px;">
                {html.escape(p['short_name'])}<br><span style="font-weight:400;font-size:11px;color:#6b7280;">{html.escape(p['name'])}</span>
              </td>
              <td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:right;white-space:nowrap;color:#111827;font-size:12px;">{_fmt_gbp(p['value_gbp'])}</td>
              <td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:right;white-space:nowrap;color:{pc};font-weight:600;font-size:12px;">{_fmt_gbp(p['pnl_gbp'], signed=True)}<br><span style="font-size:11px;">({p['pnl_pct']:+.2f}%)</span></td>
            </tr>"""
        other_table = ""
        if other_rows:
            other_table = f"""
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:10px;">
              <thead>
                <tr>
                  <th style="padding:6px 8px;text-align:left;font-size:10px;text-transform:uppercase;color:#6b7280;border-bottom:2px solid #e5e7eb;">Holding</th>
                  <th style="padding:6px 8px;text-align:right;font-size:10px;text-transform:uppercase;color:#6b7280;border-bottom:2px solid #e5e7eb;">Value</th>
                  <th style="padding:6px 8px;text-align:right;font-size:10px;text-transform:uppercase;color:#6b7280;border-bottom:2px solid #e5e7eb;">P&amp;L</th>
                </tr>
              </thead>
              <tbody>{other_rows}</tbody>
            </table>"""

        t212_html = f"""
        <tr>
          <td style="padding:18px 20px 6px;border-top:1px solid #e5e7eb;">
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#6b7280;margin-bottom:10px;">Private Trading 212 Snapshot (Not Published to Web)</div>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#f9fafb;border:1px solid #e5e7eb;">
              <tr>
                <td width="50%" style="padding:10px 12px;border-right:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb;">
                  <div style="font-size:10px;text-transform:uppercase;color:#6b7280;">Total Account</div>
                  <div style="font-size:17px;font-weight:700;color:#111827;margin-top:2px;">{_fmt_gbp(t212['total_account_gbp'])}</div>
                </td>
                <td width="50%" style="padding:10px 12px;border-bottom:1px solid #e5e7eb;">
                  <div style="font-size:10px;text-transform:uppercase;color:#6b7280;">Invested</div>
                  <div style="font-size:17px;font-weight:700;color:#111827;margin-top:2px;">{_fmt_gbp(t212['invested_gbp'])}</div>
                </td>
              </tr>
              <tr>
                <td width="50%" style="padding:10px 12px;border-right:1px solid #e5e7eb;">
                  <div style="font-size:10px;text-transform:uppercase;color:#6b7280;">Free Cash</div>
                  <div style="font-size:17px;font-weight:700;color:#111827;margin-top:2px;">{_fmt_gbp(t212['free_cash_gbp'])}</div>
                </td>
                <td width="50%" style="padding:10px 12px;">
                  <div style="font-size:10px;text-transform:uppercase;color:#6b7280;">Unrealised P&amp;L</div>
                  <div style="font-size:17px;font-weight:700;color:{pnl_col};margin-top:2px;">{_fmt_gbp(t212['total_pnl_gbp'], signed=True)} ({t212['total_pnl_pct']:+.2f}%)</div>
                </td>
              </tr>
            </table>
            {other_table}
          </td>
        </tr>"""

    html_body = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
</head>
<body style="margin:0;padding:16px 8px;background-color:#f3f4f6;color:#111827;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#f3f4f6">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="max-width:600px;background-color:#ffffff;border:1px solid #e5e7eb;border-radius:8px;border-collapse:separate;">
          <!-- Header -->
          <tr>
            <td style="padding:18px 20px;border-bottom:1px solid #e5e7eb;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="font-size:18px;font-weight:700;color:#111827;">SD Desk</td>
                  <td align="right" style="font-size:12px;color:#6b7280;white-space:nowrap;">LSE close {html.escape(asof)}</td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Payday Action Banner -->
          <tr>
            <td style="padding:16px 20px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#f9fafb" style="background-color:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;">
                <tr>
                  <td style="padding:14px 16px;">
                    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#6b7280;">
                      Next Monthly Payday · {html.escape(cd['first_trading_label'])}
                    </div>
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0;">
                      <tr>
                        <td style="font-size:26px;font-weight:800;color:#111827;white-space:nowrap;width:64px;">{cd['days_to_first_trading']}d</td>
                        <td style="vertical-align:middle;">
                          <span style="display:inline-block;padding:4px 10px;border-radius:4px;font-size:12px;font-weight:700;background-color:{tone_bg};color:{tone_fg};border:1px solid {tone_bd};">{html.escape(rec['action'])}</span>
                        </td>
                      </tr>
                    </table>
                    <div style="font-size:13px;color:#374151;line-height:1.45;">{html.escape(rec['headline'])}</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Standings Table -->
          <tr>
            <td style="padding:4px 20px 16px;">
              <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#6b7280;margin-bottom:8px;">
                Full-History Standings (Max Log 1W · Zero-Prior Lump-Sum)
              </div>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
                <thead>
                  <tr>
                    <th style="padding:7px 8px;text-align:left;font-size:10px;text-transform:uppercase;color:#6b7280;border-bottom:2px solid #e5e7eb;">ETF</th>
                    <th style="padding:7px 6px;text-align:right;font-size:10px;text-transform:uppercase;color:#6b7280;border-bottom:2px solid #e5e7eb;">Last</th>
                    <th style="padding:7px 6px;text-align:right;font-size:10px;text-transform:uppercase;color:#6b7280;border-bottom:2px solid #e5e7eb;">Live Z</th>
                    <th style="padding:7px 6px;text-align:right;font-size:10px;text-transform:uppercase;color:#6b7280;border-bottom:2px solid #e5e7eb;">Channel</th>
                    <th style="padding:7px 8px;text-align:right;font-size:10px;text-transform:uppercase;color:#6b7280;border-bottom:2px solid #e5e7eb;">Lump-Sum</th>
                  </tr>
                </thead>
                <tbody>{rows_html}</tbody>
              </table>
            </td>
          </tr>

          {t212_html}

          <!-- CTA Footer -->
          <tr>
            <td align="center" style="padding:18px 20px 22px;border-top:1px solid #e5e7eb;">
              <a href="{SITE_URL}" style="display:inline-block;padding:10px 22px;background-color:#2962ff;color:#ffffff;text-decoration:none;border-radius:5px;font-weight:600;font-size:13px;">Open Live SD Desk Dashboard</a>
              <div style="font-size:11px;color:#9ca3af;margin-top:10px;">Automated by GitHub Actions · Uncapped SD rules · Not regulated financial advice.</div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>"""

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
