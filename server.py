"""Local-only SD Desk HTTP server (127.0.0.1) with live yfinance refresh and read-only Trading 212 bridge."""
from __future__ import annotations

import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
DATA_JSON = PUBLIC / "data" / "market_data.json"

sys.path.insert(0, str(ROOT))
import fetch_data  # noqa: E402

ENV_PATHS = [
    Path("/Users/leeslater/projects/portfolio-tracker/.env"),
    Path("/Users/leeslater/.mithril/ping.env"),
    ROOT / ".env",
]

SLEEVE_MAP: dict[str, str] = {}
for _a in fetch_data.ASSETS:
    for _tk in _a.get("t212_tickers", []):
        SLEEVE_MAP[_tk.upper()] = _a["id"]
    SLEEVE_MAP[_a["id"].upper()] = _a["id"]


def _load_t212_creds() -> tuple[str | None, str | None, str]:
    key = os.environ.get("T212_KEY_ID") or os.environ.get("T212_KEY")
    secret = os.environ.get("T212_SECRET")
    base = os.environ.get("T212_BASE", "https://live.trading212.com")
    for p in ENV_PATHS:
        if (not key or not secret) and p.exists():
            try:
                for line in p.read_text(encoding="utf-8").splitlines():
                    line = line.strip()
                    if line and not line.startswith("#") and "=" in line:
                        k, v = line.split("=", 1)
                        k = k.strip()
                        val = v.strip().strip('"').strip("'")
                        if k in ("T212_KEY_ID", "T212_KEY") and not key:
                            key = val
                        elif k == "T212_SECRET" and not secret:
                            secret = val
                        elif k == "T212_BASE" and not base:
                            base = val
            except Exception:
                pass
    return key, secret, base


def _t212_get(path: str) -> Any:
    key, secret, base = _load_t212_creds()
    if not key or not secret:
        raise RuntimeError("Trading 212 credentials not found in local .env")
    auth = base64.b64encode(f"{key}:{secret}".encode()).decode()
    for attempt in range(3):
        req = urllib.request.Request(
            f"{base}/api/v0/equity/{path}",
            headers={"Authorization": f"Basic {auth}"},
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                return json.load(resp)
        except urllib.error.HTTPError as exc:
            if exc.code in (429, 500, 502, 503, 504) and attempt < 2:
                time.sleep(min(float(exc.headers.get("Retry-After", 2)), 10))
                continue
            raise RuntimeError(f"Trading 212 HTTP {exc.code} on {path}") from None
    raise RuntimeError("Trading 212 request failed")


def _match_sleeve(t212_ticker: str, short_name: str = "") -> str | None:
    u = (t212_ticker or "").upper()
    if u in SLEEVE_MAP:
        return SLEEVE_MAP[u]
    prefix = u.split("_")[0]
    if prefix.endswith("L") and len(prefix) >= 4 and prefix[:-1] in SLEEVE_MAP:
        return SLEEVE_MAP[prefix[:-1]]
    if prefix in SLEEVE_MAP:
        return SLEEVE_MAP[prefix]
    sn = (short_name or "").upper()
    if sn in SLEEVE_MAP:
        return SLEEVE_MAP[sn]
    return None


def fetch_t212_snapshot() -> dict[str, Any]:
    """Read-only Trading 212 account snapshot (never persisted to disk)."""
    positions_raw = _t212_get("positions")
    cash_info: dict[str, Any] = {}
    for cash_path in ("account/summary", "account/cash"):
        try:
            cash_info = _t212_get(cash_path)
            break
        except Exception:
            continue

    sleeves: dict[str, dict[str, Any]] = {
        a["id"]: {
            "id": a["id"],
            "name": a["name"],
            "role": a["role"],
            "value_gbp": 0.0,
            "cost_gbp": 0.0,
            "pnl_gbp": 0.0,
            "quantity": 0.0,
            "tickers": [],
        }
        for a in fetch_data.ASSETS
    }
    other_positions: list[dict[str, Any]] = []
    all_positions: list[dict[str, Any]] = []

    for row in positions_raw if isinstance(positions_raw, list) else []:
        inst = row.get("instrument", {}) if isinstance(row, dict) else {}
        wallet = row.get("walletImpact", {}) if isinstance(row, dict) else {}
        t_code = str(inst.get("ticker") or row.get("ticker") or "")
        short_name = str(inst.get("shortName") or t_code.split("_")[0])
        full_name = str(inst.get("name") or short_name)
        qty = float(row.get("quantity", 0.0))
        cur_val = float(wallet.get("currentValue", 0.0))
        cost_val = float(wallet.get("totalCost", 0.0))
        pnl_val = float(wallet.get("unrealizedProfitLoss", cur_val - cost_val))
        pnl_pct = (pnl_val / cost_val * 100.0) if cost_val > 0 else 0.0
        sleeve_id = _match_sleeve(t_code, short_name)

        rec = {
            "t212_ticker": t_code,
            "short_name": short_name,
            "name": full_name,
            "sleeve": sleeve_id,
            "quantity": round(qty, 6),
            "value_gbp": round(cur_val, 2),
            "cost_gbp": round(cost_val, 2),
            "pnl_gbp": round(pnl_val, 2),
            "pnl_pct": round(pnl_pct, 2),
        }
        all_positions.append(rec)
        if sleeve_id and sleeve_id in sleeves:
            sl = sleeves[sleeve_id]
            sl["value_gbp"] = round(sl["value_gbp"] + cur_val, 2)
            sl["cost_gbp"] = round(sl["cost_gbp"] + cost_val, 2)
            sl["pnl_gbp"] = round(sl["pnl_gbp"] + pnl_val, 2)
            sl["quantity"] = round(sl["quantity"] + qty, 6)
            if short_name not in sl["tickers"]:
                sl["tickers"].append(short_name)
        else:
            other_positions.append(rec)

    # Extract cash fields across either account/summary or account/cash schema
    cash_block = cash_info.get("cash", cash_info) if isinstance(cash_info, dict) else {}
    free_cash = float(cash_block.get("availableToTrade", cash_block.get("free", 0.0)) or 0.0)
    invested_total = sum(p["value_gbp"] for p in all_positions)
    total_cost = sum(p["cost_gbp"] for p in all_positions)
    total_pnl = sum(p["pnl_gbp"] for p in all_positions)
    total_account = round(invested_total + free_cash, 2)

    strategy_total = sum(sl["value_gbp"] for sl in sleeves.values())
    for sl in sleeves.values():
        sl["pnl_pct"] = round((sl["pnl_gbp"] / sl["cost_gbp"] * 100.0), 2) if sl["cost_gbp"] > 0 else 0.0
        sl["weight_strategy_pct"] = round((sl["value_gbp"] / strategy_total * 100.0), 2) if strategy_total > 0 else 0.0
        sl["weight_total_pct"] = round((sl["value_gbp"] / total_account * 100.0), 2) if total_account > 0 else 0.0

    return {
        "connected": True,
        "synced_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "currency": "GBP",
        "total_account_gbp": total_account,
        "invested_gbp": round(invested_total, 2),
        "free_cash_gbp": round(free_cash, 2),
        "total_cost_gbp": round(total_cost, 2),
        "total_pnl_gbp": round(total_pnl, 2),
        "total_pnl_pct": round((total_pnl / total_cost * 100.0), 2) if total_cost > 0 else 0.0,
        "strategy_total_gbp": round(strategy_total, 2),
        "sleeves": sleeves,
        "other_positions": sorted(other_positions, key=lambda r: -r["value_gbp"]),
        "position_count": len(all_positions),
    }


class SDDeskHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(PUBLIC), **kwargs)

    def log_message(self, format: str, *args: Any) -> None:
        # Keep logs quiet and never print sensitive account details
        return

    def _send_json(self, obj: Any, status: int = 200) -> None:
        raw = json.dumps(obj, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        if path == "/api/data":
            if not DATA_JSON.exists():
                fetch_data.build_dataset()
            self._send_json(json.loads(DATA_JSON.read_text(encoding="utf-8")))
            return
        if path == "/api/t212":
            try:
                self._send_json(fetch_t212_snapshot())
            except Exception as exc:
                self._send_json({"connected": False, "error": str(exc)}, status=HTTPStatus.OK)
            return
        if path == "/api/health":
            self._send_json({"ok": True, "asof": datetime.now(timezone.utc).isoformat()})
            return
        super().do_GET()

    def do_POST(self) -> None:
        path = self.path.split("?", 1)[0]
        if path == "/api/refresh":
            try:
                data = fetch_data.build_dataset()
                self._send_json({"ok": True, "generated_at": data["generated_at"], "data": data})
            except Exception as exc:
                self._send_json({"ok": False, "error": str(exc)}, status=HTTPStatus.INTERNAL_SERVER_ERROR)
            return
        self.send_error(HTTPStatus.NOT_FOUND)


def main() -> None:
    port = int(os.environ.get("SD_DESK_PORT", "8765"))
    if not DATA_JSON.exists():
        fetch_data.build_dataset()
    srv = ThreadingHTTPServer(("127.0.0.1", port), SDDeskHandler)
    print(f"SD Desk running at http://127.0.0.1:{port} (local-only, read-only T212)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
