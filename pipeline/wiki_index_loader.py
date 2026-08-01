#!/usr/bin/env python3
"""Wikipedia index-constituent loader, validated by member count.

The problem
-----------
`load_nasdaq100()` fails with "Could not find NASDAQ-100 constituents table on
Wikipedia", so NDX has been served from a 49-day-old cache.

It looks for a table whose columns include `ticker` or `symbol`:

    cols_lower = [str(c).lower() for c in tbl.columns]
    if any(c in ("ticker", "symbol") for c in cols_lower):

That breaks on the most common thing Wikipedia does: give a table a two-row
header. `pandas.read_html` then returns a MultiIndex, and `str(c)` yields
`"('ticker', 'ticker')"`, which equals neither `"ticker"` nor `"symbol"`. The
column is right there and the match still fails.

`load_sp500()` and `load_sp400()` have a quieter version of the same problem:
they take `pd.read_html(html)[0]` and `[1]` — by *position*. They work today
because the constituents table happens to be first. Insert one table above it
and the S&P 500 universe silently becomes something else.

The fix that generalises
------------------------
Do not identify the table by position, and do not trust a column name alone.
**Validate the result by size.** An index with a known membership is the
easiest thing in the world to check: if a candidate table yields 101 plausible
tickers, it is the NASDAQ-100; if it yields 7 or 4,000, it is not, whatever
its columns are called.

So each candidate table is scored on the tickers it actually produces, and the
one landing inside the expected range wins. Nothing in range means a loud,
diagnosable failure listing every table considered — never a silent fallback
to a stale cache.

This is the same rule the health checker applies from the other side
(`idx.member_counts`), which is what surfaced the problem to begin with.

Honest caveat
-------------
This environment cannot reach en.wikipedia.org, so the fetch path is not
verified against the live page. The table-selection and column-matching logic
— which is where the bug is — is tested against reconstructed Wikipedia
markup, including the MultiIndex header that breaks the current code.

Usage
-----
    python pipeline/wiki_index_loader.py --diagnose
    python pipeline/wiki_index_loader.py --load ndx
"""

from __future__ import annotations

import argparse
import io
import re
import sys
import urllib.request

import pandas as pd

BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

# name -> (url, expected_min, expected_max)
# The ranges are deliberately a little wider than the nominal size: indices
# carry dual-class listings (NDX has held 101-103 lines for years) and sit
# briefly off-count between a deletion and its replacement.
INDEX_SOURCES = {
    "ndx":   ("https://en.wikipedia.org/wiki/Nasdaq-100", 95, 110),
    "sp500": ("https://en.wikipedia.org/wiki/List_of_S%26P_500_companies", 490, 515),
    "sp400": ("https://en.wikipedia.org/wiki/List_of_S%26P_400_companies", 385, 415),
    "sp600": ("https://en.wikipedia.org/wiki/List_of_S%26P_600_companies", 580, 620),
    "dji":   ("https://en.wikipedia.org/wiki/Dow_Jones_Industrial_Average", 28, 32),
}

TICKER_HINTS = ("ticker", "symbol", "tickersymbol", "tickersymbols")
TICKER_RE = re.compile(r"^[A-Z][A-Z0-9.\-]{0,5}$")


def fetch_html(url: str, timeout: int = 30) -> str:
    req = urllib.request.Request(url, headers=BROWSER_HEADERS)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", errors="replace")


def _flatten(col) -> str:
    """Normalise a column label, MultiIndex included.

    ('Ticker', 'Ticker') -> 'ticker'; 'Ticker symbol' -> 'tickersymbol'.
    Collapsing to alphanumerics is what makes the match survive Wikipedia's
    header churn — the current code compares the raw string and loses.
    """
    if isinstance(col, tuple):
        parts = [str(c) for c in col if str(c) and not str(c).startswith("Unnamed")]
        # A two-row header usually repeats the label; dedupe so
        # ('Ticker','Ticker') does not become 'tickerticker'.
        seen, out = set(), []
        for p in parts:
            k = p.strip().lower()
            if k not in seen:
                seen.add(k)
                out.append(p)
        col = " ".join(out)
    return re.sub(r"[^a-z0-9]", "", str(col).lower())


def ticker_columns(df: pd.DataFrame) -> list:
    return [c for c in df.columns if any(h in _flatten(c) for h in TICKER_HINTS)]


def extract_tickers(df: pd.DataFrame, col) -> list[str]:
    s = df[col].astype(str).str.strip().str.upper()
    # Wikipedia footnote markers and non-breaking spaces ride along.
    s = s.str.replace(r"\[.*?\]", "", regex=True).str.replace("\xa0", "", regex=False)
    s = s[s.str.match(TICKER_RE, na=False)]
    return sorted(set(s.str.replace(".", "-", regex=False)))


def candidates(html: str) -> list[tuple[int, object, list[str]]]:
    """Every (table index, column, tickers) worth considering, in page order."""
    try:
        tables = pd.read_html(io.StringIO(html))
    except ValueError:
        return []
    out = []
    for i, tbl in enumerate(tables):
        for col in ticker_columns(tbl):
            t = extract_tickers(tbl, col)
            if t:
                out.append((i, col, t))
    return out


def load_index(name: str, *, html: str | None = None,
               verbose: bool = False) -> list[str]:
    """Constituents for `name`, chosen by member count rather than position."""
    if name not in INDEX_SOURCES:
        raise KeyError(f"unknown index {name!r}")
    url, lo, hi = INDEX_SOURCES[name]
    html = html if html is not None else fetch_html(url)

    cands = candidates(html)
    if not cands:
        raise RuntimeError(
            f"{name}: no table on {url} has a ticker-like column at all "
            f"(page structure changed, or the fetch returned something other "
            f"than the article)")

    in_range = [c for c in cands if lo <= len(c[2]) <= hi]
    if in_range:
        # Widest match wins: a constituents table occasionally shares the page
        # with a partial one (recent changes, dual-class notes).
        i, col, tickers = max(in_range, key=lambda c: len(c[2]))
        if verbose:
            print(f"  [ok] {name}: table {i}, column {col!r}, "
                  f"{len(tickers)} tickers", file=sys.stderr)
        return tickers

    report = "; ".join(f"table {i} col {_flatten(c)!r} -> {len(t)}"
                       for i, c, t in cands[:8])
    raise RuntimeError(
        f"{name}: found {len(cands)} ticker-like column(s) but none yielded "
        f"{lo}-{hi} members — {report}. Either the page changed shape or the "
        f"expected range in INDEX_SOURCES is wrong.")


# ── Drop-in replacements for contrarian_screener.py ───────────────────────

def load_nasdaq100() -> list[str]:
    return load_index("ndx")


def load_sp500() -> list[str]:
    return load_index("sp500")


def load_sp400() -> list[str]:
    return load_index("sp400")


# ── CLI ───────────────────────────────────────────────────────────────────

def diagnose(names: list[str]) -> int:
    ok = 0
    for name in names:
        url, lo, hi = INDEX_SOURCES[name]
        print(f"\n{name.upper()}  expect {lo}-{hi} members")
        print(f"  {url}")
        print("-" * 74)
        try:
            html = fetch_html(url)
        except Exception as e:                             # noqa: BLE001
            print(f"  FETCH FAILED: {type(e).__name__}: {e}")
            continue
        cands = candidates(html)
        if not cands:
            print("  no table with a ticker-like column")
            continue
        for i, col, t in cands:
            verdict = "in range  <<< USE THIS" if lo <= len(t) <= hi else "out of range"
            print(f"  table {i:<3} col {_flatten(col)!r:<18} "
                  f"{len(t):>5} tickers   {verdict}")
            if len(t) >= 3:
                print(f"        {', '.join(t[:6])} ...")
        ok += 1 if any(lo <= len(t) <= hi for _, _, t in cands) else 0
    print(f"\n{ok}/{len(names)} indices resolved.")
    return 0 if ok == len(names) else 1


def main(argv=None) -> int:
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--diagnose", action="store_true",
                   help="show every candidate table and why it was accepted")
    p.add_argument("--load", metavar="NAME", help="load one index and print it")
    p.add_argument("--index", action="append", default=[],
                   help="limit --diagnose to these (repeatable)")
    args = p.parse_args(argv)

    names = [n.lower() for n in args.index] or ["ndx", "sp500", "sp400"]
    if args.load:
        t = load_index(args.load.lower(), verbose=True)
        print(f"{args.load.upper()}: {len(t)} tickers")
        print("  " + ", ".join(t[:20]) + (" ..." if len(t) > 20 else ""))
        return 0
    if args.diagnose:
        return diagnose(names)
    p.error("pass --diagnose or --load NAME")


if __name__ == "__main__":
    sys.exit(main())
