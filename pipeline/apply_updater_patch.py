#!/usr/bin/env python3
"""Two fixes for update_stock_data.py, found in a real fundamentals run.

That run reported `fetched=2441, errors=77` against 2,518 tickers. The 77 come
from two bugs that compound, and only three of them are real data problems.

FIX 1 — _f() lets infinities through
------------------------------------
    def _f(x):
        if x is None or (isinstance(x, float) and (np.isnan(x) or np.isinf(x))):
            return None
        try:
            return float(x)          # <- not re-checked
        except (TypeError, ValueError):
            return None

The guard runs on the INPUT, the conversion happens after. Anything that is
not already a Python float -- a Decimal('Infinity'), a string, a numpy scalar
that does not subclass float -- skips the guard entirely and comes back as
`inf` from `float(x)`. Postgres then rejects it:

    NumericValueOutOfRange: A field with precision 10, scale 2
    cannot hold an infinite value.

Observed for ESPR, BILL and CAL. Checking the result instead of the input is
the whole fix.

FIX 2 — one bad row poisons the next forty-nine
-----------------------------------------------
The insert loop catches per-ticker exceptions but commits only every 50. In
Postgres a failed statement aborts the whole transaction, so every ticker
after the failure raises

    InFailedSqlTransaction: current transaction is aborted

until the next commit. That is exactly what the log shows: errors go 3 -> 36
in one block, then 36 -> 77 in another. Three genuinely bad tickers, ~74
casualties.

A SAVEPOINT per ticker confines a failure to the ticker that caused it.

    python pipeline/apply_updater_patch.py            # show the diff
    python pipeline/apply_updater_patch.py --apply
    python pipeline/apply_updater_patch.py --revert
"""

from __future__ import annotations

import argparse
import difflib
import shutil
import sys
from pathlib import Path

EDITS: list[tuple[str, str, str, str]] = [

    ("_f: reject infinities after conversion, not before",
     "the guard has to run on the RESULT",
     '''def _f(x) -> float | None:
    if x is None or (isinstance(x, float) and (np.isnan(x) or np.isinf(x))):
        return None
    try:
        return float(x)
    except (TypeError, ValueError):
        return None''',
     '''def _f(x) -> float | None:
    # float(x) is what can produce an infinity, so the guard has to run on the
    # RESULT. Checking the input only catches values that are already Python
    # floats; a Decimal('Infinity'), a string, or a scalar that does not
    # subclass float sails past it and reaches Postgres as inf, which fails
    # NUMERIC(10,2) with "cannot hold an infinite value".
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    if v != v or v in (float("inf"), float("-inf")):    # NaN or +/-inf
        return None
    return v'''),

    ("fundamentals: SAVEPOINT per ticker",
     "SAVEPOINT fund_row",
     '''        try:
            tk = yf.Ticker(ticker)
            info = tk.info or {}
            fund = _fund_from_info(info)
            d2e = _days_to_earnings(tk)
            cur.execute("""
                INSERT INTO stock_fundamentals (''',
     '''        try:
            tk = yf.Ticker(ticker)
            info = tk.info or {}
            fund = _fund_from_info(info)
            d2e = _days_to_earnings(tk)
            # Without a savepoint a single rejected row aborts the transaction
            # and every ticker up to the next commit fails with
            # InFailedSqlTransaction -- 3 bad values cost 74 good tickers in
            # the 2026-08-02 run. This confines a failure to its own row.
            cur.execute("SAVEPOINT fund_row")
            cur.execute("""
                INSERT INTO stock_fundamentals ('''),

    ("fundamentals: release or roll back the savepoint",
     "ROLLBACK TO SAVEPOINT fund_row",
     '''            fetched += 1
        except Exception as e:
            errors += 1
            if errors < 10:
                print(f"    [error] {ticker}: {type(e).__name__}: {e}")''',
     '''            cur.execute("RELEASE SAVEPOINT fund_row")
            fetched += 1
        except Exception as e:
            try:
                cur.execute("ROLLBACK TO SAVEPOINT fund_row")
            except Exception:
                pass          # savepoint never opened (fetch failed earlier)
            errors += 1
            if errors < 10:
                print(f"    [error] {ticker}: {type(e).__name__}: {e}")'''),
]


def build(src: str) -> tuple[str, list[str], list[str]]:
    out, applied, skipped = src, [], []
    for label, marker, old, new in EDITS:
        if marker in out:
            skipped.append(f"{label} (already applied)")
            continue
        if old not in out:
            skipped.append(f"{label} (source does not match — NOT applied)")
            continue
        out = out.replace(old, new, 1)
        applied.append(label)
    return out, applied, skipped


def main(argv=None) -> int:
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--file", default="update_stock_data.py")
    p.add_argument("--apply", action="store_true")
    p.add_argument("--revert", action="store_true")
    args = p.parse_args(argv)

    path = Path(args.file)
    backup = path.with_suffix(path.suffix + ".pre-updater-patch")

    if args.revert:
        if not backup.exists():
            print(f"no backup at {backup}", file=sys.stderr)
            return 1
        shutil.copy2(backup, path)
        print(f"restored {path}")
        return 0

    if not path.exists():
        print(f"not found: {path}\nRun from the tangency_portfolio root.",
              file=sys.stderr)
        return 1

    src = path.read_text()
    patched, applied, skipped = build(src)
    for s in skipped:
        print(f"  SKIP  {s}")
    for a in applied:
        print(f"  EDIT  {a}")
    if not applied:
        print("\nnothing to do.")
        return 1 if any("NOT applied" in s for s in skipped) else 0

    if not args.apply:
        print("\n" + "".join(difflib.unified_diff(
            src.splitlines(keepends=True), patched.splitlines(keepends=True),
            fromfile=str(path), tofile=str(path) + " (patched)", n=3)))
        print("re-run with --apply")
        return 0

    shutil.copy2(path, backup)
    path.write_text(patched)
    import py_compile
    try:
        py_compile.compile(str(path), doraise=True)
    except py_compile.PyCompileError as e:
        shutil.copy2(backup, path)
        print(f"  SYNTAX ERROR — reverted: {e}", file=sys.stderr)
        return 1
    print(f"\n  wrote {path}\n  backup at {backup}\n  syntax OK")
    print("\n  re-run the fundamentals pass; errors should drop from 77 to ~3:")
    print("    python update_stock_data.py --fundamentals-only")
    return 0


if __name__ == "__main__":
    sys.exit(main())
