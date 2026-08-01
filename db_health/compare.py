#!/usr/bin/env python3
"""Diff two health-check runs, check by check.

Comparing two 55-line reports by eye is how a regression gets missed: the
headline score can rise while an individual check quietly gets worse, because
one large improvement masks several small losses. This puts them side by side
and sorts by what actually moved.

    # against the stored baseline
    python -m db_health.compare after.json

    # any two runs
    python -m db_health.compare before.json after.json

Produce the inputs with:

    python db_health_check.py --dbname stock_data --user ftps \\
        --format json --output after.json

A note on the shipped baseline: it was reconstructed from the terminal output
of the first full run, so it carries statuses and headline metrics but not
samples or remediation text. That is enough for a status and count diff, which
is what this compares. Runs saved as JSON from the start are complete.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

DEFAULT_BASELINE = (Path(__file__).parent / "baselines" /
                    "2026-08-01_first_full_run.json")

RANK = {"PASS": 0, "INFO": 1, "SKIP": 2, "WARN": 3, "FAIL": 4, "ERROR": 5}


def load(path: str | Path) -> dict:
    with open(path) as fh:
        return json.load(fh)


def by_id(doc: dict) -> dict[str, dict]:
    return {f["check_id"]: f for f in doc.get("findings", [])}


def flat(metrics: dict, prefix: str = "") -> dict[str, float]:
    """Numeric metrics only, flattened — the comparable part."""
    out: dict[str, float] = {}
    for k, v in (metrics or {}).items():
        key = f"{prefix}{k}"
        if isinstance(v, dict):
            out.update(flat(v, f"{key}."))
        elif isinstance(v, bool):
            continue
        elif isinstance(v, (int, float)):
            out[key] = float(v)
    return out


def metric_deltas(before: dict, after: dict, limit: int = 4) -> list[str]:
    b, a = flat(before.get("metrics", {})), flat(after.get("metrics", {}))
    out = []
    for k in sorted(set(b) & set(a)):
        if b[k] == a[k]:
            continue
        d = a[k] - b[k]
        fmt = (lambda x: f"{x:,.0f}") if abs(b[k]) >= 100 else (lambda x: f"{x:g}")
        out.append(f"{k} {fmt(b[k])}→{fmt(a[k])} ({'+' if d > 0 else ''}{fmt(d)})")
    return out[:limit]


def main(argv=None) -> int:
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("first", help="the newer run, or the older one if two given")
    p.add_argument("second", nargs="?", help="the newer run")
    p.add_argument("--baseline", default=str(DEFAULT_BASELINE))
    args = p.parse_args(argv)

    if args.second:
        before, after = load(args.first), load(args.second)
        blabel, alabel = args.first, args.second
    else:
        before, after = load(args.baseline), load(args.first)
        blabel, alabel = f"baseline {before.get('started_at', '')}", args.first

    B, A = by_id(before), by_id(after)

    print(f"  before  {blabel}")
    print(f"  after   {alabel}")
    print("=" * 78)
    sb, sa = before.get("score", 0), after.get("score", 0)
    arrow = "↑" if sa > sb else ("↓" if sa < sb else "=")
    print(f"  SCORE   {sb:.1f}  →  {sa:.1f}   {arrow} {sa - sb:+.1f}")
    cb, ca = before.get("counts", {}), after.get("counts", {})
    print("  " + "   ".join(
        f"{k} {cb.get(k, 0)}→{ca.get(k, 0)}" for k in
        ("PASS", "INFO", "WARN", "FAIL", "ERROR") if cb.get(k) or ca.get(k)))
    print("=" * 78)

    better, worse, same, added, gone = [], [], [], [], []
    for cid in sorted(set(B) | set(A)):
        if cid not in B:
            added.append(cid)
            continue
        if cid not in A:
            gone.append(cid)
            continue
        rb, ra = RANK.get(B[cid]["status"], 9), RANK.get(A[cid]["status"], 9)
        row = (cid, B[cid]["status"], A[cid]["status"],
               metric_deltas(B[cid], A[cid]))
        (better if ra < rb else worse if ra > rb else same).append(row)

    def show(title: str, rows: list, always_metrics: bool = True) -> None:
        if not rows:
            return
        print(f"\n{title}  ({len(rows)})")
        print("-" * 78)
        for cid, s0, s1, deltas in rows:
            change = f"{s0}→{s1}" if s0 != s1 else s1
            print(f"  {cid:<30} {change:<12} {deltas[0] if deltas else ''}")
            for d in deltas[1:]:
                print(f"  {'':<30} {'':<12} {d}")

    show("BESSER", better)
    show("SCHLECHTER  ← hier zuerst schauen", worse)
    moved = [r for r in same if r[3]]
    show("gleicher Status, Zahlen bewegt", moved)
    unchanged = len(same) - len(moved)
    if unchanged:
        print(f"\nunverändert: {unchanged}")
    if added:
        print(f"\nneu in diesem Lauf: {', '.join(added)}")
    if gone:
        print(f"\nnicht mehr gelaufen: {', '.join(gone)}")

    if worse:
        print(f"\n  {len(worse)} Prüfung(en) verschlechtert — der Score allein "
              f"zeigt das nicht.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
