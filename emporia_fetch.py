#!/usr/bin/env python3
"""
emporia_fetch.py
Fetches daily EV charging kWh from the Emporia API using PyEmVue.
Uses get_chart_usage() to pull the entire date range in ONE API call.
Outputs a JSON array to stdout; progress/errors go to stderr only.

Usage:
  python3 emporia_fetch.py --start 2026-01-01 --end 2026-06-30 [--gid 572839]

Required env vars:
  EMPORIA_USERNAME
  EMPORIA_PASSWORD

Install dependency:
  pip3 install pyemvue
"""

import sys
import os
import json
import argparse
from datetime import date, datetime, timedelta, timezone

try:
    import pyemvue
    from pyemvue.enums import Scale, Unit
except ImportError:
    print(json.dumps([]), flush=True)
    print("pyemvue not installed. Run: pip3 install pyemvue", file=sys.stderr)
    sys.exit(0)


def main():
    parser = argparse.ArgumentParser(description="Fetch daily EV kWh from Emporia API")
    parser.add_argument("--start", required=True, help="Start date YYYY-MM-DD")
    parser.add_argument("--end",   required=True, help="End date YYYY-MM-DD")
    parser.add_argument("--gid",   type=int,
                        default=int(os.environ.get("EMPORIA_DEVICE_GID", "572839")),
                        help="Emporia device GID (default: 572839 — Honda Charger)")
    args = parser.parse_args()

    username = os.environ.get("EMPORIA_USERNAME", "")
    password = os.environ.get("EMPORIA_PASSWORD", "")
    if not username or not password:
        print(json.dumps([]), flush=True)
        print("EMPORIA_USERNAME or EMPORIA_PASSWORD not set", file=sys.stderr)
        return

    vue = pyemvue.PyEmVue()
    vue.login(username=username, password=password)
    print(f"Logged in as {username}", file=sys.stderr)

    # Find the target device
    devices = vue.get_devices()
    charger = next((d for d in devices if d.device_gid == args.gid), None)
    if not charger or not charger.channels:
        print(json.dumps([]), flush=True)
        print(f"Device GID {args.gid} not found or has no channels. Available: "
              + ", ".join(f"{d.device_gid} ({d.device_name})" for d in devices), file=sys.stderr)
        return

    channel = charger.channels[0]
    print(f"Device: {charger.device_name} ({charger.model}), channel: {channel.name}", file=sys.stderr)

    start = date.fromisoformat(args.start)
    end   = date.fromisoformat(args.end)

    # Single API call for the entire date range — Scale.DAY returns one kWh per day.
    # Use midnight local time as the start/end anchors.
    start_dt = datetime(start.year, start.month, start.day, 0, 0, 0)
    end_dt   = datetime(end.year,   end.month,   end.day,   23, 59, 59)

    try:
        # Must pass .value (the string literal) — PyEmVue doesn't unwrap the enum in the URL builder
        usage_list, bucket_start = vue.get_chart_usage(channel, start_dt, end_dt, Scale.DAY.value, Unit.KWH.value)
    except Exception as e:
        print(f"get_chart_usage failed: {e}", file=sys.stderr)
        print(json.dumps([]), flush=True)
        return

    # Map each bucket to a calendar date starting from bucket_start
    results = []
    bucket_date = bucket_start.date() if hasattr(bucket_start, 'date') else start
    for kwh in usage_list:
        if bucket_date > end:
            break
        results.append({"date": bucket_date.isoformat(), "evKwh": round(kwh or 0.0, 3)})
        bucket_date += timedelta(days=1)

    print(json.dumps(results), flush=True)
    print(f"Done — {len(results)} days fetched for GID {args.gid}", file=sys.stderr)


if __name__ == "__main__":
    main()
