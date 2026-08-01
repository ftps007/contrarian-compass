#!/usr/bin/env python3
"""Robust iShares holdings loader — replaces _fetch_ishares_csv().

The problem
-----------
`contrarian_screener._fetch_ishares_csv()` requests

    https://www.ishares.com/us/products/{pid}/{slug}/
        1467271812596.ajax?fileType=csv&fileName={fname}&dataType=fund

and that endpoint now answers with the product *web page* — HTML, not CSV.
Confirmed by hand: the response opens `<!DOCTYPE html>`. All three Russell
loaders (IWB/IWM/IWV) therefore fail together, which is why RUI, RUT and RUA
were all 85 days stale while SP500 and SP400 kept working.

Two things made it worse than a broken download should be:

1. The header sniff assumed a shape rather than checking one:

       if line.startswith("Ticker,") or '"Ticker"' in line.split(",")[0]

   A BOM, a leading space, a renamed column or an HTML body all produce the
   same "Could not find Ticker header row" — so a *blocked request* and a
   *format change* are indistinguishable from the error message.

2. `_cached_table()` has no maximum age. On failure it serves the cache
   forever with a one-line `[warn]` that scrolls past in a long run. The
   pipeline exits 0, the weekly job looks healthy, and the universe quietly
   ages. Nothing surfaced it until the health checker measured RUA's member
   count against a plausible range.

What this does
--------------
* tries several documented endpoint variants, with browser-like headers and a
  Referer (iShares gates on it)
* **validates that the response is CSV before parsing it** — the single most
  important change, because it turns "mystery parse error" into "the server
  returned HTML"
* tolerant header detection: BOM, whitespace, quoting, and any of the first
  few fields matching `ticker`
* a `--diagnose` mode that tries every variant and reports exactly what each
  one returned, so the working URL can be identified in one command
* a hard staleness ceiling on the cache, so silent ageing cannot recur

Honest caveat
-------------
The environment this was written in cannot reach ishares.com, so the network
paths below are NOT verified against the live endpoint. That is precisely why
`--diagnose` exists and why every strategy is tried in turn rather than one
being assumed correct. Run `--diagnose` first; it will say which variant works.

Usage
-----
    python pipeline/ishares_loader.py --diagnose
    python pipeline/ishares_loader.py --diagnose --etf IWV
    python pipeline/ishares_loader.py --fetch IWB          # print ticker count
"""

from __future__ import annotations

import argparse
import io
import sys
import time
import urllib.error
import urllib.request
from typing import Iterable

import pandas as pd

# ticker -> (productId, slug, fileName)
ISHARES_HOLDINGS = {
    "IWB": ("239707", "ishares-russell-1000-etf", "IWB_holdings"),
    "IWM": ("239710", "ishares-russell-2000-etf", "IWM_holdings"),
    "IWV": ("239714", "ishares-russell-3000-etf", "IWV_holdings"),
    "IJH": ("239763", "ishares-core-sp-midcap-etf", "IJH_holdings"),
    "IJR": ("239774", "ishares-core-sp-smallcap-etf", "IJR_holdings"),
    "IVV": ("239726", "ishares-core-sp-500-etf", "IVV_holdings"),
}

BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/120.0.0.0 Safari/537.36",
    # Ask for a file, not a document. The old code sent an HTML Accept header,
    # which is a reasonable thing for a CDN to answer with HTML.
    "Accept": "text/csv,application/csv,application/octet-stream,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Connection": "close",
}


def _product_page(pid: str, slug: str) -> str:
    return f"https://www.ishares.com/us/products/{pid}/{slug}"


def candidate_urls(etf: str) -> list[tuple[str, str, dict]]:
    """(label, url, extra_headers) for every variant worth trying."""
    pid, slug, fname = ISHARES_HOLDINGS[etf]
    ref = {"Referer": _product_page(pid, slug)}
    base = f"https://www.ishares.com/us/products/{pid}/{slug}"
    blk = f"https://www.blackrock.com/us/individual/products/{pid}/fund"
    q = f"fileType=csv&fileName={fname}&dataType=fund"
    return [
        ("ishares + referer",     f"{base}/1467271812596.ajax?{q}", ref),
        ("ishares, no referer",   f"{base}/1467271812596.ajax?{q}", {}),
        ("ishares alt component", f"{base}/1521942788811.ajax?{q}", ref),
        ("blackrock host",        f"{blk}/1467271812596.ajax?{q}", ref),
        ("blackrock alt",         f"{blk}/1521942788811.ajax?{q}", ref),
    ]


def _get(url: str, extra: dict, timeout: int = 45) -> tuple[int, str, bytes]:
    req = urllib.request.Request(url, headers={**BROWSER_HEADERS, **extra})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.headers.get("Content-Type", ""), r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("Content-Type", "") if e.headers else "", b""
    except Exception as e:                                 # noqa: BLE001
        return -1, type(e).__name__, str(e).encode()[:400]


def looks_like_html(raw: bytes) -> bool:
    head = raw[:2048].lstrip().lower()
    return head.startswith(b"<!doctype") or head.startswith(b"<html") or \
        b"<head" in head[:512]


def find_header_row(lines: list[str]) -> int | None:
    """Index of the CSV header row, tolerating BOM, quoting and whitespace.

    iShares prefixes the file with ~9 metadata lines. The old check demanded
    the line start with exactly `Ticker,`; this one normalises the first few
    fields and compares, so a BOM or a renamed neighbour column no longer
    reads as "endpoint broken".
    """
    for i, line in enumerate(lines[:60]):
        fields = [f.strip().strip('"').strip("﻿").lower()
                  for f in line.split(",")[:4]]
        if any(f in ("ticker", "ticker symbol", "issuer ticker") for f in fields):
            return i
    return None


def parse_csv(raw: bytes) -> pd.DataFrame:
    text = raw.decode("utf-8-sig", errors="replace")
    lines = text.splitlines()
    idx = find_header_row(lines)
    if idx is None:
        raise ValueError("no Ticker header row in the response")
    df = pd.read_csv(io.StringIO("\n".join(lines[idx:])))
    df.columns = [str(c).strip() for c in df.columns]
    return df


def fetch_holdings(etf: str, *, verbose: bool = False) -> pd.DataFrame:
    """Try each variant until one returns parseable CSV.

    Raises with a message naming what every variant actually returned, so the
    failure is diagnosable from the log alone rather than needing a repro.
    """
    if etf not in ISHARES_HOLDINGS:
        raise KeyError(f"unknown ETF {etf!r}")
    problems = []
    for label, url, extra in candidate_urls(etf):
        status, ctype, raw = _get(url, extra)
        if status != 200 or not raw:
            problems.append(f"{label}: HTTP {status} ({ctype})")
            continue
        if looks_like_html(raw):
            problems.append(f"{label}: HTML instead of CSV ({len(raw):,} bytes)")
            continue
        try:
            df = parse_csv(raw)
        except Exception as e:                             # noqa: BLE001
            problems.append(f"{label}: {type(e).__name__}: {e}")
            continue
        if verbose:
            print(f"  [ok] {etf} via {label}: {len(df):,} rows", file=sys.stderr)
        return df
    raise RuntimeError(
        f"all {len(problems)} iShares endpoint variants failed for {etf}:\n  "
        + "\n  ".join(problems))


def extract_tickers(df: pd.DataFrame) -> list[str]:
    """Equity tickers only, normalised to the DB's dash convention."""
    col = next((c for c in df.columns if c.strip().lower().startswith("ticker")),
               None)
    if col is None:
        raise ValueError(f"no ticker column in {list(df.columns)[:8]}")
    if "Asset Class" in df.columns:
        df = df[df["Asset Class"].astype(str).str.contains(
            "equity", case=False, na=False)]
    s = df[col].astype(str).str.strip()
    s = s[s.str.match(r"^[A-Z][A-Z0-9.\-]{0,5}$", na=False)]
    s = s[~s.isin(["USD", "CASH", "MARGIN", "-"])]
    return sorted(set(s.str.replace(".", "-", regex=False)))


# ──────────────────────────────────────────────────────────────────────────────
# Drop-in replacements for contrarian_screener.py
# ──────────────────────────────────────────────────────────────────────────────

def _fetch_ishares_csv(etf: str) -> pd.DataFrame:
    """Signature-compatible with the original. Import this over it:

        from pipeline.ishares_loader import _fetch_ishares_csv
    """
    return fetch_holdings(etf)


MAX_CACHE_AGE_DAYS = 45


def cached_table_strict(name: str, fetch_fn, cache_dir: str,
                        ttl_days: int = 7,
                        max_age_days: int = MAX_CACHE_AGE_DAYS):
    """`_cached_table` with a ceiling on how stale the fallback may be.

    The original falls back to the cache on any failure, with no upper bound,
    so a source that breaks in May is still being served from cache in August
    behind a single `[warn]` line. Constituent lists do drift slowly, which is
    what justifies a fallback at all — but not indefinitely. Past
    `max_age_days` the failure is raised instead of hidden, because at that
    point the screener is ranking a universe that no longer exists.
    """
    import os
    os.makedirs(cache_dir, exist_ok=True)
    path = os.path.join(cache_dir, f"{name}.csv")
    if os.path.exists(path):
        age = time.time() - os.path.getmtime(path)
        if age < ttl_days * 86400:
            return pd.read_csv(path)
    try:
        df = fetch_fn()
        df.to_csv(path, index=False)
        return df
    except Exception as e:                                 # noqa: BLE001
        if not os.path.exists(path):
            raise
        age_days = (time.time() - os.path.getmtime(path)) / 86400
        if age_days > max_age_days:
            raise RuntimeError(
                f"'{name}' refresh failed ({type(e).__name__}: {e}) and the "
                f"cache is {age_days:.0f} days old, past the {max_age_days}-day "
                f"ceiling. Refusing to serve it — the universe would be "
                f"materially wrong. Fix the source, or raise max_age_days "
                f"deliberately."
            ) from e
        print(f"  [warn] refresh of '{name}' failed ({type(e).__name__}: {e}); "
              f"falling back to stale cache ({age_days:.0f}d old, ceiling "
              f"{max_age_days}d)")
        return pd.read_csv(path)


# ──────────────────────────────────────────────────────────────────────────────
# CLI
# ──────────────────────────────────────────────────────────────────────────────

def diagnose(etfs: Iterable[str]) -> int:
    worked = 0
    for etf in etfs:
        print(f"\n{etf}  ({ISHARES_HOLDINGS[etf][1]})")
        print("-" * 72)
        hit = False
        for label, url, extra in candidate_urls(etf):
            status, ctype, raw = _get(url, extra)
            note = ""
            if status != 200:
                verdict = f"HTTP {status}"
                note = ctype
            elif not raw:
                verdict = "empty body"
            elif looks_like_html(raw):
                verdict = f"HTML ({len(raw):,} B)"
                note = "endpoint served the web page, not the file"
            else:
                try:
                    df = parse_csv(raw)
                    tickers = extract_tickers(df)
                    verdict = f"OK — {len(df):,} rows, {len(tickers):,} tickers"
                    note = "<<< USE THIS ONE"
                    hit = True
                except Exception as e:                     # noqa: BLE001
                    verdict = f"CSV but unparseable: {type(e).__name__}"
                    note = str(e)[:60]
            print(f"  {label:<24} {verdict:<34} {note}")
            time.sleep(1.0)
        worked += 1 if hit else 0
    print(f"\n{worked}/{len(list(etfs))} ETFs have at least one working variant.")
    if not worked:
        print("\nNone worked. Most likely a bot block rather than a URL change —\n"
              "the same request from a browser usually succeeds. Options:\n"
              "  * download the CSV manually and drop it in .screener_cache/\n"
              "  * switch the Russell universes to a different provider\n"
              "  * scrape the holdings from the product page HTML instead")
    return 0 if worked else 1


def main(argv=None) -> int:
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--diagnose", action="store_true",
                   help="try every endpoint variant and report what each returns")
    p.add_argument("--fetch", metavar="ETF",
                   help="fetch one ETF and print the ticker count")
    p.add_argument("--etf", action="append", default=[],
                   help="limit --diagnose to these ETFs (repeatable)")
    args = p.parse_args(argv)

    etfs = [e.upper() for e in args.etf] or ["IWB", "IWM", "IWV"]
    if args.fetch:
        df = fetch_holdings(args.fetch.upper(), verbose=True)
        t = extract_tickers(df)
        print(f"{args.fetch.upper()}: {len(t):,} tickers")
        print("  " + ", ".join(t[:15]) + " ...")
        return 0
    if args.diagnose:
        return diagnose(etfs)
    p.error("pass --diagnose or --fetch ETF")


if __name__ == "__main__":
    sys.exit(main())
