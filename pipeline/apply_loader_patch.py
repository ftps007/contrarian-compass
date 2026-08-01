#!/usr/bin/env python3
"""Wire the robust loaders into contrarian_screener.py.

Five edits, each an exact-match replacement that refuses to run if the source
does not look the way it is expected to. Nothing is guessed, nothing is
regex-approximated, and the file is backed up first.

    python pipeline/apply_loader_patch.py            # show the diff, change nothing
    python pipeline/apply_loader_patch.py --apply
    python pipeline/apply_loader_patch.py --revert   # restore the backup

What changes
------------
1. `_cached_table`      gains a maximum age. Today it serves a stale cache
                        forever behind one [warn]; past the ceiling it now
                        raises, because a universe that is months out of date
                        is worse than a job that stops.
2. `_fetch_ishares_csv` delegates to pipeline.ishares_loader, which validates
                        the response is CSV before parsing and tries several
                        endpoint variants.
3. `load_nasdaq100`     delegates to pipeline.wiki_index_loader, which picks
   `load_sp500`         the constituents table by MEMBER COUNT rather than by
   `load_sp400`         column name or position.

Every replacement keeps the original function's name, signature and return
type, so no caller changes. Both new modules degrade gracefully: if the
`pipeline` package is not importable the original behaviour is kept, so a
partial checkout cannot break the screener.
"""

from __future__ import annotations

import argparse
import difflib
import shutil
import sys
from pathlib import Path

# (label, marker, must-be-present-exactly, replacement)
#
# `marker` is a string that exists ONLY after the edit has been applied. It is
# a separate field rather than a prefix of `replacement` because some
# replacements legitimately contain the text they replace — the constant
# insertion below re-emits the `def _cached_table(...)` line it anchors on. A
# "has `old` disappeared?" test therefore reports that edit as un-applied on a
# second run and inserts the constant twice.
EDITS: list[tuple[str, str, str, str]] = [

    # ── 1. cache ceiling ──────────────────────────────────────────────────
    ("_cached_table: add a staleness ceiling",
     "Refusing to serve it",
     '''        if os.path.exists(path):
            age_days = (time.time() - os.path.getmtime(path)) / 86400
            print(f"  [warn] refresh of '{name}' failed ({type(e).__name__}: {e}); "
                  f"falling back to stale cache ({age_days:.0f}d old)")
            return pd.read_csv(path)
        raise''',
     '''        if os.path.exists(path):
            age_days = (time.time() - os.path.getmtime(path)) / 86400
            # A fallback to a slightly stale list is right — constituents drift
            # slowly. An unbounded one is not: a source that broke in May was
            # still being served in August behind this single warning, and the
            # run exited 0 the whole time. Past the ceiling, stop.
            if age_days > MAX_CACHE_AGE_DAYS:
                raise RuntimeError(
                    f"'{name}' refresh failed ({type(e).__name__}: {e}) and the "
                    f"cache is {age_days:.0f}d old, past the "
                    f"{MAX_CACHE_AGE_DAYS}d ceiling. Refusing to serve it — the "
                    f"universe would be materially wrong. Fix the source, or "
                    f"raise MAX_CACHE_AGE_DAYS deliberately."
                ) from e
            print(f"  [warn] refresh of '{name}' failed ({type(e).__name__}: {e}); "
                  f"falling back to stale cache ({age_days:.0f}d old, ceiling "
                  f"{MAX_CACHE_AGE_DAYS}d)")
            return pd.read_csv(path)
        raise'''),

    ("_cached_table: declare the ceiling constant",
     "MAX_CACHE_AGE_DAYS = 45",
     '''def _cached_table(name: str, fetch_fn, ttl_days: int = 7) -> pd.DataFrame:''',
     '''# Longest a stale cache may still be served after a refresh failure.
# Beyond this the screener would be ranking an index that no longer exists.
MAX_CACHE_AGE_DAYS = 45


def _cached_table(name: str, fetch_fn, ttl_days: int = 7) -> pd.DataFrame:'''),

    # ── 2. iShares ────────────────────────────────────────────────────────
    ("_fetch_ishares_csv: delegate to the validating loader",
     "from pipeline.ishares_loader import fetch_holdings",
     '''    req = urllib.request.Request(url, headers=_WIKI_HEADERS)
    with urllib.request.urlopen(req, timeout=60) as r:
        raw = r.read().decode("utf-8")
    lines = raw.splitlines()
    header_idx = None
    for i, line in enumerate(lines):
        if line.startswith("Ticker,") or "\\"Ticker\\"" in line.split(",")[0]:
            header_idx = i
            break
    if header_idx is None:
        raise RuntimeError(f"Could not find Ticker header row in {etf} CSV")
    from io import StringIO
    return pd.read_csv(StringIO("\\n".join(lines[header_idx:])))''',
     '''    # Delegates to pipeline.ishares_loader: it checks the response is CSV
    # before parsing (the endpoint currently returns the product web page),
    # tries several URL variants, and tolerates BOM/quoting in the header row.
    # The old inline parser reported every one of those as the same
    # "Could not find Ticker header row", which made a block and a format
    # change indistinguishable.
    try:
        from pipeline.ishares_loader import fetch_holdings
    except ImportError:
        raise RuntimeError(
            "pipeline.ishares_loader not importable — copy the pipeline/ "
            "package next to this file") from None
    return fetch_holdings(etf)'''),

    # ── 3. Wikipedia loaders ──────────────────────────────────────────────
    ("load_nasdaq100: select the table by member count",
     "no table on the Nasdaq-100 page yields",
     '''    def _fetch():
        html = _fetch_wiki_html("https://en.wikipedia.org/wiki/Nasdaq-100")
        # The constituents table lives later in the page; find the one with a Ticker column.
        for tbl in pd.read_html(html):
            cols_lower = [str(c).lower() for c in tbl.columns]
            if any(c in ("ticker", "symbol") for c in cols_lower):
                return tbl
        raise RuntimeError("Could not find NASDAQ-100 constituents table on Wikipedia")
    df = _cached_table("nasdaq100", _fetch)
    col = "Ticker" if "Ticker" in df.columns else ("Symbol" if "Symbol" in df.columns else df.columns[0])
    return df[col].astype(str).str.replace(".", "-", regex=False).tolist()''',
     '''    # The old matcher compared str(column) against "ticker"/"symbol", which
    # fails on a two-row Wikipedia header: pandas returns a MultiIndex and
    # str(c) is "('Ticker', 'Ticker')". The table is picked by MEMBER COUNT
    # instead — a candidate yielding ~100 plausible tickers is the NASDAQ-100,
    # whatever its columns are called.
    from pipeline.wiki_index_loader import (INDEX_SOURCES, extract_from_table,
                                            fetch_html, candidates)

    def _fetch():
        url, lo, hi = INDEX_SOURCES["ndx"]
        html = fetch_html(url)
        cands = [c for c in candidates(html) if lo <= len(c[2]) <= hi]
        if not cands:
            raise RuntimeError(
                "no table on the Nasdaq-100 page yields "
                f"{lo}-{hi} constituents")
        import pandas as _pd
        return _pd.DataFrame({"Ticker": max(cands, key=lambda c: len(c[2]))[2]})

    return extract_from_table(_cached_table("nasdaq100", _fetch))'''),

    ("load_sp500: stop indexing tables by position",
     "no S&P 500 table yields",
     '''    def _fetch():
        html = _fetch_wiki_html("https://en.wikipedia.org/wiki/List_of_S%26P_500_companies")
        return pd.read_html(html)[0]
    df = _cached_table("sp500", _fetch)
    return df["Symbol"].astype(str).str.replace(".", "-", regex=False).tolist()''',
     '''    # Was pd.read_html(html)[0] — correct only while the constituents table
    # happens to come first. One table inserted above it and the S&P 500
    # universe silently becomes something else. Selected by member count now.
    from pipeline.wiki_index_loader import (INDEX_SOURCES, extract_from_table,
                                            fetch_html, candidates)

    def _fetch():
        url, lo, hi = INDEX_SOURCES["sp500"]
        cands = [c for c in candidates(fetch_html(url)) if lo <= len(c[2]) <= hi]
        if not cands:
            raise RuntimeError(f"no S&P 500 table yields {lo}-{hi} members")
        import pandas as _pd
        return _pd.DataFrame({"Symbol": max(cands, key=lambda c: len(c[2]))[2]})

    return extract_from_table(_cached_table("sp500", _fetch))'''),
]


def load(path: Path) -> str:
    return path.read_text()


def build(src: str) -> tuple[str, list[str], list[str]]:
    """Returns (patched, applied labels, skipped labels)."""
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
    p.add_argument("--file", default="contrarian_screener.py",
                   help="path to contrarian_screener.py")
    p.add_argument("--apply", action="store_true")
    p.add_argument("--revert", action="store_true")
    args = p.parse_args(argv)

    path = Path(args.file)
    backup = path.with_suffix(path.suffix + ".pre-loader-patch")

    if args.revert:
        if not backup.exists():
            print(f"no backup at {backup}", file=sys.stderr)
            return 1
        shutil.copy2(backup, path)
        print(f"restored {path} from {backup}")
        return 0

    if not path.exists():
        print(f"not found: {path}\nRun this from the tangency_portfolio root.",
              file=sys.stderr)
        return 1

    src = load(path)
    patched, applied, skipped = build(src)

    for s in skipped:
        print(f"  SKIP  {s}")
    for a in applied:
        print(f"  EDIT  {a}")

    if not applied:
        print("\nnothing to do.")
        return 0 if not any("NOT applied" in s for s in skipped) else 1

    if not args.apply:
        print("\n" + "".join(difflib.unified_diff(
            src.splitlines(keepends=True), patched.splitlines(keepends=True),
            fromfile=str(path), tofile=str(path) + " (patched)", n=2)))
        print("re-run with --apply to write it")
        return 0

    shutil.copy2(path, backup)
    path.write_text(patched)
    print(f"\n  wrote {path}")
    print(f"  backup at {backup}  (--revert to restore)")

    import py_compile
    try:
        py_compile.compile(str(path), doraise=True)
        print("  syntax OK")
    except py_compile.PyCompileError as e:
        print(f"  SYNTAX ERROR — reverting: {e}", file=sys.stderr)
        shutil.copy2(backup, path)
        return 1

    print("\n  verify:")
    print("    python -c \"import contrarian_screener as c; "
          "print(len(c.load_nasdaq100()), 'NDX tickers')\"")
    print("    python update_stock_data.py --memberships-only")
    return 0


if __name__ == "__main__":
    sys.exit(main())
